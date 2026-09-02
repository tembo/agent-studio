//! The actual run task. Lifecycle:
//!   queued → running → succeeded | failed
//! Output, safe failure guidance, and privileged diagnostics are written back
//! to the run row so the web poller can render the right view for each role.
//! Both supported frameworks (Pydantic AI,
//! Cargo AI) run as passthrough subprocess calls into the upstream
//! tool — see the per-framework modules for the wire details.

use anyhow::{anyhow, Context};
use chrono::{DateTime, Utc};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::runs::{cargo_ai, delivery, pydantic};
use crate::workspace::{
    get_workspace_secret_plaintext, list_active_composio_connections,
    list_active_native_connections, list_workspace_secret_connections, SecretKind,
};
use crate::AppState;

#[derive(Debug, Clone, Copy)]
pub enum Framework {
    Pydantic,
    CargoAi,
}

#[derive(Debug, Clone, Copy)]
pub enum SpecFormat {
    Yaml,
    Json,
}

impl SpecFormat {
    fn as_pydantic(self) -> pydantic::SpecFormat {
        match self {
            SpecFormat::Yaml => pydantic::SpecFormat::Yaml,
            SpecFormat::Json => pydantic::SpecFormat::Json,
        }
    }
}

pub struct RunContext {
    pub run_id: Uuid,
    pub workspace_id: Uuid,
    /// The user this run acts as for credential lookups (manual
    /// runs = the requesting user; scheduled runs = the automation's
    /// owner_user_id). Drives which Composio connections the
    /// Pydantic wrapper attaches to the agent's session.
    pub acting_user_id: String,
    /// `provider:model` (e.g. `openai:gpt-4o-mini`). Cargo AI needs
    /// the split; Pydantic passthrough lets pydantic-ai parse the
    /// model field straight out of the spec and only uses this for
    /// run-row metadata.
    pub model: String,
    pub user_message: String,
    pub framework: Framework,
    /// Raw agent file content as it sits in the repo. Required for
    /// both frameworks now that both are passthrough.
    pub spec_content: Option<String>,
    /// Spec content format — YAML or JSON. Drives Python wrapper's
    /// --fmt flag (Pydantic) or selects the JSON parser (Cargo AI).
    pub spec_format: SpecFormat,
    /// Optional sidecar Python module (the Pydantic agent's
    /// `tools_module:`) passed to the wrapper as TAS_TOOLS_MODULE_CONTENT.
    /// Pydantic-only; cargo-ai ignores it.
    pub tools_module_content: Option<String>,
    /// Files of the Agent Skills the agent opts into, as `{ repoPath: content }`,
    /// passed to the wrapper as TAS_SKILLS_CONTENT (JSON). Pydantic-only.
    pub skills_content: Option<std::collections::HashMap<String, String>>,
    /// Latest acknowledged pydantic-ai message history when recovering an
    /// interrupted run. None for a first attempt and all Cargo AI runs.
    pub message_history: Option<serde_json::Value>,
    /// Preserve the original running timestamp across recovery so the built-in
    /// run clock remains stable and duration covers the interruption.
    pub started_at: Option<DateTime<Utc>>,
    /// Orchestrator run that launched this execution. Sub-agent runs may use
    /// capacity reserved for orchestration progress.
    pub orchestrator_run_id: Option<Uuid>,
    /// Manual dry-run: declared delivery tools are stubbed at runtime.
    pub is_dry_run: bool,
}

struct RunOutcome {
    output: String,
    usage: Option<Usage>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RunFailure {
    code: &'static str,
    summary: &'static str,
    recommendation: &'static str,
    details: String,
}

impl RunFailure {
    /// Convert framework/provider diagnostics into a stable category and
    /// constant user-facing copy. Summaries deliberately never interpolate the
    /// raw error: traces can contain internal paths, provider payloads, or
    /// connection identifiers and are reserved for workspace admins.
    fn classify(details: impl Into<String>) -> Self {
        let details = details.into();
        let normalized = details.to_ascii_lowercase();

        let (code, summary, recommendation) = if normalized.contains("cached connection")
            || normalized.contains("toolrouterv2_invalidconnectedaccountids")
        {
            (
                "connection_stale",
                "A connected service needs to be reauthorized.",
                "Reconnect the service, then run the agent again.",
            )
        } else if (normalized.contains("no active") && normalized.contains("connection"))
            || normalized.contains("agent declares native-mcp connections")
        {
            (
                "connection_required",
                "The agent is missing a required connection.",
                "Connect the required service, then run the agent again.",
            )
        } else if normalized.contains("composio api key") {
            (
                "connection_provider_setup",
                "The workspace connection provider is not configured.",
                "Ask a workspace admin to configure the connection provider.",
            )
        } else if normalized.contains("mcp")
            && (normalized.contains("status 401")
                || normalized.contains("status code: 401")
                || normalized.contains("unauthorized"))
        {
            (
                "connection_stale",
                "A connected service needs to be reauthorized.",
                "Reconnect the service, then run the agent again.",
            )
        } else if normalized.contains("api key")
            || normalized.contains("authentication_error")
            || normalized.contains("authenticationerror")
            || normalized.contains("authentication failed")
            || normalized.contains("unauthorized")
            || normalized.contains("status code: 401")
            || normalized.contains("status 401")
        {
            (
                "provider_credentials",
                "The model provider rejected or is missing its credentials.",
                "Ask a workspace admin to check the LLM provider settings.",
            )
        } else if normalized.contains("failed to parse spec")
            || normalized.contains("agentspec")
            || normalized.contains("tools_module")
            || normalized.contains("agent's model field")
            || normalized.contains("agent json")
        {
            (
                "agent_configuration",
                "The agent definition could not be loaded.",
                "Review the agent definition, correct it, and run the agent again.",
            )
        } else if normalized.contains("rate limit")
            || normalized.contains("rate_limit")
            || normalized.contains("status code: 429")
            || normalized.contains("status 429")
        {
            (
                "rate_limited",
                "A provider temporarily rate-limited the run.",
                "Wait briefly, then run the agent again.",
            )
        } else if normalized.contains("timed out")
            || normalized.contains("timeout")
            || normalized.contains("connection error")
            || normalized.contains("connectionerror")
            || normalized.contains("service unavailable")
        {
            (
                "provider_unavailable",
                "A provider was temporarily unavailable.",
                "Run the agent again. If it keeps failing, ask a workspace admin to investigate.",
            )
        } else if normalized.contains("failed to spawn")
            || normalized.contains("process failed to complete")
        {
            (
                "run_start_failed",
                "The agent runtime could not start.",
                "Run the agent again. If it keeps failing, ask a workspace admin to investigate.",
            )
        } else if normalized.starts_with("interrupted") {
            (
                "interrupted",
                "The run was interrupted before it finished.",
                "Run the agent again.",
            )
        } else {
            (
                "unknown",
                "The run ended unexpectedly.",
                "Try again. If it keeps failing, ask a workspace admin to investigate.",
            )
        };

        Self {
            code,
            summary,
            recommendation,
            details,
        }
    }
}

// Provider-neutral usage shape. Both pydantic-ai's usage and any
// future framework's normalise into this before crossing into the
// run row so the column semantics ({tokens_input, tokens_output})
// stay consistent regardless of who produced them.
#[derive(Debug, Clone, Copy)]
struct Usage {
    input_tokens: i32,
    output_tokens: i32,
    /// Anthropic prompt-cache halves (0 when caching is off / not Anthropic).
    /// Priced separately from input_tokens in the cost estimate.
    cache_read_tokens: i32,
    cache_write_tokens: i32,
}

#[derive(sqlx::FromRow)]
struct OrphanedRun {
    id: Uuid,
    workspace_id: Uuid,
    created_by: String,
    model: String,
    user_message: String,
    execution_framework: Option<String>,
    execution_spec_content: Option<String>,
    execution_spec_format: Option<String>,
    execution_tools_module_content: Option<String>,
    execution_skills_content: Option<serde_json::Value>,
    message_history: Option<serde_json::Value>,
    started_at: Option<DateTime<Utc>>,
    orchestrator_run_id: Option<Uuid>,
    is_dry_run: bool,
}

/// Reconstruct Pydantic runs whose in-memory task disappeared with the prior
/// API process. Cargo AI and legacy rows have no safe replay boundary, so they
/// retain the explicit interrupted failure behavior instead of starting over.
pub async fn recover_orphaned_runs(state: &AppState) {
    let rows = match sqlx::query_as::<_, OrphanedRun>(
        "SELECT id, workspace_id, created_by, model, user_message, \
                execution_framework, execution_spec_content, execution_spec_format, \
                execution_tools_module_content, execution_skills_content, \
                message_history, started_at, orchestrator_run_id, is_dry_run \
           FROM run WHERE status IN ('queued', 'running') ORDER BY created_at",
    )
    .fetch_all(&state.db)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!(?e, "failed to load orphaned runs on boot");
            return;
        }
    };

    for row in rows {
        if row.execution_framework.as_deref() != Some("pydantic-agentspec")
            || row.execution_spec_content.is_none()
        {
            let reason = if row.execution_framework.as_deref() == Some("cargo-ai") {
                "Interrupted — Cargo AI runs do not yet have a safe replay checkpoint."
            } else {
                "Interrupted — this run predates durable execution and cannot be resumed."
            };
            let failure = RunFailure::classify(reason);
            if let Err(e) = mark_failed(state, row.id, &failure).await {
                tracing::error!(run_id = %row.id, ?e, "failed to finalize non-resumable orphan");
            }
            continue;
        }

        let updated = sqlx::query(
            "UPDATE run SET status = 'queued', completed_at = NULL, \
                    error_message = NULL, failure_code = NULL, \
                    failure_summary = NULL, failure_recommendation = NULL, \
                    streamed_output = NULL, \
                    resume_count = resume_count + 1, resumed_at = now() \
              WHERE id = $1 AND status IN ('queued', 'running')",
        )
        .bind(row.id)
        .execute(&state.db)
        .await;
        match updated {
            Ok(result) if result.rows_affected() == 1 => {}
            Ok(_) => continue,
            Err(e) => {
                tracing::error!(run_id = %row.id, ?e, "failed to queue orphaned run for recovery");
                continue;
            }
        }

        let skills_content = row
            .execution_skills_content
            .and_then(|value| serde_json::from_value(value).ok());
        let cancel = CancellationToken::new();
        state
            .run_cancels
            .lock()
            .expect("run_cancels mutex poisoned")
            .insert(row.id, cancel.clone());
        let task_state = state.clone();
        let run_id = row.id;
        tokio::spawn(async move {
            execute_run(
                &task_state,
                RunContext {
                    run_id,
                    workspace_id: row.workspace_id,
                    acting_user_id: row.created_by,
                    model: row.model,
                    user_message: row.user_message,
                    framework: Framework::Pydantic,
                    spec_content: row.execution_spec_content,
                    spec_format: match row.execution_spec_format.as_deref() {
                        Some("yaml") => SpecFormat::Yaml,
                        _ => SpecFormat::Json,
                    },
                    tools_module_content: row.execution_tools_module_content,
                    skills_content,
                    message_history: row.message_history,
                    started_at: row.started_at,
                    orchestrator_run_id: row.orchestrator_run_id,
                    is_dry_run: row.is_dry_run,
                },
                cancel,
            )
            .await;
        });
        tracing::warn!(run_id = %run_id, "resuming orphaned Pydantic run from checkpoint");
    }
}

/// Drive a single run from queued through to terminal state. Always
/// updates the run row even on error so the UI never sees a row stuck
/// in `running` forever.
pub async fn execute_run(state: &AppState, ctx: RunContext, cancel: CancellationToken) {
    // The handler registered this token synchronously before spawning so
    // shutdown draining cannot miss a queued-but-not-yet-polled run. Always
    // remove it on exit, so the registry only holds accepted, non-terminal
    // runs from this api process.
    let run_id = ctx.run_id;

    let is_sub_agent = ctx.orchestrator_run_id.is_some();
    let permit = state
        .run_concurrency
        .acquire(ctx.orchestrator_run_id, &cancel)
        .await;
    let Some(_permit) = permit else {
        if cancel.is_cancelled() {
            tracing::info!(run_id = %run_id, "queued run cancelled before execution capacity was available");
        } else {
            tracing::info!(run_id = %run_id, "queued run deferred for recovery during shutdown");
        }
        state
            .run_cancels
            .lock()
            .expect("run_cancels mutex poisoned")
            .remove(&run_id);
        return;
    };
    if cancel.is_cancelled() {
        state
            .run_cancels
            .lock()
            .expect("run_cancels mutex poisoned")
            .remove(&run_id);
        return;
    }
    tracing::info!(
        run_id = %run_id,
        active_runs = state.run_concurrency.active_runs(),
        max_concurrent_runs = state.run_concurrency.max_concurrent_runs(),
        is_sub_agent,
        "run execution slot acquired"
    );

    execute_run_inner(state, ctx, &cancel).await;

    let mut cancels = state
        .run_cancels
        .lock()
        .expect("run_cancels mutex poisoned");
    cancels.remove(&run_id);
}

async fn execute_run_inner(state: &AppState, ctx: RunContext, cancel: &CancellationToken) {
    let run_started_at = ctx.started_at.unwrap_or_else(Utc::now);
    match mark_running(state, ctx.run_id, run_started_at).await {
        Ok(true) => {}
        Ok(false) => return,
        Err(e) => {
            tracing::error!(run_id = %ctx.run_id, ?e, "mark_running failed");
            // Best-effort write the failure to the run row so the UI sees it.
            let failure = RunFailure::classify(format!("internal: {e}"));
            let _ = mark_failed(state, ctx.run_id, &failure).await;
            return;
        }
    }

    let (result, tool_calls, steps) = run_inner(state, &ctx, run_started_at, cancel).await;
    // Persist per-step usage + what the agent called (success or failure)
    // before we mark the terminal state. Best-effort — a logging hiccup must
    // not fail the run.
    persist_run_steps(state, ctx.run_id, &steps).await;
    persist_tool_calls(state, ctx.run_id, &tool_calls).await;

    match result {
        Ok(outcome) => {
            if let Err(e) = mark_succeeded(
                state,
                ctx.run_id,
                &outcome.output,
                outcome.usage,
                &ctx.model,
            )
            .await
            {
                tracing::error!(run_id = %ctx.run_id, ?e, "mark_succeeded failed");
            }
            let body = if outcome.output.trim().is_empty() {
                ":white_check_mark: Done (no output).".to_string()
            } else {
                // Drop the "user> …" echo (they typed it in Slack already),
                // then convert Markdown → Slack mrkdwn.
                crate::slack_mrkdwn::to_mrkdwn(crate::slack_mrkdwn::strip_user_echo(
                    &outcome.output,
                ))
            };
            deliver_slack_result(state, ctx.run_id, &body).await;
        }
        Err(e) => {
            // A user-cancelled run already had its row written to 'cancelled' by
            // the cancel endpoint; the error here is just the killed subprocess
            // unwinding. Don't overwrite it with 'failed' or send a Slack
            // "failed" message — the cancellation was intentional.
            if cancel.is_cancelled() {
                tracing::info!(run_id = %ctx.run_id, "run cancelled by user");
                return;
            }
            let reason = format!("{e:#}");
            let failure = RunFailure::classify(reason.clone());
            tracing::warn!(run_id = %ctx.run_id, ?e, "run failed");
            if let Err(db_err) = mark_failed(state, ctx.run_id, &failure).await {
                tracing::error!(run_id = %ctx.run_id, ?db_err, "mark_failed failed");
            }
            deliver_slack_result(
                state,
                ctx.run_id,
                &format!(
                    ":warning: Run failed: {} {}",
                    failure.summary, failure.recommendation
                ),
            )
            .await;
        }
    }
}

// Returns the run outcome plus the tool calls the agent made (pydantic
// only; cargo-ai exposes none → empty). Tool calls come back on the
// failure path too, so a failed run still records what it called.
async fn run_inner(
    state: &AppState,
    ctx: &RunContext,
    run_started_at: DateTime<Utc>,
    cancel: &CancellationToken,
) -> (
    anyhow::Result<RunOutcome>,
    Vec<pydantic::ToolCall>,
    Vec<pydantic::RunStep>,
) {
    match ctx.framework {
        Framework::CargoAi => {
            // Cargo AI still needs the provider:model split to set
            // its --server / --model CLI flags; pydantic-ai parses
            // its own model field out of the spec.
            let (provider, model) = match ctx.model.split_once(':') {
                Some(pm) => pm,
                None => {
                    return (
                        Err(anyhow!(
                            "agent's model field must be `provider:model` (got `{}`)",
                            ctx.model
                        )),
                        Vec::new(),
                        Vec::new(),
                    )
                }
            };
            // cargo-ai exposes neither per-step usage nor tool calls.
            (
                run_cargo_ai(state, ctx, provider, model).await,
                Vec::new(),
                Vec::new(),
            )
        }
        Framework::Pydantic => run_pydantic(state, ctx, run_started_at, cancel).await,
    }
}

async fn run_cargo_ai(
    state: &AppState,
    ctx: &RunContext,
    provider: &str,
    model: &str,
) -> anyhow::Result<RunOutcome> {
    // Today cargo-ai 0.3.0 only ships OpenAI + Ollama providers, so
    // an Anthropic Cargo AI agent has no upstream to talk to. We
    // unblock that once our cargo-ai Anthropic-provider PR lands;
    // until then, surface the limitation explicitly rather than
    // silently failing inside cargo-ai.
    if provider != "openai" {
        return Err(anyhow!(
            "Cargo AI agents currently only run against `openai:` models. \
             The bundled cargo-ai CLI doesn't yet support `{}` — track the upstream PR \
             in https://github.com/analyzer1/cargo-ai for Anthropic support.",
            provider
        ));
    }

    let spec_json = ctx
        .spec_content
        .as_deref()
        .ok_or_else(|| anyhow!("Cargo AI run is missing the agent's raw JSON"))?;

    let api_key = get_workspace_secret_plaintext(
        &state.db,
        &state.encryption_key,
        ctx.workspace_id,
        SecretKind::OpenAiApiKey,
    )
    .await
    .context(
        "Couldn't load this workspace's OpenAI API key. \
         Set it under Settings → OpenAI API key.",
    )?;

    let result = cargo_ai::invoke(cargo_ai::CargoAiArgs {
        spec_json,
        provider,
        model,
        api_key: &api_key,
        user_message: &ctx.user_message,
    })
    .await?;

    // cargo-ai writes the agent reply through a synthetic emit
    // action (see cargo_ai::synthesize_emit_action), so every
    // content line lands prefixed with `[Action N: _tas_emit_output] reply: …`.
    // Strip that wrapping for the user-facing transcript; raw stdout
    // is still recoverable via docker logs if anything goes wrong.
    // Token usage isn't currently surfaced by cargo-ai (queued as an
    // upstream PR); we record None and the run page hides the
    // "Consumed" row gracefully.
    let reply = extract_emit_reply(&result.stdout);
    let mut transcript = String::new();
    if !ctx.user_message.is_empty() {
        transcript.push_str("user> ");
        transcript.push_str(&ctx.user_message);
        transcript.push_str("\n\n");
    }
    if reply.trim().is_empty() {
        // Defensive: if the emit action didn't fire (older cargo-ai
        // version, schema with no `properties`, action runtime
        // failure), fall back to the raw stdout so the user at least
        // sees what cargo-ai produced.
        transcript.push_str(result.stdout.trim_end());
    } else {
        transcript.push_str(reply.trim_end());
    }
    // cargo-ai's stderr is operational noise ("Initialized Cargo AI
    // Home at …") — keep it out of the user transcript. On failure,
    // invoke surfaces stderr through the run's error message.

    Ok(RunOutcome {
        output: transcript,
        usage: None,
    })
}

async fn run_pydantic(
    state: &AppState,
    ctx: &RunContext,
    run_started_at: DateTime<Utc>,
    cancel: &CancellationToken,
) -> (
    anyhow::Result<RunOutcome>,
    Vec<pydantic::ToolCall>,
    Vec<pydantic::RunStep>,
) {
    let spec_content = match ctx.spec_content.as_deref() {
        Some(s) => s,
        None => {
            return (
                Err(anyhow!(
                    "Pydantic run is missing the agent's raw spec content"
                )),
                Vec::new(),
                Vec::new(),
            )
        }
    };

    // Load whichever provider keys the workspace has set. Either
    // (or both) may be absent; pydantic-ai inside the subprocess
    // looks up the env var matching the agent's `model:` field, and
    // surfaces a clean "missing API key" error if its specific
    // provider isn't wired up. Treating absent keys as None here
    // means a workspace with only one provider configured can still
    // run agents that point at that provider.
    let openai_key = get_workspace_secret_plaintext(
        &state.db,
        &state.encryption_key,
        ctx.workspace_id,
        SecretKind::OpenAiApiKey,
    )
    .await
    .ok();
    let anthropic_key = get_workspace_secret_plaintext(
        &state.db,
        &state.encryption_key,
        ctx.workspace_id,
        SecretKind::AnthropicApiKey,
    )
    .await
    .ok();
    // Composio key is optional — only needed if the agent's spec
    // declares `connections:`. The Python wrapper enforces the
    // "needed but missing" case with a clearer error than we could
    // here without parsing the spec twice.
    let composio_key = get_workspace_secret_plaintext(
        &state.db,
        &state.encryption_key,
        ctx.workspace_id,
        SecretKind::ComposioApiKey,
    )
    .await
    .ok();
    // ScaleDown key is optional — when set (and the agent opts in via its
    // `scaledown:` spec field), the wrapper compresses bulky prompt/context
    // through ScaleDown before each frontier-model call to cut tokens. Absent =
    // no compression. Plumbed for every agent (not gated on a tools module).
    let scaledown_key = get_workspace_secret_plaintext(
        &state.db,
        &state.encryption_key,
        ctx.workspace_id,
        SecretKind::ScaleDownApiKey,
    )
    .await
    .ok();
    // Composio user_id we pass through is the composite
    // `${workspace_id}:${acting_user_id}` so Composio's vault stays
    // isolated per (workspace, user) — mirrors what the web side
    // hands to composio.connectedAccounts.link.
    let composio_user_id = format!("{}:{}", ctx.workspace_id, ctx.acting_user_id);
    // Pre-resolved nested `{toolkit_slug: {name: connection_id}}`
    // map for the acting user's ACTIVE composio connections.
    // Composio's Tool Router session needs the explicit
    // connection_id per declared slot when manage_connections=false;
    // otherwise sessions report the toolkits as inactive even when
    // the user authorized them.
    let composio_connected_accounts_json: Option<String> = if composio_key.is_some() {
        let triples =
            list_active_composio_connections(&state.db, ctx.workspace_id, &ctx.acting_user_id)
                .await
                .unwrap_or_default();
        if triples.is_empty() {
            None
        } else {
            let mut by_toolkit: std::collections::BTreeMap<
                String,
                serde_json::Map<String, serde_json::Value>,
            > = std::collections::BTreeMap::new();
            for (toolkit, name, id) in triples {
                by_toolkit
                    .entry(toolkit)
                    .or_default()
                    .insert(name, serde_json::Value::String(id));
            }
            let mut top = serde_json::Map::new();
            for (toolkit, inner) in by_toolkit {
                top.insert(toolkit, serde_json::Value::Object(inner));
            }
            Some(serde_json::Value::Object(top).to_string())
        }
    } else {
        None
    };

    // Native-MCP credentials — decrypted in the runtime so the
    // Python wrapper never holds the encryption key. JSON shape:
    // `{provider: {name: {mcp_url, access_token}}}`. Independent of
    // Composio; an agent can mix both sources in its spec.
    let native_mcp_connections_json: Option<String> = {
        // Refresh-before-use: mint fresh access tokens for any native
        // connections at/near expiry before we read and hand them to
        // the wrapper. Best-effort — a failed refresh falls through to
        // the existing stale-marking path if the token then 401s.
        if let Err(e) = crate::native_oauth::refresh_expiring_native_connections(
            &state.db,
            &state.encryption_key,
            &state.http,
            ctx.workspace_id,
            &ctx.acting_user_id,
        )
        .await
        {
            tracing::warn!(
                ?e,
                "native MCP refresh sweep errored; proceeding with existing tokens"
            );
        }
        let rows = list_active_native_connections(
            &state.db,
            &state.encryption_key,
            ctx.workspace_id,
            &ctx.acting_user_id,
        )
        .await
        .unwrap_or_default();
        if rows.is_empty() {
            None
        } else {
            let mut by_provider: std::collections::BTreeMap<
                String,
                serde_json::Map<String, serde_json::Value>,
            > = std::collections::BTreeMap::new();
            for row in rows {
                let mut entry = serde_json::Map::new();
                entry.insert(
                    "mcp_url".to_string(),
                    serde_json::Value::String(row.mcp_url),
                );
                entry.insert(
                    "access_token".to_string(),
                    serde_json::Value::String(row.access_token),
                );
                if let Some(api_key) = row.api_key {
                    entry.insert("api_key".to_string(), serde_json::Value::String(api_key));
                }
                by_provider
                    .entry(row.provider)
                    .or_default()
                    .insert(row.name, serde_json::Value::Object(entry));
            }
            let mut top = serde_json::Map::new();
            for (provider, inner) in by_provider {
                top.insert(provider, serde_json::Value::Object(inner));
            }
            Some(serde_json::Value::Object(top).to_string())
        }
    };

    // Secrets (the 3rd substrate) — flat `{slug: value}` of the workspace's
    // free-form API keys. Only injected when the agent has a sidecar tools
    // module, since secrets are consumed by Python tools (via
    // tas_tools.secret), never by the model directly — least privilege.
    let secrets_json: Option<String> = if ctx.tools_module_content.is_some() {
        let rows = list_workspace_secret_connections(
            &state.db,
            &state.encryption_key,
            ctx.workspace_id,
            &ctx.acting_user_id,
        )
        .await
        .unwrap_or_default();
        if rows.is_empty() {
            None
        } else {
            let mut map = serde_json::Map::new();
            for (slug, value) in rows {
                map.insert(slug, serde_json::Value::String(value));
            }
            Some(serde_json::Value::Object(map).to_string())
        }
    } else {
        None
    };

    // Skill files the agent opts into, JSON-encoded `{repoPath: content}`. The
    // wrapper writes them to a temp dir and mounts pydantic-ai-skills.
    let skills_content_json: Option<String> = ctx
        .skills_content
        .as_ref()
        .filter(|m| !m.is_empty())
        .map(|m| serde_json::to_string(m).unwrap_or_default())
        .filter(|s| !s.is_empty());

    if openai_key.is_none() && anthropic_key.is_none() {
        // Pydantic-ai would fail inside the subprocess with a less
        // friendly message; intercept here so the run row's error
        // surface tells the customer exactly what to do.
        return (
            Err(anyhow!(
                "No provider API keys set for this workspace. \
                 Add either an OpenAI or Anthropic API key under \
                 Settings → API keys before running an agent."
            )),
            Vec::new(),
            Vec::new(),
        );
    }

    let (result, tool_calls, steps) = pydantic::invoke(pydantic::PydanticArgs {
        spec_content,
        message_history: ctx.message_history.as_ref(),
        spec_format: ctx.spec_format.as_pydantic(),
        user_message: &ctx.user_message,
        openai_api_key: openai_key.as_deref(),
        anthropic_api_key: anthropic_key.as_deref(),
        composio_api_key: composio_key.as_deref(),
        scaledown_api_key: scaledown_key.as_deref(),
        composio_user_id: composio_key.as_ref().map(|_| composio_user_id.as_str()),
        composio_connected_accounts_json: composio_connected_accounts_json.as_deref(),
        native_mcp_connections_json: native_mcp_connections_json.as_deref(),
        tools_module_content: ctx.tools_module_content.as_deref(),
        skills_content_json: skills_content_json.as_deref(),
        secrets_json: secrets_json.as_deref(),
        workspace_id: ctx.workspace_id,
        acting_user_id: ctx.acting_user_id.as_str(),
        run_started_at,
        run_id: ctx.run_id,
        db: &state.db,
        cancel,
        is_dry_run: ctx.is_dry_run,
    })
    .await;

    let outcome = result.map(|r| {
        let usage = r.usage.as_ref().and_then(|u| {
            u.input_output().map(|(input, output)| Usage {
                input_tokens: input,
                output_tokens: output,
                cache_read_tokens: u.cache_read_tokens.unwrap_or(0),
                cache_write_tokens: u.cache_write_tokens.unwrap_or(0),
            })
        });
        RunOutcome {
            output: render_output(&ctx.user_message, &r.output),
            usage,
        }
    });
    (outcome, tool_calls, steps)
}

// Pull the agent's reply out of cargo-ai's mixed stdout. Every line
// emitted by the synthetic action is prefixed with
// `[Action N: _tas_emit_output] ` — first content line follows with
// `reply: <text>`, continuation lines just `<text>`. The action also
// emits its own progress noise (`started`, `step N/N exec started; …`,
// `completed · <duration>`) under the same prefix. We strip the
// prefix on every match, drop the noise patterns, strip an optional
// `reply: ` on the first line, and concatenate the rest.
fn extract_emit_reply(stdout: &str) -> String {
    const ACTION_NAME: &str = ": _tas_emit_output] ";
    let mut out = String::new();
    for line in stdout.lines() {
        let Some(idx) = line.find(ACTION_NAME) else {
            continue;
        };
        let mut content = &line[idx + ACTION_NAME.len()..];
        if is_action_progress_noise(content) {
            continue;
        }
        if let Some(stripped) = content.strip_prefix("reply: ") {
            content = stripped;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(content);
    }
    out
}

// cargo-ai narrates exec steps with these lifecycle lines. We don't
// want them in the user-facing transcript — they're operational
// noise, not agent content. Match by prefix so cargo-ai can add
// trailing context (duration, exit code, etc.) without breaking us.
fn is_action_progress_noise(content: &str) -> bool {
    content == "started" || content.starts_with("step ") || content.starts_with("completed")
}

// Common output framing across providers. When the user supplied a
// message we prefix it with "user> " so the saved output reads as a
// transcript; otherwise we render just the agent's text.
fn render_output(user_message: &str, text: &str) -> String {
    let mut out = String::new();
    if !user_message.is_empty() {
        out.push_str("user> ");
        out.push_str(user_message);
        out.push_str("\n\n");
    }
    out.push_str(text);
    out
}

async fn mark_running(
    state: &AppState,
    run_id: Uuid,
    started_at: DateTime<Utc>,
) -> anyhow::Result<bool> {
    // Guard on 'queued': if the run was cancelled in the gap between being
    // queued and starting, leave the 'cancelled' status alone.
    let result = sqlx::query(
        "UPDATE run SET status = 'running', started_at = $1 \
              WHERE id = $2 AND status = 'queued'",
    )
    .bind(started_at)
    .bind(run_id)
    .execute(&state.db)
    .await?;
    Ok(result.rows_affected() == 1)
}

async fn mark_succeeded(
    state: &AppState,
    run_id: Uuid,
    output: &str,
    usage: Option<Usage>,
    model: &str,
) -> anyhow::Result<()> {
    let (tokens_in, tokens_out) = match usage {
        Some(u) => (Some(u.input_tokens), Some(u.output_tokens)),
        None => (None, None),
    };
    // Persist the cost estimate now, with the model + tokens
    // already in hand, so the runs-list UI doesn't have to map
    // model→rate on every render. None when usage is missing
    // (cargo-ai) or the model isn't in our pricing table.
    let cost_usd: Option<f64> = match usage {
        Some(u) => crate::pricing::estimate_run_cost(
            model,
            u.input_tokens,
            u.output_tokens,
            u.cache_read_tokens,
            u.cache_write_tokens,
        ),
        None => None,
    };
    let mut tx = state.db.begin().await?;
    let declaration_json: Option<serde_json::Value> =
        sqlx::query_scalar("SELECT output_delivery FROM run WHERE id = $1 FOR UPDATE")
            .bind(run_id)
            .fetch_optional(&mut *tx)
            .await?
            .flatten();
    let declaration = declaration_json
        .map(serde_json::from_value::<delivery::DeliveryDeclaration>)
        .transpose()
        .context("decode output delivery declaration")?;
    let (delivery_status, delivery_evidence) = if let Some(declaration) = declaration.as_ref() {
        let tool_calls = sqlx::query_as::<_, (String, Option<bool>)>(
            "SELECT tool_name, ok FROM run_tool_call WHERE run_id = $1",
        )
        .bind(run_id)
        .fetch_all(&mut *tx)
        .await?;
        let produced_inbox_item: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM inbox_item WHERE produced_by_run_id = $1)",
        )
        .bind(run_id)
        .fetch_one(&mut *tx)
        .await?;
        delivery::derive_delivery_status(Some(declaration), &tool_calls, produced_inbox_item)
    } else {
        delivery::derive_delivery_status(None, &[], false)
    };
    let delivery_evidence = serde_json::to_value(delivery_evidence)?;

    sqlx::query(
        "UPDATE run SET status = 'succeeded', output = $1, completed_at = $2, \
                        tokens_input = $3, tokens_output = $4, cost_usd = $5, \
                        streamed_output = NULL, delivery_status = $6, \
                        delivery_evidence = $7 \
                  WHERE id = $8 AND status = 'running'",
    )
    .bind(output)
    .bind(Utc::now())
    .bind(tokens_in)
    .bind(tokens_out)
    .bind(cost_usd)
    .bind(delivery_status.as_str())
    .bind(delivery_evidence)
    .bind(run_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{extract_emit_reply, RunFailure};

    #[test]
    fn extracts_reply_lines_drops_progress_lines() {
        let stdout = "\
Using explicit --token override; bypassing profile auth-mode resolution.
using: profile=none auth=api_key server=openai model=gpt-4o-mini
run: sequential
[Action 1: _tas_emit_output] started
[Action 1: _tas_emit_output] step 1/1 exec started; waiting for command to finish...
[Action 1: _tas_emit_output] reply: greeting: Hi there!
[Action 1: _tas_emit_output] mood: cheerful
[Action 1: _tas_emit_output] completed · 3ms

Run complete · 3.7s total
";
        let reply = extract_emit_reply(stdout);
        assert_eq!(reply, "greeting: Hi there!\nmood: cheerful");
    }

    #[test]
    fn keeps_multiline_content_continuation_lines() {
        // Real shape we see from cargo-ai when an exec emits a
        // multi-line value: the first content line carries the
        // `reply:` prefix, every continuation line just has the
        // bracket prefix and the raw text. Continuation lines must
        // not be dropped (that's the bug we hit in the wild).
        let stdout = "\
[Action 1: _tas_emit_output] reply: **Weather Report:**
[Action 1: _tas_emit_output] Current conditions are partly cloudy.
[Action 1: _tas_emit_output] High of 72°F, low of 55°F.
[Action 1: _tas_emit_output] completed · 3ms
";
        let reply = extract_emit_reply(stdout);
        assert_eq!(
            reply,
            "**Weather Report:**\nCurrent conditions are partly cloudy.\nHigh of 72°F, low of 55°F."
        );
    }

    #[test]
    fn returns_empty_when_no_emit_lines_present() {
        let stdout = "Run complete · 1.0s total\n";
        assert!(extract_emit_reply(stdout).is_empty());
    }

    #[test]
    fn classifies_stale_connections_without_exposing_details() {
        let failure = RunFailure::classify(
            "Composio rejected the cached connection for: gmail/default. raw token ca_secret",
        );
        assert_eq!(failure.code, "connection_stale");
        assert_eq!(
            failure.summary,
            "A connected service needs to be reauthorized."
        );
        assert!(!failure.summary.contains("gmail"));
        assert!(failure.details.contains("ca_secret"));
    }

    #[test]
    fn classifies_agent_configuration_failures() {
        let failure = RunFailure::classify(
            "pydantic-ai wrapper exited: failed to parse spec: AgentSpec is invalid",
        );
        assert_eq!(failure.code, "agent_configuration");
    }

    #[test]
    fn classifies_common_recoverable_failures() {
        let cases = [
            (
                "Agent declares native-MCP connections ['github'] but the run's acting user has no active connection",
                "connection_required",
            ),
            ("AuthenticationError: invalid API key", "provider_credentials"),
            ("ModelHTTPError: status code: 429 rate limit", "rate_limited"),
            ("request timed out", "provider_unavailable"),
            ("failed to spawn pydantic-ai wrapper", "run_start_failed"),
            ("Interrupted — runtime stopped", "interrupted"),
            ("MCP server returned status 401", "connection_stale"),
        ];

        for (details, expected_code) in cases {
            assert_eq!(RunFailure::classify(details).code, expected_code);
        }
    }

    #[test]
    fn unknown_failures_use_a_safe_generic_summary() {
        let failure = RunFailure::classify("Traceback: customer payload and internal path");
        assert_eq!(failure.code, "unknown");
        assert_eq!(failure.summary, "The run ended unexpectedly.");
        assert!(!failure.summary.contains("customer payload"));
    }
}

async fn mark_failed(state: &AppState, run_id: Uuid, failure: &RunFailure) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE run SET status = 'failed', error_message = $1, failure_code = $2, \
                        failure_summary = $3, failure_recommendation = $4, \
                        completed_at = $5, streamed_output = NULL \
                  WHERE id = $6 AND status IN ('queued', 'running')",
    )
    .bind(&failure.details)
    .bind(failure.code)
    .bind(failure.summary)
    .bind(failure.recommendation)
    .bind(Utc::now())
    .bind(run_id)
    .execute(&state.db)
    .await?;
    Ok(())
}

/// Record the tools an agent called during the run (one row each, in call
/// order). Best-effort: a failure here is logged and swallowed so it can't
/// fail an otherwise-good run.
async fn persist_tool_calls(state: &AppState, run_id: Uuid, calls: &[pydantic::ToolCall]) {
    // Clear any rows the live stream inserted, then write the authoritative set
    // (delete first so an empty authoritative list still reconciles live rows).
    let _ = sqlx::query("DELETE FROM run_tool_call WHERE run_id = $1")
        .bind(run_id)
        .execute(&state.db)
        .await;
    if calls.is_empty() {
        return;
    }
    let mut qb = sqlx::QueryBuilder::new(
        "INSERT INTO run_tool_call (run_id, ordinal, tool_name, ok, error_message, step_ordinal) ",
    );
    qb.push_values(calls.iter().enumerate(), |mut b, (i, c)| {
        b.push_bind(run_id)
            .push_bind(i as i32)
            .push_bind(c.name.as_str())
            .push_bind(c.ok)
            .push_bind(c.error.as_deref())
            .push_bind(c.step_ordinal);
    });
    if let Err(e) = qb.build().execute(&state.db).await {
        tracing::warn!(run_id = %run_id, ?e, "failed to persist run tool calls");
    }
}

/// Record per-step token usage (one row per model request). Best-effort, like
/// the tool-call log — a failure here is logged and swallowed.
async fn persist_run_steps(state: &AppState, run_id: Uuid, steps: &[pydantic::RunStep]) {
    // Clear any rows the live stream inserted, then write the authoritative set
    // (delete first so an empty authoritative list still reconciles live rows).
    let _ = sqlx::query("DELETE FROM run_step WHERE run_id = $1")
        .bind(run_id)
        .execute(&state.db)
        .await;
    if steps.is_empty() {
        return;
    }
    let mut qb = sqlx::QueryBuilder::new(
        "INSERT INTO run_step \
         (run_id, ordinal, summary, input_tokens, output_tokens, \
          cache_read_tokens, cache_write_tokens) ",
    );
    qb.push_values(steps.iter(), |mut b, s| {
        b.push_bind(run_id)
            .push_bind(s.ordinal)
            .push_bind(s.summary.as_deref())
            .push_bind(s.input_tokens)
            .push_bind(s.output_tokens)
            .push_bind(s.cache_read_tokens)
            .push_bind(s.cache_write_tokens);
    });
    if let Err(e) = qb.build().execute(&state.db).await {
        tracing::warn!(run_id = %run_id, ?e, "failed to persist run steps");
    }
}

// Slack's chat.postMessage caps text at 40k chars; keep replies readable
// and well under the limit.
const SLACK_TEXT_LIMIT: usize = 3500;

#[derive(sqlx::FromRow)]
struct SlackDeliveryRow {
    channel: String,
    thread_ts: Option<String>,
    bot_token: Vec<u8>,
    slack_app_id: Uuid,
}

/// Post a Slack-dispatched run's result back into the thread it came from.
/// Best-effort: no delivery row (the common case — most runs aren't from
/// Slack), an already-delivered row, an uninstalled app, or a Slack API
/// hiccup are all logged and swallowed so the run itself is never affected.
async fn deliver_slack_result(state: &AppState, run_id: Uuid, body: &str) {
    let row = match sqlx::query_as::<_, SlackDeliveryRow>(
        "SELECT d.channel, d.thread_ts, a.bot_token, a.id AS slack_app_id \
           FROM slack_delivery d \
           JOIN workspace_slack_app a ON a.id = d.slack_app_id \
          WHERE d.run_id = $1 AND d.delivered_at IS NULL AND a.bot_token IS NOT NULL",
    )
    .bind(run_id)
    .fetch_optional(&state.db)
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return,
        Err(e) => {
            tracing::warn!(run_id = %run_id, ?e, "slack delivery lookup failed");
            return;
        }
    };

    let token = match state.encryption_key.decrypt_aad(
        &row.bot_token,
        crate::crypto::aad::slack_secret(row.slack_app_id, "bot_token").as_bytes(),
    ) {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(run_id = %run_id, ?e, "slack bot token decrypt failed");
            return;
        }
    };

    let text: String = if body.chars().count() > SLACK_TEXT_LIMIT {
        let truncated: String = body.chars().take(SLACK_TEXT_LIMIT).collect();
        format!("{truncated}\n…(truncated)")
    } else {
        body.to_string()
    };

    let mut payload = serde_json::json!({ "channel": row.channel, "text": text });
    if let Some(ts) = &row.thread_ts {
        payload["thread_ts"] = serde_json::Value::String(ts.clone());
    }

    let resp = state
        .http
        .post("https://slack.com/api/chat.postMessage")
        .bearer_auth(&token)
        .json(&payload)
        .send()
        .await;
    match resp {
        Ok(r) => {
            // Slack returns 200 with {ok:false, error} on logical failures.
            match r.json::<serde_json::Value>().await {
                Ok(j) if j.get("ok").and_then(|v| v.as_bool()) == Some(true) => {}
                Ok(j) => {
                    tracing::warn!(
                        run_id = %run_id,
                        error = ?j.get("error"),
                        "slack chat.postMessage returned not-ok"
                    );
                }
                Err(e) => {
                    tracing::warn!(run_id = %run_id, ?e, "slack response parse failed");
                }
            }
        }
        Err(e) => {
            tracing::warn!(run_id = %run_id, ?e, "slack chat.postMessage send failed");
            return;
        }
    }

    if let Err(e) = sqlx::query("UPDATE slack_delivery SET delivered_at = now() WHERE run_id = $1")
        .bind(run_id)
        .execute(&state.db)
        .await
    {
        tracing::warn!(run_id = %run_id, ?e, "slack delivery mark failed");
    }
}
