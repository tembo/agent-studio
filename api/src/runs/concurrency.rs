use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::{bail, Context};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const DEFAULT_MAX_CONCURRENT_RUNS: usize = 10;
const DEFAULT_MAX_CONCURRENT_SUB_AGENTS_PER_ORCHESTRATOR: usize = 3;

/// Process-local admission control for agent runs.
///
/// Top-level runs acquire from both pools. Sub-agent runs only acquire from the
/// global pool, leaving `reserved_sub_agent_runs` slots available when an
/// orchestrator stays alive while it waits for a sub-agent. Each orchestrator
/// is also limited to `max_sub_agents_per_orchestrator` concurrent children so
/// one fan-out cannot occupy the whole queue.
#[derive(Clone)]
pub struct RunConcurrency {
    total: Arc<Semaphore>,
    top_level: Arc<Semaphore>,
    per_orchestrator: Arc<Mutex<HashMap<Uuid, Arc<Semaphore>>>>,
    max_concurrent_runs: usize,
    reserved_sub_agent_runs: usize,
    max_sub_agents_per_orchestrator: usize,
}

pub struct RunPermit {
    _total: OwnedSemaphorePermit,
    _top_level: Option<OwnedSemaphorePermit>,
    _per_orchestrator: Option<OwnedSemaphorePermit>,
}

impl RunConcurrency {
    pub fn from_env() -> anyhow::Result<Self> {
        let max =
            parse_env_usize("API_MAX_CONCURRENT_RUNS")?.unwrap_or(DEFAULT_MAX_CONCURRENT_RUNS);
        // Balance the default lanes so concurrent orchestrators can each make
        // progress. Reserving only one slot made every sub-agent serialize
        // during bursts where top-level orchestrators occupied the other
        // permits. A one-slot deployment still cannot reserve its only slot.
        let default_reserved = default_reserved_sub_agent_runs(max);
        let reserved = parse_env_usize("API_RESERVED_SUB_AGENT_RUNS")?.unwrap_or(default_reserved);
        let default_per_orchestrator =
            DEFAULT_MAX_CONCURRENT_SUB_AGENTS_PER_ORCHESTRATOR.min(max.max(1));
        let per_orchestrator = parse_env_usize("API_MAX_CONCURRENT_SUB_AGENTS_PER_ORCHESTRATOR")?
            .unwrap_or(default_per_orchestrator);
        Self::new(max, reserved, per_orchestrator)
    }

    pub fn new(
        max_concurrent_runs: usize,
        reserved_sub_agent_runs: usize,
        max_sub_agents_per_orchestrator: usize,
    ) -> anyhow::Result<Self> {
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

        Ok(Self {
            total: Arc::new(Semaphore::new(max_concurrent_runs)),
            top_level: Arc::new(Semaphore::new(
                max_concurrent_runs - reserved_sub_agent_runs,
            )),
            per_orchestrator: Arc::new(Mutex::new(HashMap::new())),
            max_concurrent_runs,
            reserved_sub_agent_runs,
            max_sub_agents_per_orchestrator,
        })
    }

    /// Wait for execution capacity, returning `None` when the run is cancelled
    /// while still queued. The returned permits release automatically.
    pub async fn acquire(
        &self,
        orchestrator_run_id: Option<Uuid>,
        cancel: &CancellationToken,
    ) -> Option<RunPermit> {
        let per_orchestrator = if let Some(orchestrator_run_id) = orchestrator_run_id {
            // Take the per-parent slot first so a fourth child waits here
            // instead of occupying a global slot.
            Some(acquire_or_cancel(self.orchestrator_semaphore(orchestrator_run_id), cancel).await?)
        } else {
            None
        };
        let top_level = if orchestrator_run_id.is_some() {
            None
        } else {
            Some(acquire_or_cancel(self.top_level.clone(), cancel).await?)
        };
        let total = acquire_or_cancel(self.total.clone(), cancel).await?;
        Some(RunPermit {
            _total: total,
            _top_level: top_level,
            _per_orchestrator: per_orchestrator,
        })
    }

    pub fn max_concurrent_runs(&self) -> usize {
        self.max_concurrent_runs
    }

    pub fn reserved_sub_agent_runs(&self) -> usize {
        self.reserved_sub_agent_runs
    }

    pub fn max_sub_agents_per_orchestrator(&self) -> usize {
        self.max_sub_agents_per_orchestrator
    }

    pub fn active_runs(&self) -> usize {
        self.max_concurrent_runs - self.total.available_permits()
    }

    /// Wake queued acquirers during shutdown without disturbing permits held by
    /// runs that are already executing. Their database rows remain queued and
    /// the boot reconciler will resubmit them on the next process.
    pub fn close(&self) {
        self.top_level.close();
        self.total.close();
        let gates = self
            .per_orchestrator
            .lock()
            .expect("per_orchestrator mutex poisoned");
        for semaphore in gates.values() {
            semaphore.close();
        }
    }

    fn orchestrator_semaphore(&self, orchestrator_run_id: Uuid) -> Arc<Semaphore> {
        let mut gates = self
            .per_orchestrator
            .lock()
            .expect("per_orchestrator mutex poisoned");
        gates
            .entry(orchestrator_run_id)
            .or_insert_with(|| Arc::new(Semaphore::new(self.max_sub_agents_per_orchestrator)))
            .clone()
    }
}

async fn acquire_or_cancel(
    semaphore: Arc<Semaphore>,
    cancel: &CancellationToken,
) -> Option<OwnedSemaphorePermit> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => None,
        permit = semaphore.acquire_owned() => permit.ok(),
    }
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

        // A third top-level run queues instead of consuming capacity that the
        // two active orchestrators need for their sub-agents.
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
}
