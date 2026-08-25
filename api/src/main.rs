use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Context;
use axum::{middleware, routing::get, routing::post, Router};
use sqlx::postgres::PgPoolOptions;
use tokio_util::sync::CancellationToken;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

mod auth;
mod crypto;
mod native_oauth;
mod native_oauth_allowlist;
mod pricing;
mod routes;
mod runs;
mod slack_mrkdwn;
mod workspace;

/// Cancellation handles for queued or running runs, keyed by run id. Inserted
/// when a run is accepted and removed when it finishes; the cancel endpoint
/// fires the token to stop permit waiting or kill a running subprocess.
/// In-process only (runs are in-memory tasks on this api instance).
pub type RunCancels = Arc<Mutex<HashMap<uuid::Uuid, CancellationToken>>>;

#[derive(Clone)]
pub struct AppState {
    pub db: sqlx::PgPool,
    pub http: reqwest::Client,
    pub encryption_key: Arc<crypto::MasterKey>,
    pub run_cancels: RunCancels,
    pub run_concurrency: runs::concurrency::RunConcurrency,
    /// Set once a shutdown signal (SIGTERM from a deploy/restart) arrives, so the
    /// run endpoint refuses new work while in-flight runs drain. See main()'s
    /// graceful-shutdown path.
    pub draining: Arc<AtomicBool>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,tas_api=debug")),
        )
        .init();

    let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL must be set")?;
    // Default to the IPv6 unspecified address, which is dual-stack on
    // Linux (binds IPv4 too via v4-mapped addrs) — so plain Docker
    // Compose keeps working while IPv6-only private networks (e.g.
    // Railway service-to-service) reach the api with no config.
    let bind_addr: SocketAddr = std::env::var("API_BIND_ADDR")
        .unwrap_or_else(|_| "[::]:8080".to_string())
        .parse()
        .context("API_BIND_ADDR must be a valid socket address")?;

    let db = PgPoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await
        .context("failed to connect to Postgres")?;

    sqlx::migrate!("./migrations")
        .run(&db)
        .await
        .context("failed to apply database migrations")?;

    let encryption_key = Arc::new(crypto::MasterKey::from_env()?);
    let internal_token = auth::InternalToken::from_env()?;
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .context("failed to build reqwest client")?;
    let run_concurrency = runs::concurrency::RunConcurrency::from_env()?;
    tracing::info!(
        max_concurrent_runs = run_concurrency.max_concurrent_runs(),
        reserved_child_runs = run_concurrency.reserved_child_runs(),
        "run concurrency configured"
    );

    let state = AppState {
        db,
        http,
        encryption_key,
        run_cancels: Arc::new(Mutex::new(HashMap::new())),
        run_concurrency,
        draining: Arc::new(AtomicBool::new(false)),
    };

    // The prior process's in-memory task registry is gone. Reconstruct durable
    // Pydantic runs from their launch envelope + last acknowledged history;
    // legacy/Cargo AI rows are finalized with an explicit interruption reason.
    runs::runner::recover_orphaned_runs(&state).await;

    let internal_routes = Router::new()
        .route("/runs", post(runs::handlers::create_run))
        .route("/runs/{id}", get(runs::handlers::get_run))
        .route("/runs/{id}/cancel", post(runs::handlers::cancel_run))
        .layer(middleware::from_fn(auth::require_internal_token))
        .layer(axum::Extension(internal_token));

    // Handles for the graceful-shutdown path, cloned before `state` moves into
    // the router.
    let draining = state.draining.clone();
    let run_cancels = state.run_cancels.clone();
    let run_concurrency = state.run_concurrency.clone();

    let app = Router::new()
        .route("/health", get(routes::health::health))
        .nest("/internal", internal_routes)
        .with_state(state)
        .layer(TraceLayer::new_for_http());
    // No CORS layer: the api serves only /health and bearer-gated /internal
    // routes, all server-to-server (the web container over the internal
    // network) — never browser cross-origin. A permissive layer was needless
    // attack surface (#48); add a scoped one only if a browser ever calls this.

    tracing::info!("tas-api listening on {bind_addr}");
    let listener = tokio::net::TcpListener::bind(bind_addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(draining, run_concurrency))
        .await?;

    // The HTTP server has stopped accepting connections. Runs execute as detached
    // tokio tasks owning a Python subprocess, so wait for the in-flight ones to
    // finish before exiting — a deploy/restart no longer guillotines a run
    // mid-flight (which the boot reconciler would otherwise mark 'failed'). Bounded
    // by API_DRAIN_TIMEOUT_SECS: the platform SIGKILLs after its own grace window
    // regardless, and runs that outlast the window fall back to the reconciler,
    // exactly as before this change.
    drain_runs(&run_cancels, drain_timeout()).await;

    Ok(())
}

/// Seconds to wait for in-flight runs to drain on shutdown. Keep at/under the
/// platform's pre-SIGKILL grace window (raise both together to protect longer
/// runs). Overridable via `API_DRAIN_TIMEOUT_SECS`.
const DEFAULT_DRAIN_TIMEOUT_SECS: u64 = 25;

fn drain_timeout() -> Duration {
    let secs = std::env::var("API_DRAIN_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(DEFAULT_DRAIN_TIMEOUT_SECS);
    Duration::from_secs(secs)
}

/// Resolves when the process is asked to stop — SIGTERM (a deploy/restart) or
/// Ctrl-C locally. Flips `draining` so `create_run` starts refusing new work,
/// then returns, which tells axum to stop accepting connections.
async fn shutdown_signal(
    draining: Arc<AtomicBool>,
    run_concurrency: runs::concurrency::RunConcurrency,
) {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(e) => {
                tracing::error!(?e, "failed to install SIGTERM handler");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
    draining.store(true, Ordering::SeqCst);
    run_concurrency.close();
    tracing::info!("shutdown signal received — refusing new runs, draining in-flight ones");
}

/// Wait for in-flight runs (tracked in `run_cancels`) to finish, up to `timeout`.
/// Runs still executing when the timeout hits are left to the boot reconciler on
/// the next start (same as an unclean stop), so shutdown never blocks forever.
async fn drain_runs(run_cancels: &RunCancels, timeout: Duration) {
    let start = Instant::now();
    loop {
        let remaining = run_cancels.lock().map(|m| m.len()).unwrap_or(0);
        if remaining == 0 {
            tracing::info!("all in-flight runs drained; exiting");
            return;
        }
        if start.elapsed() >= timeout {
            tracing::warn!(
                remaining,
                "drain timeout reached; remaining runs will be reconciled as interrupted on next boot"
            );
            return;
        }
        tracing::info!(
            remaining,
            "waiting for in-flight runs to finish before exit…"
        );
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

#[cfg(test)]
mod migration_tests {
    use std::collections::BTreeMap;

    #[test]
    fn migration_versions_are_unique() {
        let migrations = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
        let mut versions = BTreeMap::<u64, String>::new();

        for entry in std::fs::read_dir(migrations).expect("read migrations directory") {
            let name = entry
                .expect("read migration entry")
                .file_name()
                .to_string_lossy()
                .into_owned();
            if !name.ends_with(".sql") {
                continue;
            }
            let version = name
                .split_once('_')
                .expect("migration filename must start with a numeric version")
                .0
                .parse::<u64>()
                .expect("migration version must be numeric");
            if let Some(existing) = versions.insert(version, name.clone()) {
                panic!("duplicate migration version {version}: {existing} and {name}");
            }
        }
    }
}
