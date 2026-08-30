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

use crate::runs::runner;
use crate::AppState;

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
    /// The run that triggered this one (an orchestrator's run id), when this
    /// run was started via the tembo-agent-studio MCP `trigger_run` tool from
    /// inside another run. Lets the parent's page roll up sub-run costs.
    #[serde(default)]
    pub parent_run_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
pub struct CreateRunResponse {
    pub run_id: Uuid,
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

    sqlx::query(
        r#"INSERT INTO run
            (id, workspace_id, agent_name, agent_path, model, status,
             failure_code, failure_summary, failure_recommendation,
             created_by, user_message, trigger, automation_id,
             agent_version_id, agent_version_label, parent_run_id,
             execution_framework, execution_spec_content,
             execution_spec_format, execution_tools_module_content,
             execution_skills_content)
            VALUES ($1, $2, $3, $4, $5, 'queued', NULL, NULL, NULL,
                    $6, $7, $8, $9, $10, $11, $12,
                    $13, $14, $15, $16, $17)"#,
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
    .bind(req.parent_run_id)
    .bind(framework_name)
    .bind(req.spec_content.as_deref())
    .bind(spec_format_name)
    .bind(req.tools_module_content.as_deref())
    .bind(skills_json)
    .execute(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("db insert: {e}")))?;

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
                parent_run_id: req.parent_run_id,
            },
            cancel,
        )
        .await;
    });

    Ok(Json(CreateRunResponse { run_id }))
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
    /// ScaleDown prompt-compression totals (NULL unless the run compressed).
    pub scaledown_original_tokens: Option<i32>,
    pub scaledown_compressed_tokens: Option<i32>,
    pub trigger: String,
    pub automation_id: Option<Uuid>,
    pub agent_version_id: Option<Uuid>,
    pub agent_version_label: Option<String>,
    /// Number of times this run was reconstructed after an API restart.
    pub resume_count: i32,
    pub resumed_at: Option<DateTime<Utc>>,
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
                  scaledown_original_tokens, scaledown_compressed_tokens,
                  trigger, automation_id, agent_version_id, agent_version_label,
                  resume_count, resumed_at
             FROM run
             WHERE id = $1 AND workspace_id = $2"#,
    )
    .bind(id)
    .bind(query.workspace_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

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
