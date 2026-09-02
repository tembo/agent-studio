use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use anyhow::{bail, Context};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const DEFAULT_MAX_CONCURRENT_RUNS: usize = 10;
const DEFAULT_MAX_CONCURRENT_SUB_AGENTS_PER_ORCHESTRATOR: usize = 3;

/// Process-local admission control for agent runs.
///
/// Top-level runs leave `reserved_sub_agent_runs` slots free so an orchestrator
/// waiting on a child cannot fill the pool. Sub-agent waiters are granted
/// before queued orchestrators when a slot opens. Each orchestrator is also
/// limited to `max_sub_agents_per_orchestrator` concurrent children.
#[derive(Clone)]
pub struct RunConcurrency {
    inner: Arc<Mutex<State>>,
}

struct State {
    max_concurrent_runs: usize,
    reserved_sub_agent_runs: usize,
    max_sub_agents_per_orchestrator: usize,
    active: usize,
    active_top: usize,
    per_orch: HashMap<Uuid, usize>,
    sub_waiters: VecDeque<Waiter>,
    top_waiters: VecDeque<Waiter>,
    closed: bool,
}

struct Waiter {
    orchestrator_run_id: Option<Uuid>,
    tx: oneshot::Sender<RunPermit>,
}

pub struct RunPermit {
    gate: Option<RunConcurrency>,
    orchestrator_run_id: Option<Uuid>,
}

impl RunPermit {
    fn disarm(&mut self) {
        self.gate = None;
    }
}

impl Drop for RunPermit {
    fn drop(&mut self) {
        if let Some(gate) = self.gate.take() {
            gate.release(self.orchestrator_run_id);
        }
    }
}

impl RunConcurrency {
    pub fn from_env() -> anyhow::Result<Self> {
        let limits = limits_from_env()?;
        Self::new(
            limits.max_concurrent_runs,
            limits.reserved_sub_agent_runs,
            limits.max_sub_agents_per_orchestrator,
        )
    }

    pub async fn from_db(pool: &sqlx::PgPool) -> anyhow::Result<Self> {
        let limits = load_limits(pool).await?;
        Self::new(
            limits.max_concurrent_runs,
            limits.reserved_sub_agent_runs,
            limits.max_sub_agents_per_orchestrator,
        )
    }

    pub fn new(
        max_concurrent_runs: usize,
        reserved_sub_agent_runs: usize,
        max_sub_agents_per_orchestrator: usize,
    ) -> anyhow::Result<Self> {
        validate_limits(
            max_concurrent_runs,
            reserved_sub_agent_runs,
            max_sub_agents_per_orchestrator,
        )?;
        Ok(Self {
            inner: Arc::new(Mutex::new(State {
                max_concurrent_runs,
                reserved_sub_agent_runs,
                max_sub_agents_per_orchestrator,
                active: 0,
                active_top: 0,
                per_orch: HashMap::new(),
                sub_waiters: VecDeque::new(),
                top_waiters: VecDeque::new(),
                closed: false,
            })),
        })
    }

    /// Replace live limits. Running work is left alone; the next grants use
    /// the new caps. Returns whether anything changed.
    pub fn set_limits(
        &self,
        max_concurrent_runs: usize,
        reserved_sub_agent_runs: usize,
        max_sub_agents_per_orchestrator: usize,
    ) -> anyhow::Result<bool> {
        validate_limits(
            max_concurrent_runs,
            reserved_sub_agent_runs,
            max_sub_agents_per_orchestrator,
        )?;
        let mut st = self.lock();
        let changed = st.max_concurrent_runs != max_concurrent_runs
            || st.reserved_sub_agent_runs != reserved_sub_agent_runs
            || st.max_sub_agents_per_orchestrator != max_sub_agents_per_orchestrator;
        if !changed {
            return Ok(false);
        }
        st.max_concurrent_runs = max_concurrent_runs;
        st.reserved_sub_agent_runs = reserved_sub_agent_runs;
        st.max_sub_agents_per_orchestrator = max_sub_agents_per_orchestrator;
        drop(st);
        self.pump();
        Ok(true)
    }

    /// Wait for execution capacity, returning `None` when the run is cancelled
    /// while still queued. The returned permit releases automatically.
    pub async fn acquire(
        &self,
        orchestrator_run_id: Option<Uuid>,
        cancel: &CancellationToken,
    ) -> Option<RunPermit> {
        let (tx, rx) = oneshot::channel();
        {
            let mut st = self.lock();
            if st.closed {
                return None;
            }
            if st.try_grant(orchestrator_run_id) {
                return Some(RunPermit {
                    gate: Some(self.clone()),
                    orchestrator_run_id,
                });
            }
            let waiter = Waiter {
                orchestrator_run_id,
                tx,
            };
            if orchestrator_run_id.is_some() {
                st.sub_waiters.push_back(waiter);
            } else {
                st.top_waiters.push_back(waiter);
            }
        }

        tokio::select! {
            biased;
            _ = cancel.cancelled() => None,
            result = rx => result.ok(),
        }
    }

    pub fn max_concurrent_runs(&self) -> usize {
        self.lock().max_concurrent_runs
    }

    pub fn reserved_sub_agent_runs(&self) -> usize {
        self.lock().reserved_sub_agent_runs
    }

    pub fn max_sub_agents_per_orchestrator(&self) -> usize {
        self.lock().max_sub_agents_per_orchestrator
    }

    pub fn active_runs(&self) -> usize {
        self.lock().active
    }

    /// Wake queued acquirers during shutdown without disturbing permits held by
    /// runs that are already executing. Their database rows remain queued and
    /// the boot reconciler will resubmit them on the next process.
    pub fn close(&self) {
        let mut st = self.lock();
        st.closed = true;
        st.sub_waiters.clear();
        st.top_waiters.clear();
    }

    fn release(&self, orchestrator_run_id: Option<Uuid>) {
        let mut st = self.lock();
        st.release_slot(orchestrator_run_id);
        drop(st);
        self.pump();
    }

    fn pump(&self) {
        let mut st = self.lock();
        let mut i = 0;
        while i < st.sub_waiters.len() {
            if !st.can_start(st.sub_waiters[i].orchestrator_run_id) {
                i += 1;
                continue;
            }
            let waiter = st.sub_waiters.remove(i).expect("index in range");
            st.take_slot(waiter.orchestrator_run_id);
            let permit = RunPermit {
                gate: Some(self.clone()),
                orchestrator_run_id: waiter.orchestrator_run_id,
            };
            if let Err(mut permit) = waiter.tx.send(permit) {
                permit.disarm();
                st.release_slot(waiter.orchestrator_run_id);
                continue;
            }
        }
        while st.can_start(None) {
            let Some(waiter) = st.top_waiters.pop_front() else {
                return;
            };
            st.take_slot(None);
            let permit = RunPermit {
                gate: Some(self.clone()),
                orchestrator_run_id: None,
            };
            if let Err(mut permit) = waiter.tx.send(permit) {
                permit.disarm();
                st.release_slot(None);
                continue;
            }
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.inner.lock().expect("run concurrency mutex poisoned")
    }
}

impl State {
    fn try_grant(&mut self, orchestrator_run_id: Option<Uuid>) -> bool {
        if !self.can_start(orchestrator_run_id) {
            return false;
        }
        self.take_slot(orchestrator_run_id);
        true
    }

    fn can_start(&self, orchestrator_run_id: Option<Uuid>) -> bool {
        if self.closed || self.active >= self.max_concurrent_runs {
            return false;
        }
        match orchestrator_run_id {
            Some(id) => {
                self.per_orch.get(&id).copied().unwrap_or(0) < self.max_sub_agents_per_orchestrator
            }
            None => self.active_top < self.top_level_capacity(),
        }
    }

    fn top_level_capacity(&self) -> usize {
        self.max_concurrent_runs - self.reserved_sub_agent_runs
    }

    fn take_slot(&mut self, orchestrator_run_id: Option<Uuid>) {
        self.active += 1;
        if let Some(id) = orchestrator_run_id {
            *self.per_orch.entry(id).or_insert(0) += 1;
        } else {
            self.active_top += 1;
        }
    }

    fn release_slot(&mut self, orchestrator_run_id: Option<Uuid>) {
        self.active = self.active.saturating_sub(1);
        if let Some(id) = orchestrator_run_id {
            if let Some(n) = self.per_orch.get_mut(&id) {
                *n = n.saturating_sub(1);
                if *n == 0 {
                    self.per_orch.remove(&id);
                }
            }
        } else {
            self.active_top = self.active_top.saturating_sub(1);
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunConcurrencyLimits {
    pub max_concurrent_runs: usize,
    pub reserved_sub_agent_runs: usize,
    pub max_sub_agents_per_orchestrator: usize,
}

pub async fn load_limits(pool: &sqlx::PgPool) -> anyhow::Result<RunConcurrencyLimits> {
    #[derive(sqlx::FromRow)]
    struct Row {
        max_concurrent_runs: Option<i32>,
        max_sub_agents_per_orchestrator: Option<i32>,
    }

    let row = sqlx::query_as::<_, Row>(
        "SELECT max_concurrent_runs, max_sub_agents_per_orchestrator \
         FROM instance_settings WHERE id = TRUE",
    )
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();

    let (db_max, db_per) = match row {
        Some(r) => (
            positive_usize(r.max_concurrent_runs),
            positive_usize(r.max_sub_agents_per_orchestrator),
        ),
        None => (None, None),
    };

    let max = db_max
        .or(parse_env_usize("API_MAX_CONCURRENT_RUNS")?)
        .unwrap_or(DEFAULT_MAX_CONCURRENT_RUNS);
    let default_per = DEFAULT_MAX_CONCURRENT_SUB_AGENTS_PER_ORCHESTRATOR.min(max.max(1));
    let per = db_per
        .or(parse_env_usize(
            "API_MAX_CONCURRENT_SUB_AGENTS_PER_ORCHESTRATOR",
        )?)
        .unwrap_or(default_per);
    let reserved = parse_env_usize("API_RESERVED_SUB_AGENT_RUNS")?
        .unwrap_or(default_reserved_sub_agent_runs(max));
    validate_limits(max, reserved, per)?;
    Ok(RunConcurrencyLimits {
        max_concurrent_runs: max,
        reserved_sub_agent_runs: reserved,
        max_sub_agents_per_orchestrator: per,
    })
}

fn limits_from_env() -> anyhow::Result<RunConcurrencyLimits> {
    let max = parse_env_usize("API_MAX_CONCURRENT_RUNS")?.unwrap_or(DEFAULT_MAX_CONCURRENT_RUNS);
    let default_per = DEFAULT_MAX_CONCURRENT_SUB_AGENTS_PER_ORCHESTRATOR.min(max.max(1));
    let per =
        parse_env_usize("API_MAX_CONCURRENT_SUB_AGENTS_PER_ORCHESTRATOR")?.unwrap_or(default_per);
    let reserved = parse_env_usize("API_RESERVED_SUB_AGENT_RUNS")?
        .unwrap_or(default_reserved_sub_agent_runs(max));
    validate_limits(max, reserved, per)?;
    Ok(RunConcurrencyLimits {
        max_concurrent_runs: max,
        reserved_sub_agent_runs: reserved,
        max_sub_agents_per_orchestrator: per,
    })
}

fn validate_limits(
    max_concurrent_runs: usize,
    reserved_sub_agent_runs: usize,
    max_sub_agents_per_orchestrator: usize,
) -> anyhow::Result<()> {
    if max_concurrent_runs == 0 {
        bail!("API_MAX_CONCURRENT_RUNS must be at least 1");
    }
    if reserved_sub_agent_runs >= max_concurrent_runs {
        bail!(
            "API_RESERVED_SUB_AGENT_RUNS ({reserved_sub_agent_runs}) must be less than \
             API_MAX_CONCURRENT_RUNS ({max_concurrent_runs})"
        );
    }
    if max_sub_agents_per_orchestrator == 0 {
        bail!("API_MAX_CONCURRENT_SUB_AGENTS_PER_ORCHESTRATOR must be at least 1");
    }
    Ok(())
}

fn positive_usize(value: Option<i32>) -> Option<usize> {
    value.filter(|&n| n > 0).map(|n| n as usize)
}

fn parse_env_usize(name: &str) -> anyhow::Result<Option<usize>> {
    let Some(raw) = std::env::var_os(name) else {
        return Ok(None);
    };
    let raw = raw
        .into_string()
        .map_err(|_| anyhow::anyhow!("{name} must be valid UTF-8"))?;
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let value = raw
        .parse::<usize>()
        .with_context(|| format!("{name} must be a non-negative integer"))?;
    Ok(Some(value))
}

fn default_reserved_sub_agent_runs(max_concurrent_runs: usize) -> usize {
    max_concurrent_runs / 2
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn rejects_invalid_limits() {
        assert!(RunConcurrency::new(0, 0, 1).is_err());
        assert!(RunConcurrency::new(4, 4, 1).is_err());
        assert!(RunConcurrency::new(4, 5, 1).is_err());
        assert!(RunConcurrency::new(4, 1, 0).is_err());
    }

    #[test]
    fn defaults_to_balanced_top_level_and_sub_agent_capacity() {
        assert_eq!(default_reserved_sub_agent_runs(1), 0);
        assert_eq!(default_reserved_sub_agent_runs(2), 1);
        assert_eq!(default_reserved_sub_agent_runs(4), 2);
        assert_eq!(default_reserved_sub_agent_runs(6), 3);
        assert_eq!(default_reserved_sub_agent_runs(10), 5);
    }

    #[tokio::test]
    async fn reserves_capacity_for_sub_agent_runs() {
        let gate = RunConcurrency::new(4, 1, 3).unwrap();
        let cancel = CancellationToken::new();

        let top_level_runs = [
            gate.acquire(None, &cancel).await.unwrap(),
            gate.acquire(None, &cancel).await.unwrap(),
            gate.acquire(None, &cancel).await.unwrap(),
        ];
        assert_eq!(gate.active_runs(), 3);

        assert!(
            tokio::time::timeout(Duration::from_millis(20), gate.acquire(None, &cancel),)
                .await
                .is_err()
        );

        let sub_agent = gate.acquire(Some(Uuid::new_v4()), &cancel).await.unwrap();
        assert_eq!(gate.active_runs(), 4);
        assert!(tokio::time::timeout(
            Duration::from_millis(20),
            gate.acquire(Some(Uuid::new_v4()), &cancel),
        )
        .await
        .is_err());

        drop(sub_agent);
        drop(top_level_runs);
        assert_eq!(gate.active_runs(), 0);
    }

    #[tokio::test]
    async fn balanced_reservation_keeps_two_orchestrators_moving() {
        let gate = RunConcurrency::new(4, 2, 3).unwrap();
        let cancel = CancellationToken::new();

        let orchestrators = [
            gate.acquire(None, &cancel).await.unwrap(),
            gate.acquire(None, &cancel).await.unwrap(),
        ];
        assert_eq!(gate.active_runs(), 2);

        assert!(
            tokio::time::timeout(Duration::from_millis(20), gate.acquire(None, &cancel),)
                .await
                .is_err()
        );

        let sub_agents = [
            gate.acquire(Some(Uuid::new_v4()), &cancel).await.unwrap(),
            gate.acquire(Some(Uuid::new_v4()), &cancel).await.unwrap(),
        ];
        assert_eq!(gate.active_runs(), 4);

        drop(sub_agents);
        drop(orchestrators);
        assert_eq!(gate.active_runs(), 0);
    }

    #[tokio::test]
    async fn caps_concurrent_sub_agents_per_orchestrator() {
        let gate = RunConcurrency::new(10, 5, 3).unwrap();
        let cancel = CancellationToken::new();
        let orchestrator = Uuid::new_v4();
        let other = Uuid::new_v4();

        let sub_agents = [
            gate.acquire(Some(orchestrator), &cancel).await.unwrap(),
            gate.acquire(Some(orchestrator), &cancel).await.unwrap(),
            gate.acquire(Some(orchestrator), &cancel).await.unwrap(),
        ];
        assert_eq!(gate.active_runs(), 3);

        assert!(tokio::time::timeout(
            Duration::from_millis(20),
            gate.acquire(Some(orchestrator), &cancel),
        )
        .await
        .is_err());
        assert_eq!(gate.active_runs(), 3);

        let other_sub = gate.acquire(Some(other), &cancel).await.unwrap();
        assert_eq!(gate.active_runs(), 4);

        drop(sub_agents);
        drop(other_sub);
        assert_eq!(gate.active_runs(), 0);
    }

    #[tokio::test]
    async fn queued_sub_agents_start_before_new_orchestrators() {
        let gate = RunConcurrency::new(1, 0, 1).unwrap();
        let cancel = CancellationToken::new();
        let running = gate.acquire(None, &cancel).await.unwrap();

        let top_waiter = {
            let gate = gate.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move { gate.acquire(None, &cancel).await })
        };
        tokio::task::yield_now().await;

        let sub_waiter = {
            let gate = gate.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move { gate.acquire(Some(Uuid::new_v4()), &cancel).await })
        };
        tokio::time::sleep(Duration::from_millis(10)).await;

        drop(running);

        let sub = tokio::time::timeout(Duration::from_millis(100), sub_waiter)
            .await
            .expect("sub-agent should be granted first")
            .expect("sub-agent task")
            .expect("sub-agent permit");
        assert_eq!(gate.active_runs(), 1);

        assert!(
            tokio::time::timeout(Duration::from_millis(20), top_waiter)
                .await
                .is_err(),
            "new orchestrator should stay queued behind the sub-agent"
        );
        drop(sub);
    }

    #[tokio::test]
    async fn cancellation_interrupts_a_queued_run() {
        let gate = RunConcurrency::new(1, 0, 1).unwrap();
        let running_cancel = CancellationToken::new();
        let _running = gate.acquire(None, &running_cancel).await.unwrap();

        let queued_cancel = CancellationToken::new();
        let waiter = {
            let gate = gate.clone();
            let queued_cancel = queued_cancel.clone();
            tokio::spawn(async move { gate.acquire(None, &queued_cancel).await })
        };
        tokio::task::yield_now().await;
        queued_cancel.cancel();

        assert!(waiter.await.unwrap().is_none());
        assert_eq!(gate.active_runs(), 1);
    }

    #[tokio::test]
    async fn closing_the_gate_wakes_queued_runs() {
        let gate = RunConcurrency::new(1, 0, 1).unwrap();
        let cancel = CancellationToken::new();
        let _running = gate.acquire(None, &cancel).await.unwrap();

        let waiter = {
            let gate = gate.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move { gate.acquire(None, &cancel).await })
        };
        tokio::task::yield_now().await;
        gate.close();

        assert!(waiter.await.unwrap().is_none());
        assert_eq!(gate.active_runs(), 1);
    }

    #[tokio::test]
    async fn raising_limits_unblocks_queued_work() {
        let gate = RunConcurrency::new(1, 0, 1).unwrap();
        let cancel = CancellationToken::new();
        let _running = gate.acquire(None, &cancel).await.unwrap();

        let waiter = {
            let gate = gate.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move { gate.acquire(None, &cancel).await })
        };
        tokio::task::yield_now().await;

        gate.set_limits(2, 0, 1).unwrap();
        let permit = tokio::time::timeout(Duration::from_millis(100), waiter)
            .await
            .expect("queued run should start after the cap is raised")
            .expect("task")
            .expect("permit");
        assert_eq!(gate.active_runs(), 2);
        drop(permit);
    }
}
