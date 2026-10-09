//! HTTP surface for the runs subsystem. Two endpoints:
//!
//!   POST /internal/runs      — web triggers a run, returns run id
//!   GET  /internal/runs/:id?workspace_id=... — web polls for status + output
//!
//! Both gated by the bearer middleware in `crate::auth`.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::runs::delivery::DeliveryDeclaration;
use crate::runs::runner;
use crate::AppState;

#[derive(sqlx::FromRow)]
struct OrchestratorMeta {
    run_environment: String,
    is_dry_run: bool,
}

#[derive(Debug, Deserialize)]
pub struct CreateRunRequest {
    pub workspace_id: Uuid,
    pub user_id: String,
    pub agent_name: String,
    pub agent_path: String,
    /// `provider:model` (e.g. `openai:gpt-4o-mini`). Used by cargo-ai
    /// to set CLI flags; for Pydantic it's saved to the run row for
    /// the UI but the actual provider/model dispatch happens inside
    /// pydantic-ai based on the spec.
    pub model: String,
    /// Optional user message; v0.1 leaves it empty (US-0.1-06 ran for "empty input").
    #[serde(default)]
    pub user_message: Option<String>,
    /// Agent framework. Both supported frameworks ("pydantic-agentspec"
    /// and "cargo-ai") run as passthrough subprocess calls into the
    /// upstream tool. Defaults to "pydantic-agentspec" when omitted to
    /// keep older callers working.
    #[serde(default)]
    pub framework: Option<String>,
    /// Raw agent file content as it sits in the repo. Required for
    /// both frameworks now.
    #[serde(default)]
    pub spec_content: Option<String>,
    /// Spec format — `"yaml"` or `"json"`. Defaults to "json" so
    /// existing cargo-ai callers (which always send JSON) don't need
    /// to change.
    #[serde(default)]
    pub spec_format: Option<String>,
    /// Optional sidecar Python module (the Pydantic agent's
    /// `tools_module:`) whose functions the wrapper exposes to the
    /// model as tools. The web layer reads it from the repo at dispatch
    /// time; persisted with spec_content so an interrupted run can recover.
    #[serde(default)]
    pub tools_module_content: Option<String>,
    /// Files of the Agent Skills the agent opts into, as
    /// `{ repoPath: content }`. The web layer reads them from the repo at
    /// dispatch; the wrapper materializes them and mounts pydantic-ai-skills.
    /// Persisted with the launch envelope for recovery.
    #[serde(default)]
    pub skills_content: Option<std::collections::HashMap<String, String>>,
    /// Where the run came from. Defaults to "manual" so existing
    /// callers (Run-now button, chat) don't need to change. The
    /// scheduler passes "schedule" + automation_id when firing on
    /// a cron.
    #[serde(default)]
    pub trigger: Option<String>,
    #[serde(default)]
    pub automation_id: Option<Uuid>,
    /// Which agent version produced spec_content. Recorded on the run row
    /// for provenance. NULL = a draft/live run or a pre-feature caller.
    #[serde(default)]
    pub agent_version_id: Option<Uuid>,
    /// Human label for the version ("v3" | "draft"), shown in the runs UI.
    #[serde(default)]
    pub agent_version_label: Option<String>,
    /// The orchestrator run that triggered this sub-agent run through the
    /// tembo-agent-studio MCP `trigger_run` tool. Lets the orchestrator's page
    /// roll up sub-run costs.
    #[serde(default)]
    pub orchestrator_run_id: Option<Uuid>,
    /// Agent-authored delivery intent from the exact spec used for this run.
    /// Stored as an immutable snapshot so later spec edits do not rewrite history.
    #[serde(default)]
    pub output_delivery: Option<DeliveryDeclaration>,
    /// Manual dry-run: gather and answer, but stub declared delivery tools.
    #[serde(default)]
    pub is_dry_run: Option<bool>,
    #[serde(default)]
    pub output_reuse: Option<super::output_reuse::OutputReuse>,
}

#[derive(Debug, Serialize)]
pub struct CreateRunResponse {
    pub run_id: Uuid,
    pub reused_from_run_id: Option<Uuid>,
}

pub async fn create_run(
    State(state): State<AppState>,
    Json(req): Json<CreateRunRequest>,
) -> Result<Json<CreateRunResponse>, (StatusCode, String)> {
    // Refuse new work once we've started draining for shutdown — the run would be
    // guillotined by the imminent SIGKILL, then reconciled as failed on boot. The
    // web layer surfaces this as a failed dispatch; during a deploy new traffic is
    // routed to the fresh instance anyway.
    if state.draining.load(std::sync::atomic::Ordering::SeqCst) {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "api is shutting down".to_string(),
        ));
    }

    let run_id = Uuid::new_v4();

    let user_message = req.user_message.unwrap_or_default();
    let acting_user_id = req.user_id;
    // Reject unknown trigger values up front so we surface bad
    // callers instead of silently coercing to 'manual'.
    let trigger = match req.trigger.as_deref() {
        None | Some("manual") => "manual",
        Some("schedule") => "schedule",
        Some("event") => "event",
        Some("eval") => "eval",
        Some(other) => {
            return Err((StatusCode::BAD_REQUEST, format!("unknown trigger: {other}")));
        }
    };
    let framework = req
        .framework
        .as_deref()
        .map(parse_framework)
        .unwrap_or(runner::Framework::Pydantic);
    let framework_name = match framework {
        runner::Framework::Pydantic => "pydantic-agentspec",
        runner::Framework::CargoAi => "cargo-ai",
    };
    let spec_format = match req.spec_format.as_deref() {
        Some("yaml") => runner::SpecFormat::Yaml,
        None | Some("json") => runner::SpecFormat::Json,
        Some(other) => {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("unknown spec_format: {other}"),
            ));
        }
    };
    let spec_format_name = match spec_format {
        runner::SpecFormat::Yaml => "yaml",
        runner::SpecFormat::Json => "json",
    };
    let skills_json = req
        .skills_content
        .as_ref()
        .map(|skills| serde_json::json!(skills));
    if let Some(delivery) = &req.output_delivery {
        delivery
            .validate()
            .map_err(|message| (StatusCode::BAD_REQUEST, message))?;
    }
    let output_delivery = req
        .output_delivery
        .as_ref()
        .map(|delivery| serde_json::json!(delivery));
    let lifecycle_environment =
        run_environment_for_version_label(req.agent_version_label.as_deref());
    let mut is_dry_run = req.is_dry_run.unwrap_or(false);
    let run_environment = if let Some(orchestrator_run_id) = req.orchestrator_run_id {
        let parent: OrchestratorMeta = sqlx::query_as(
            "SELECT run_environment, is_dry_run FROM run WHERE id = $1 AND workspace_id = $2 AND created_by = $3",
        )
        .bind(orchestrator_run_id)
        .bind(req.workspace_id)
        .bind(&acting_user_id)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("orchestrator lookup: {e}"),
            )
        })?
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "orchestrator run was not found in this workspace".to_string(),
            )
        })?;
        is_dry_run = is_dry_run || parent.is_dry_run;
        parent.run_environment
    } else {
        lifecycle_environment.to_string()
    };
    if let Some(message) = dry_run_error(framework, is_dry_run, req.output_delivery.as_ref()) {
        return Err((StatusCode::BAD_REQUEST, message));
    }

    if req
        .output_reuse
        .as_ref()
        .is_some_and(|reuse| !reuse.validate())
    {
        return Err((StatusCode::BAD_REQUEST, "invalid output_reuse".into()));
    }
    let reused = if !is_dry_run
        && trigger != "eval"
        && run_environment == "production"
        && lifecycle_environment == "production"
    {
        if let (Some(reuse), Some(version_id)) = (&req.output_reuse, req.agent_version_id) {
            if reuse.max_age_seconds > 0 {
                match super::output_reuse::lookup(
                    &state.db,
                    req.workspace_id,
                    &acting_user_id,
                    &req.agent_name,
                    version_id,
                    reuse,
                )
                .await
                {
                    Ok(output) => output,
                    Err(_) => {
                        tracing::warn!("output reuse lookup failed; executing normally");
                        None
                    }
                }
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };
    let reused_from_run_id = reused.as_ref().map(|source| source.id);

    sqlx::query(
        r#"INSERT INTO run
            (id, workspace_id, agent_name, agent_path, model, status,
             failure_code, failure_summary, failure_recommendation,
             created_by, user_message, trigger, automation_id,
             agent_version_id, agent_version_label, run_environment,
             orchestrator_run_id,
             execution_framework, execution_spec_content,
             execution_spec_format, execution_tools_module_content,
             execution_skills_content, output_delivery, is_dry_run,
             output, reused_from_run_id, output_reuse_key, output_reuse_type,
             started_at, completed_at, tokens_input, tokens_output, cost_usd, delivery_status)
            VALUES ($1, $2, $3, $4, $5, $21, NULL, NULL, NULL,
                    $6, $7, $8, $9, $10, $11, $12, $13,
                    $14, $15, $16, $17, $18, $19, $20,
                    $22, $23, $24, $25,
                    CASE WHEN $23::uuid IS NOT NULL THEN now() END,
                    CASE WHEN $23::uuid IS NOT NULL THEN now() END,
                    CASE WHEN $23::uuid IS NOT NULL THEN 0 END,
                    CASE WHEN $23::uuid IS NOT NULL THEN 0 END,
                    CASE WHEN $23::uuid IS NOT NULL THEN 0 END,
                    CASE WHEN $23::uuid IS NOT NULL AND $19::jsonb IS NOT NULL
                         THEN 'unobserved' ELSE 'undeclared' END)"#,
    )
    .bind(run_id)
    .bind(req.workspace_id)
    .bind(&req.agent_name)
    .bind(&req.agent_path)
    .bind(&req.model)
    .bind(&acting_user_id)
    .bind(&user_message)
    .bind(trigger)
    .bind(req.automation_id)
    .bind(req.agent_version_id)
    .bind(&req.agent_version_label)
    .bind(&run_environment)
    .bind(req.orchestrator_run_id)
    .bind(framework_name)
    .bind(req.spec_content.as_deref())
    .bind(spec_format_name)
    .bind(req.tools_module_content.as_deref())
    .bind(skills_json)
    .bind(output_delivery)
    .bind(is_dry_run)
    .bind(if reused.is_some() {
        "succeeded"
    } else {
        "queued"
    })
    .bind(
        reused
            .as_ref()
            .map(|source| source.output.as_str())
            .unwrap_or(""),
    )
    .bind(reused_from_run_id)
    .bind(req.output_reuse.as_ref().map(|reuse| reuse.key.as_str()))
    .bind(
        req.output_reuse
            .as_ref()
            .map(|reuse| reuse.report_type.as_str()),
    )
    .execute(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("db insert: {e}")))?;

    if reused_from_run_id.is_some() {
        return Ok(Json(CreateRunResponse {
            run_id,
            reused_from_run_id,
        }));
    }

    let task_state = state.clone();
    let model = req.model;
    let workspace_id = req.workspace_id;
    let spec_content = req.spec_content;
    let tools_module_content = req.tools_module_content;
    let skills_content = req.skills_content;

    let cancel = CancellationToken::new();
    state
        .run_cancels
        .lock()
        .expect("run_cancels mutex poisoned")
        .insert(run_id, cancel.clone());

    tokio::spawn(async move {
        runner::execute_run(
            &task_state,
            runner::RunContext {
                run_id,
                workspace_id,
                acting_user_id,
                model,
                user_message,
                framework,
                spec_content,
                spec_format,
                tools_module_content,
                skills_content,
                message_history: None,
                started_at: None,
                orchestrator_run_id: req.orchestrator_run_id,
                is_dry_run,
            },
            cancel,
        )
        .await;
    });

    Ok(Json(CreateRunResponse {
        run_id,
        reused_from_run_id: None,
    }))
}

// Tolerate either of our two canonical framework strings. Anything
// else (typos, future frameworks) falls back to pydantic so a single
// malformed request doesn't take down the runner.
fn parse_framework(s: &str) -> runner::Framework {
    match s {
        "cargo-ai" => runner::Framework::CargoAi,
        _ => runner::Framework::Pydantic,
    }
}

fn run_environment_for_version_label(version_label: Option<&str>) -> &'static str {
    if version_label == Some("draft") {
        "development"
    } else {
        "production"
    }
}

fn dry_run_error(
    framework: runner::Framework,
    is_dry_run: bool,
    delivery: Option<&DeliveryDeclaration>,
) -> Option<String> {
    if !is_dry_run {
        return None;
    }
    if matches!(framework, runner::Framework::CargoAi) {
        return Some("Dry run is not available for Cargo AI agents yet.".into());
    }
    match delivery {
        Some(declaration) if !declaration.destinations.is_empty() => None,
        _ => Some(
            "Dry run requires a delivery: declaration so TAS can tell which tools to block.".into(),
        ),
    }
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct RunRecord {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub agent_name: String,
    pub agent_path: String,
    /// The optional user input the run was started with ("" when none).
    pub user_message: String,
    pub model: String,
    pub status: String,
    pub output: String,
    /// Live partial output while status='running' (NULL once terminal).
    pub streamed_output: Option<String>,
    pub error_message: Option<String>,
    /// Stable category plus safe copy for non-admin failure surfaces.
    pub failure_code: Option<String>,
    pub failure_summary: Option<String>,
    pub failure_recommendation: Option<String>,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub tokens_input: Option<i32>,
    pub tokens_output: Option<i32>,
    pub cost_usd: Option<f64>,
    pub pricing_snapshot: Option<serde_json::Value>,
    /// ScaleDown prompt-compression totals (NULL unless the run compressed).
    pub scaledown_original_tokens: Option<i32>,
    pub scaledown_compressed_tokens: Option<i32>,
    pub trigger: String,
    pub automation_id: Option<Uuid>,
    pub agent_version_id: Option<Uuid>,
    pub agent_version_label: Option<String>,
    pub run_environment: String,
    /// Number of times this run was reconstructed after an API restart.
    pub resume_count: i32,
    pub resumed_at: Option<DateTime<Utc>>,
    pub is_dry_run: bool,
    pub reused_from_run_id: Option<Uuid>,
    pub output_reuse_type: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GetRunQuery {
    pub workspace_id: Uuid,
}

pub async fn get_run(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(query): Query<GetRunQuery>,
) -> Result<Json<RunRecord>, StatusCode> {
    let row: Option<RunRecord> = sqlx::query_as(
        r#"SELECT id, workspace_id, agent_name, agent_path, user_message, model, status,
                  output, streamed_output, error_message, failure_code,
                  failure_summary, failure_recommendation, created_by, created_at,
                  started_at, completed_at, tokens_input, tokens_output,
                  cost_usd::double precision AS cost_usd, pricing_snapshot,
                  scaledown_original_tokens, scaledown_compressed_tokens,
                   trigger, automation_id, agent_version_id, agent_version_label,
                   run_environment, resume_count, resumed_at, is_dry_run, reused_from_run_id, output_reuse_type
             FROM run
             WHERE id = $1 AND workspace_id = $2"#,
    )
    .bind(id)
    .bind(query.workspace_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|error| {
        tracing::error!(run_id = %id, workspace_id = %query.workspace_id, ?error, "failed to read run");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    row.map(Json).ok_or(StatusCode::NOT_FOUND)
}

#[derive(Debug, Serialize)]
pub struct CancelRunResponse {
    /// True if this call transitioned the run to 'cancelled'; false if it was
    /// already terminal (succeeded/failed/cancelled) and nothing changed.
    pub cancelled: bool,
}

/// Kill an in-flight run. Flips the row to 'cancelled' (only while still
/// queued/running and owned by this workspace) and fires the in-memory
/// cancellation token so the runner SIGKILLs the wrapper subprocess. Writing
/// the row first means the runner's `mark_*` status guards refuse to clobber
/// the 'cancelled' state as the killed process unwinds.
pub async fn cancel_run(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(query): Query<GetRunQuery>,
) -> Result<Json<CancelRunResponse>, StatusCode> {
    let res = sqlx::query(
        "UPDATE run SET status = 'cancelled', \
                error_message = COALESCE(error_message, 'Cancelled by user'), \
                completed_at = now(), streamed_output = NULL \
          WHERE id = $1 AND workspace_id = $2 AND status IN ('queued', 'running')",
    )
    .bind(id)
    .bind(query.workspace_id)
    .execute(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Fire the token if this run is executing on this api instance. (An orphaned
    // run — e.g. from a prior restart — has no live token; the row flip above is
    // all that's needed since nothing is actually running to kill.)
    let token = state
        .run_cancels
        .lock()
        .expect("run_cancels mutex poisoned")
        .get(&id)
        .cloned();
    if let Some(token) = token {
        token.cancel();
    }

    Ok(Json(CancelRunResponse {
        cancelled: res.rows_affected() > 0,
    }))
}

#[derive(Debug, Deserialize)]
pub struct UpdateRunConcurrencyRequest {
    pub max_concurrent_runs: usize,
    pub max_sub_agents_per_orchestrator: usize,
}

#[derive(Debug, Serialize)]
pub struct UpdateRunConcurrencyResponse {
    pub max_concurrent_runs: usize,
    pub reserved_sub_agent_runs: usize,
    pub max_sub_agents_per_orchestrator: usize,
}

/// Apply live run-queue limits from instance settings. Reserved sub-agent
/// slots stay half of the maximum so orchestrators cannot fill the pool.
pub async fn update_run_concurrency(
    State(state): State<AppState>,
    Json(req): Json<UpdateRunConcurrencyRequest>,
) -> Result<Json<UpdateRunConcurrencyResponse>, (StatusCode, String)> {
    let reserved = req.max_concurrent_runs / 2;
    state
        .run_concurrency
        .set_limits(
            req.max_concurrent_runs,
            reserved,
            req.max_sub_agents_per_orchestrator,
        )
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    tracing::info!(
        max_concurrent_runs = req.max_concurrent_runs,
        reserved_sub_agent_runs = reserved,
        max_sub_agents_per_orchestrator = req.max_sub_agents_per_orchestrator,
        "run concurrency updated from instance settings"
    );
    Ok(Json(UpdateRunConcurrencyResponse {
        max_concurrent_runs: state.run_concurrency.max_concurrent_runs(),
        reserved_sub_agent_runs: state.run_concurrency.reserved_sub_agent_runs(),
        max_sub_agents_per_orchestrator: state.run_concurrency.max_sub_agents_per_orchestrator(),
    }))
}

#[cfg(test)]
mod tests {
    use super::{dry_run_error, run_environment_for_version_label};
    use crate::runs::delivery::{DeliveryDeclaration, DeliveryDestination, DeliveryEvidence};
    use crate::runs::runner::Framework;

    #[test]
    fn draft_runs_are_development() {
        assert_eq!(
            run_environment_for_version_label(Some("draft")),
            "development"
        );
    }

    #[test]
    fn promoted_and_unversioned_runs_are_production() {
        assert_eq!(run_environment_for_version_label(Some("v3")), "production");
        assert_eq!(run_environment_for_version_label(None), "production");
    }

    fn delivery() -> DeliveryDeclaration {
        DeliveryDeclaration {
            note: "Daily brief".into(),
            destinations: vec![DeliveryDestination {
                key: "inbox".into(),
                label: "Inbox".into(),
                evidence: DeliveryEvidence::InboxItem,
            }],
        }
    }

    #[test]
    fn live_runs_skip_dry_run_validation() {
        assert_eq!(dry_run_error(Framework::CargoAi, false, None), None);
    }

    #[test]
    fn dry_run_rejects_cargo_ai() {
        assert!(dry_run_error(Framework::CargoAi, true, Some(&delivery()))
            .unwrap()
            .contains("Cargo AI"));
    }

    #[test]
    fn dry_run_requires_delivery() {
        assert!(dry_run_error(Framework::Pydantic, true, None)
            .unwrap()
            .contains("delivery"));
    }

    #[test]
    fn pydantic_dry_run_with_delivery_is_ok() {
        assert_eq!(
            dry_run_error(Framework::Pydantic, true, Some(&delivery())),
            None
        );
    }
}

#[cfg(test)]
mod pricing_integration_tests {
    use super::*;
    use std::sync::{atomic::AtomicBool, Arc, Mutex};

    #[tokio::test]
    #[ignore = "requires PRICING_TEST_DATABASE_URL and TAS_ENCRYPTION_KEY"]
    async fn run_details_remain_readable_after_cost_is_saved() {
        let db = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect(&std::env::var("PRICING_TEST_DATABASE_URL").unwrap())
            .await
            .unwrap();
        // A single connection keeps this fixture isolated from application data.
        // Apply the cost migration rather than substituting a Rust-friendly type.
        sqlx::raw_sql(
            "CREATE TEMP TABLE run (
                id uuid PRIMARY KEY, workspace_id uuid, agent_name text DEFAULT 'test',
                agent_path text DEFAULT 'test.yaml', user_message text DEFAULT '',
                model text DEFAULT 'anthropic:claude-sonnet-4-6', status text DEFAULT 'running',
                output text DEFAULT '', streamed_output text, error_message text,
                failure_code text, failure_summary text, failure_recommendation text,
                created_by text DEFAULT 'test-user', created_at timestamptz DEFAULT now(),
                started_at timestamptz, completed_at timestamptz,
                tokens_input integer, tokens_output integer,
                scaledown_original_tokens integer, scaledown_compressed_tokens integer,
                trigger text DEFAULT 'manual', automation_id uuid, agent_version_id uuid,
                agent_version_label text, run_environment text DEFAULT 'production',
                resume_count integer DEFAULT 0, resumed_at timestamptz,
                is_dry_run boolean DEFAULT false, reused_from_run_id uuid, output_reuse_type text
            );",
        )
        .execute(&db)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!("../../migrations/0021_run_cost.sql"))
            .execute(&db)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!(
            "../../migrations/0100_run_pricing_snapshot.sql"
        ))
        .execute(&db)
        .await
        .unwrap();
        let state = AppState {
            db: db.clone(),
            http: reqwest::Client::new(),
            encryption_key: Arc::new(crate::crypto::MasterKey::from_env().unwrap()),
            memory: crate::memory::Memory::from_env(0),
            run_cancels: Arc::new(Mutex::new(Default::default())),
            run_concurrency: crate::runs::concurrency::RunConcurrency::new(2, 1, 1).unwrap(),
            draining: Arc::new(AtomicBool::new(false)),
        };
        let workspace_id = Uuid::new_v4();
        for cost in [None, Some(0.0_f64), Some(0.123456_f64)] {
            let id = Uuid::new_v4();
            sqlx::query("INSERT INTO run (id, workspace_id) VALUES ($1, $2)")
                .bind(id)
                .bind(workspace_id)
                .execute(&db)
                .await
                .unwrap();
            let running = get_run(
                State(state.clone()),
                Path(id),
                Query(GetRunQuery { workspace_id }),
            )
            .await
            .unwrap()
            .0;
            assert_eq!(running.status, "running");
            assert_eq!(running.cost_usd, None);

            let snapshot = serde_json::json!({"verifiedOn": "2026-10-07"});
            sqlx::query("UPDATE run SET status='succeeded', output='done', cost_usd=$2, pricing_snapshot=$3 WHERE id=$1")
                .bind(id)
                .bind(cost)
                .bind(&snapshot)
                .execute(&db)
                .await
                .unwrap();
            let completed = get_run(
                State(state.clone()),
                Path(id),
                Query(GetRunQuery { workspace_id }),
            )
            .await
            .unwrap()
            .0;
            assert_eq!(completed.status, "succeeded");
            assert_eq!(completed.output, "done");
            assert_eq!(completed.cost_usd, cost);
            assert_eq!(completed.pricing_snapshot, Some(snapshot));
            assert_eq!(
                serde_json::to_value(&completed).unwrap()["cost_usd"],
                serde_json::json!(cost)
            );

            let wrong_workspace = get_run(
                State(state.clone()),
                Path(id),
                Query(GetRunQuery {
                    workspace_id: Uuid::new_v4(),
                }),
            )
            .await
            .unwrap_err();
            assert_eq!(wrong_workspace, StatusCode::NOT_FOUND);
        }
        assert_eq!(
            get_run(
                State(state),
                Path(Uuid::new_v4()),
                Query(GetRunQuery { workspace_id })
            )
            .await
            .unwrap_err(),
            StatusCode::NOT_FOUND
        );
    }
}
