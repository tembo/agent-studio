use std::sync::Arc;

use anyhow::{bail, Context};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

const DEFAULT_MAX_CONCURRENT_RUNS: usize = 4;

/// Process-local admission control for agent runs.
///
/// Top-level runs acquire from both pools. Sub-agent runs only acquire from the
/// global pool, leaving `reserved_sub_agent_runs` slots available when an
/// orchestrator stays alive while it waits for a sub-agent.
#[derive(Clone)]
pub struct RunConcurrency {
    total: Arc<Semaphore>,
    top_level: Arc<Semaphore>,
    max_concurrent_runs: usize,
    reserved_sub_agent_runs: usize,
}

pub struct RunPermit {
    _total: OwnedSemaphorePermit,
    _top_level: Option<OwnedSemaphorePermit>,
}

impl RunConcurrency {
    pub fn from_env() -> anyhow::Result<Self> {
        let max =
            parse_env_usize("API_MAX_CONCURRENT_RUNS")?.unwrap_or(DEFAULT_MAX_CONCURRENT_RUNS);
        // A one-slot deployment cannot reserve its only slot. For every larger
        // deployment, reserve one sub-agent slot unless the operator opts out.
        let default_reserved = usize::from(max > 1);
        let reserved = parse_env_usize("API_RESERVED_SUB_AGENT_RUNS")?.unwrap_or(default_reserved);
        Self::new(max, reserved)
    }

    pub fn new(max_concurrent_runs: usize, reserved_sub_agent_runs: usize) -> anyhow::Result<Self> {
        if max_concurrent_runs == 0 {
            bail!("API_MAX_CONCURRENT_RUNS must be at least 1");
        }
        if reserved_sub_agent_runs >= max_concurrent_runs {
            bail!(
                "API_RESERVED_SUB_AGENT_RUNS ({reserved_sub_agent_runs}) must be less than \
                 API_MAX_CONCURRENT_RUNS ({max_concurrent_runs})"
            );
        }

        Ok(Self {
            total: Arc::new(Semaphore::new(max_concurrent_runs)),
            top_level: Arc::new(Semaphore::new(
                max_concurrent_runs - reserved_sub_agent_runs,
            )),
            max_concurrent_runs,
            reserved_sub_agent_runs,
        })
    }

    /// Wait for execution capacity, returning `None` when the run is cancelled
    /// while still queued. The returned permits release automatically.
    pub async fn acquire(
        &self,
        is_sub_agent: bool,
        cancel: &CancellationToken,
    ) -> Option<RunPermit> {
        let top_level = if is_sub_agent {
            None
        } else {
            Some(acquire_or_cancel(self.top_level.clone(), cancel).await?)
        };
        let total = acquire_or_cancel(self.total.clone(), cancel).await?;
        Some(RunPermit {
            _total: total,
            _top_level: top_level,
        })
    }

    pub fn max_concurrent_runs(&self) -> usize {
        self.max_concurrent_runs
    }

    pub fn reserved_sub_agent_runs(&self) -> usize {
        self.reserved_sub_agent_runs
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
    let value = raw
        .parse::<usize>()
        .with_context(|| format!("{name} must be a non-negative integer"))?;
    Ok(Some(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn rejects_invalid_limits() {
        assert!(RunConcurrency::new(0, 0).is_err());
        assert!(RunConcurrency::new(4, 4).is_err());
        assert!(RunConcurrency::new(4, 5).is_err());
    }

    #[tokio::test]
    async fn reserves_capacity_for_sub_agent_runs() {
        let gate = RunConcurrency::new(4, 1).unwrap();
        let cancel = CancellationToken::new();

        let top_level_runs = [
            gate.acquire(false, &cancel).await.unwrap(),
            gate.acquire(false, &cancel).await.unwrap(),
            gate.acquire(false, &cancel).await.unwrap(),
        ];
        assert_eq!(gate.active_runs(), 3);

        assert!(
            tokio::time::timeout(Duration::from_millis(20), gate.acquire(false, &cancel),)
                .await
                .is_err()
        );

        let sub_agent = gate.acquire(true, &cancel).await.unwrap();
        assert_eq!(gate.active_runs(), 4);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), gate.acquire(true, &cancel),)
                .await
                .is_err()
        );

        drop(sub_agent);
        drop(top_level_runs);
        assert_eq!(gate.active_runs(), 0);
    }

    #[tokio::test]
    async fn cancellation_interrupts_a_queued_run() {
        let gate = RunConcurrency::new(1, 0).unwrap();
        let running_cancel = CancellationToken::new();
        let _running = gate.acquire(false, &running_cancel).await.unwrap();

        let queued_cancel = CancellationToken::new();
        let waiter = {
            let gate = gate.clone();
            let queued_cancel = queued_cancel.clone();
            tokio::spawn(async move { gate.acquire(false, &queued_cancel).await })
        };
        tokio::task::yield_now().await;
        queued_cancel.cancel();

        assert!(waiter.await.unwrap().is_none());
        assert_eq!(gate.active_runs(), 1);
    }

    #[tokio::test]
    async fn closing_the_gate_wakes_queued_runs() {
        let gate = RunConcurrency::new(1, 0).unwrap();
        let cancel = CancellationToken::new();
        let _running = gate.acquire(false, &cancel).await.unwrap();

        let waiter = {
            let gate = gate.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move { gate.acquire(false, &cancel).await })
        };
        tokio::task::yield_now().await;
        gate.close();

        assert!(waiter.await.unwrap().is_none());
        assert_eq!(gate.active_runs(), 1);
    }
}
