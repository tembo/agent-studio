//! Subprocess wrapper that runs a Pydantic AgentSpec via the bundled
//! Python wrapper (api/scripts/run_pydantic.py, copied into the
//! runtime image at /usr/local/bin/run_pydantic.py — see
//! api/Dockerfile). The wrapper imports the real `pydantic_ai`
//! library and calls `Agent.from_spec(...).run(user_message)`, so
//! agents get the full Pydantic AI feature set (structured output,
//! model_settings, retries, instrumentation, etc.) instead of the
//! hand-rolled "send instructions + user message" path the Rust
//! runner used before.
//!
//! Auth: provider API keys are passed as environment variables. The
//! wrapper script doesn't know or care which provider is being
//! called; we set both AnthropicApiKey and OpenAiApiKey when they're
//! available so the dispatch happens inside pydantic-ai based on the
//! agent's `model:` field.
//!
//! Output protocol: the wrapper writes the agent's reply followed by
//! an optional `__TAS_USAGE__:{json}` sentinel line carrying token
//! counts. `parse_output` peels the sentinel off so the run row's
//! transcript stays clean and the token columns get populated.

use anyhow::{anyhow, Context};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const PYDANTIC_PY: &str = "/opt/pydantic-ai/bin/python3";
const PYDANTIC_SCRIPT: &str = "/usr/local/bin/run_pydantic.py";
const USAGE_SENTINEL: &str = "__TAS_USAGE__:";
const TOOLS_SENTINEL: &str = "__TAS_TOOLS__:";
const STEPS_SENTINEL: &str = "__TAS_STEPS__:";
// Streaming sentinels the wrapper flushes DURING the run (see run_pydantic.py).
const DELTA_SENTINEL: &str = "__TAS_DELTA__:";
const PROGRESS_SENTINEL: &str = "__TAS_PROGRESS__:";
const CHECKPOINT_SENTINEL: &str = "__TAS_CHECKPOINT__:";
const STALE_CONNECTION_MARKER: &str = "__TAS_STALE_CONNECTION__:";
const SCALEDOWN_SENTINEL: &str = "__TAS_SCALEDOWN__:";
// How often (at most) to flush reconstructed live output to the run row.
const STREAM_FLUSH_INTERVAL: Duration = Duration::from_millis(400);

#[derive(Debug, Deserialize)]
struct DeltaJson {
    #[serde(default)]
    t: String,
    #[serde(default)]
    step: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct ProgressJson {
    #[serde(default)]
    kind: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    step: Option<i32>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    ok: Option<bool>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    input_tokens: Option<i32>,
    #[serde(default)]
    output_tokens: Option<i32>,
}

/// One tool call the agent made during the run. `ok` is `Some(true)` on a
/// successful return, `Some(false)` on a tool error, and `None` when the
/// call never returned (the run ended/failed first). Extracted from the
/// wrapper's `__TAS_TOOLS__:`/`__TAS_STEPS__:` sentinel and persisted to
/// `run_tool_call`.
#[derive(Debug, Clone)]
pub struct ToolCall {
    pub name: String,
    pub ok: Option<bool>,
    pub error: Option<String>,
    /// Which model step (0-based) emitted this call, when known. `None` for
    /// runs from an older wrapper that only sent the flat `__TAS_TOOLS__` list.
    pub step_ordinal: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct ToolCallJson {
    name: String,
    #[serde(default)]
    ok: Option<bool>,
    #[serde(default)]
    error: Option<String>,
}

/// One model request ("step") in a run: its token usage plus the tool calls
/// the model emitted that turn. Extracted from the wrapper's `__TAS_STEPS__:`
/// sentinel and persisted to `run_step`.
#[derive(Debug, Clone)]
pub struct RunStep {
    pub ordinal: i32,
    /// The model's one-line "what I'm doing this step" note, when present.
    pub summary: Option<String>,
    pub input_tokens: Option<i32>,
    pub output_tokens: Option<i32>,
    pub cache_read_tokens: Option<i32>,
    pub cache_write_tokens: Option<i32>,
    pub tool_calls: Vec<ToolCall>,
}

#[derive(Debug, Deserialize)]
struct StepJson {
    step: i32,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    input_tokens: Option<i32>,
    #[serde(default)]
    output_tokens: Option<i32>,
    #[serde(default)]
    cache_read_tokens: Option<i32>,
    #[serde(default)]
    cache_write_tokens: Option<i32>,
    #[serde(default)]
    tool_calls: Vec<ToolCallJson>,
}

pub struct PydanticArgs<'a> {
    /// Raw spec content as it sits in the repo (YAML or JSON).
    pub spec_content: &'a str,
    /// Typed pydantic-ai ModelMessage history recovered from the latest
    /// acknowledged checkpoint. None for a first attempt.
    pub message_history: Option<&'a serde_json::Value>,
    /// Spec format — drives the wrapper's `--fmt` flag. The runner
    /// knows this from the file extension.
    pub spec_format: SpecFormat,
    /// Freeform user input. Empty string means "no input"; the
    /// wrapper defaults to "Hello." in that case so pydantic-ai's
    /// run loop has a prompt.
    pub user_message: &'a str,
    /// Workspace's OpenAI API key, if set. Wired into the
    /// subprocess as OPENAI_API_KEY so pydantic-ai's OpenAI client
    /// picks it up.
    pub openai_api_key: Option<&'a str>,
    /// Workspace's Anthropic API key, if set.
    pub anthropic_api_key: Option<&'a str>,
    /// Workspace's Composio API key, if set. Surfaced to the Python
    /// wrapper as `TAS_COMPOSIO_API_KEY`; the wrapper only uses it
    /// when the agent's spec declares `connections:`.
    pub composio_api_key: Option<&'a str>,
    /// Workspace's ScaleDown API key, if set. Surfaced as
    /// `TAS_SCALEDOWN_API_KEY`. The wrapper only uses it when the agent's spec
    /// opts in via `scaledown:` — it compresses bulky prompt/context through
    /// ScaleDown before frontier-model calls to cut tokens. None = no key.
    pub scaledown_api_key: Option<&'a str>,
    /// The Composio `user_id` to scope connections under. We use
    /// the workspace UUID — Composio's per-user isolation is the
    /// boundary between workspaces sharing one Composio key.
    /// Surfaced as `TAS_COMPOSIO_USER_ID`.
    pub composio_user_id: Option<&'a str>,
    /// JSON-encoded `{toolkit_slug: composio_connection_id}` map for
    /// the workspace's ACTIVE composio connections. Surfaced as
    /// `TAS_COMPOSIO_CONNECTED_ACCOUNTS`. Without this the runtime
    /// session reports the connections as inactive even though the
    /// workspace authorized them.
    pub composio_connected_accounts_json: Option<&'a str>,
    /// JSON-encoded `{provider: {name: {mcp_url, access_token}}}` map
    /// of the workspace's ACTIVE native-MCP connections, decrypted.
    /// Surfaced as `TAS_NATIVE_MCP_CONNECTIONS`. The Python wrapper
    /// builds one MCPServerStreamableHTTP toolset per declared
    /// (provider, name) slot, with the bearer token in
    /// Authorization headers.
    pub native_mcp_connections_json: Option<&'a str>,
    pub memory_json: Option<&'a str>,
    /// Sidecar Python module source (the agent's `tools_module:`),
    /// surfaced as `TAS_TOOLS_MODULE_CONTENT`. The wrapper execs it and
    /// exposes its `tools = [...]` export to the agent. None = no module.
    pub tools_module_content: Option<&'a str>,
    /// Agent Skills the agent opts into, as `{repoPath: content}` JSON,
    /// surfaced as `TAS_SKILLS_CONTENT`. The wrapper writes them to a temp
    /// dir and mounts pydantic-ai-skills. None = no skills.
    pub skills_content_json: Option<&'a str>,
    /// Workspace Secrets (the 3rd substrate) as flat `{slug: value}` JSON,
    /// surfaced as `TAS_SECRETS`. Sidecar tools read a value via
    /// `tas_tools.secret("<slug>")`. Only set when the run has a tools
    /// module (secrets feed Python tools, not the model). None = none.
    pub secrets_json: Option<&'a str>,
    /// Workspace + user the run executes under. Used to flip a
    /// `workspace_composio_connection` row's status to `STALE` if
    /// the Python wrapper detects Composio's
    /// `ToolRouterV2_InvalidConnectedAccountIds` error — the cached
    /// id no longer matches a connection that user owns.
    pub workspace_id: Uuid,
    pub acting_user_id: &'a str,
    /// The instant this run entered `running`, also persisted on the run row.
    /// Surfaced as `TAS_RUN_STARTED_AT` so the built-in clock tool returns one
    /// stable reference time throughout the run.
    pub run_started_at: DateTime<Utc>,
    /// The run row to stream partial output into while it's still running.
    pub run_id: Uuid,
    pub db: &'a sqlx::PgPool,
    /// Fired by the kill-run endpoint to cancel this run. When cancelled, the
    /// read loop SIGKILLs the wrapper subprocess and bails out.
    pub cancel: &'a CancellationToken,
    /// When true, the wrapper stubs declared delivery tools instead of
    /// executing them. Surfaced as `TAS_DRY_RUN=1`.
    pub is_dry_run: bool,
}

#[derive(Debug, Clone, Copy)]
pub enum SpecFormat {
    Yaml,
    Json,
}

impl SpecFormat {
    fn as_arg(self) -> &'static str {
        match self {
            SpecFormat::Yaml => "yaml",
            SpecFormat::Json => "json",
        }
    }
}

pub struct PydanticResult {
    /// Agent reply, with the usage sentinel stripped out.
    pub output: String,
    pub usage: Option<PydanticUsage>,
}

#[derive(Debug, Deserialize, Default)]
pub struct PydanticUsage {
    /// pydantic-ai 1.x publishes both `input_tokens` and the legacy
    /// `request_tokens` for compatibility; we deserialize both and
    /// the runner picks whichever it can find when writing the run
    /// row.
    #[serde(default)]
    pub input_tokens: Option<i32>,
    #[serde(default)]
    pub output_tokens: Option<i32>,
    #[serde(default)]
    pub request_tokens: Option<i32>,
    #[serde(default)]
    pub response_tokens: Option<i32>,
    /// Anthropic prompt-cache counters. `cache_write_tokens` (cache creation)
    /// and `cache_read_tokens` are separate from `input_tokens` (uncached) and
    /// priced differently — the cost estimate weights them ~1.25x / ~0.1x.
    #[serde(default)]
    pub cache_read_tokens: Option<i32>,
    #[serde(default)]
    pub cache_write_tokens: Option<i32>,
}

impl PydanticUsage {
    /// Best-effort (input, output) extraction across pydantic-ai
    /// version skew — newer releases use `input_tokens` /
    /// `output_tokens`, older ones use `request_tokens` /
    /// `response_tokens`. Either pair is acceptable; we don't need
    /// both.
    pub fn input_output(&self) -> Option<(i32, i32)> {
        let input = self.input_tokens.or(self.request_tokens)?;
        let output = self.output_tokens.or(self.response_tokens)?;
        Some((input, output))
    }
}

/// Spawn the wrapper, pipe the spec in, and collect its output. Separated
/// from `invoke` so the latter can return parsed tool calls even on a
/// non-zero exit (an infra error here means no tool data is available).
async fn spawn_and_wait(args: &PydanticArgs<'_>) -> anyhow::Result<std::process::Output> {
    let mut cmd = Command::new(PYDANTIC_PY);
    cmd.arg(PYDANTIC_SCRIPT)
        .arg("--fmt")
        .arg(args.spec_format.as_arg())
        .arg("--user-message")
        .arg(args.user_message)
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("TAS_CHECKPOINT_ACK", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // This run's id. The wrapper forwards it as the X-Tas-Orchestrator-Run
    // header on the tembo-agent-studio MCP toolset only, so a trigger_run call
    // made from inside this run records the orchestration relationship.
    cmd.env("TAS_RUN_ID", args.run_id.to_string());
    if args.is_dry_run {
        cmd.env("TAS_DRY_RUN", "1");
    }
    cmd.env(
        "TAS_RUN_STARTED_AT",
        args.run_started_at
            .to_rfc3339_opts(SecondsFormat::Millis, true),
    );

    // Provider keys flow in via env so the wrapper script doesn't
    // have to know which provider the agent's model: string points
    // to — pydantic-ai's own dispatch handles that.
    if let Some(k) = args.openai_api_key {
        cmd.env("OPENAI_API_KEY", k);
    }
    if let Some(k) = args.anthropic_api_key {
        cmd.env("ANTHROPIC_API_KEY", k);
    }
    // ScaleDown key — only consumed by the wrapper when the agent's spec opts in
    // via `scaledown:`. Set whenever the workspace has a key so any agent can
    // turn compression on.
    if let Some(k) = args.scaledown_api_key {
        cmd.env("TAS_SCALEDOWN_API_KEY", k);
    }
    // Composio creds — only used by the wrapper when the agent's
    // spec declares `connections:`. Always set both vars together
    // (workspace_id has no value to the wrapper without the API key)
    // or skip both.
    if let (Some(key), Some(uid)) = (args.composio_api_key, args.composio_user_id) {
        cmd.env("TAS_COMPOSIO_API_KEY", key);
        cmd.env("TAS_COMPOSIO_USER_ID", uid);
    }
    if let Some(accounts_json) = args.composio_connected_accounts_json {
        cmd.env("TAS_COMPOSIO_CONNECTED_ACCOUNTS", accounts_json);
    }
    // Native MCP — independent of Composio. Only set when the
    // workspace's acting user has any active native connections;
    // wrapper treats absence as "no native entries possible" so
    // missing slots fail with a clean message rather than a JSON
    // decode error.
    if let Some(native_json) = args.native_mcp_connections_json {
        cmd.env("TAS_NATIVE_MCP_CONNECTIONS", native_json);
    }
    if let Some(memory_json) = args.memory_json {
        cmd.env("TAS_MEMORY_CONNECTION", memory_json);
    }
    // Sidecar tools module source — wrapper execs it and exposes its
    // `tools = [...]` export. Only set when the agent declared one.
    if let Some(tools_module) = args.tools_module_content {
        cmd.env("TAS_TOOLS_MODULE_CONTENT", tools_module);
    }
    // Agent Skills — {repoPath: content} the wrapper materializes to a temp
    // dir and mounts via pydantic-ai-skills. Only set when the agent opts in.
    if let Some(skills) = args.skills_content_json {
        cmd.env("TAS_SKILLS_CONTENT", skills);
    }
    // Workspace Secrets — flat {slug: value} the sidecar tools read via
    // tas_tools.secret(). Only set when the run has a tools module.
    if let Some(secrets) = args.secrets_json {
        cmd.env("TAS_SECRETS", secrets);
    }

    let mut subprocess = cmd.spawn().context("failed to spawn pydantic-ai wrapper")?;

    // The first stdin line is the immutable launch envelope. Keep the pipe open
    // afterwards: each checkpoint blocks the Python graph until we acknowledge
    // that its history line has been handled on this channel.
    let mut checkpoint_ack = subprocess
        .stdin
        .take()
        .ok_or_else(|| anyhow!("pydantic-ai wrapper stdin not captured"))?;
    let envelope = serde_json::json!({
        "spec_content": args.spec_content,
        "message_history": args.message_history,
    });
    let mut envelope_bytes =
        serde_json::to_vec(&envelope).context("failed to serialize pydantic-ai runner input")?;
    envelope_bytes.push(b'\n');
    checkpoint_ack
        .write_all(&envelope_bytes)
        .await
        .context("failed to write pydantic-ai runner input")?;

    let stdout = subprocess
        .stdout
        .take()
        .ok_or_else(|| anyhow!("pydantic-ai wrapper stdout not captured"))?;
    let stderr = subprocess
        .stderr
        .take()
        .ok_or_else(|| anyhow!("pydantic-ai wrapper stderr not captured"))?;

    // Drain stderr concurrently — a chatty wrapper would otherwise deadlock on
    // a full stderr pipe while we're blocked reading stdout. We also forward
    // each line to the api's own logs as it arrives: the wrapper + sidecars
    // print operational diagnostics (e.g. `[scaledown]`, `[linkedin]`) to
    // stderr, and without this they were only ever surfaced on FAILURE (the
    // buffer feeds the error message) — invisible on successful runs. Lines are
    // still accumulated into the buffer for that failure path.
    let stderr_run_id = args.run_id;
    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let mut rd = BufReader::new(stderr);
        let mut line = Vec::new();
        loop {
            line.clear();
            match rd.read_until(b'\n', &mut line).await {
                Ok(0) => break,
                Ok(_) => {
                    buf.extend_from_slice(&line);
                    let text = String::from_utf8_lossy(&line);
                    let trimmed = text.trim_end();
                    if !trimmed.is_empty() {
                        tracing::info!(run_id = %stderr_run_id, "wrapper: {trimmed}");
                    }
                }
                Err(_) => break,
            }
        }
        buf
    });

    // Read stdout line by line: `full` reconstructs the whole stream for the
    // authoritative final parse; the delta/progress sentinels drive live writes
    // to run_step / run_tool_call so the run page builds the step table as work
    // happens (text per step, tool calls + their results, per-step tokens).
    let mut full = String::new();
    let mut reader = BufReader::new(stdout);
    let mut line_buf: Vec<u8> = Vec::new();
    let mut last_flush = tokio::time::Instant::now();
    // Resume after the live rows preserved from the previous process. The
    // terminal authoritative history reconciliation will rewrite the complete
    // set, but live inserts must not collide while this attempt is running.
    let mut tool_ordinal: i32 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(ordinal) + 1, 0) FROM run_tool_call WHERE run_id = $1",
    )
    .bind(args.run_id)
    .fetch_one(args.db)
    .await
    .unwrap_or(0);
    let mut id_to_ordinal: HashMap<String, i32> = HashMap::new();
    let mut steps_seen: HashSet<i32> = HashSet::new();
    // Per-step accumulated text (the model's narration / final answer) and which
    // steps changed since the last debounced flush of run_step.summary.
    let mut step_text: HashMap<i32, String> = HashMap::new();
    let mut dirty_steps: HashSet<i32> = HashSet::new();

    loop {
        line_buf.clear();
        let n = tokio::select! {
            // Check cancellation first so a kill takes effect even under a
            // steady stream of output.
            biased;
            _ = args.cancel.cancelled() => {
                // User killed the run: SIGKILL the wrapper (and its model/tool
                // subprocesses via the process group it leads) and bail. The
                // run row was already written to 'cancelled' by the endpoint.
                let _ = subprocess.start_kill();
                anyhow::bail!("run cancelled by user");
            }
            res = reader.read_until(b'\n', &mut line_buf) => {
                res.context("reading pydantic-ai wrapper stdout")?
            }
        };
        if n == 0 {
            break;
        }
        let line = String::from_utf8_lossy(&line_buf);
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if let Some(json) = trimmed.strip_prefix(CHECKPOINT_SENTINEL) {
            persist_checkpoint(args.db, args.run_id, json).await;
            checkpoint_ack
                .write_all(b"checkpoint\n")
                .await
                .context("acknowledging pydantic-ai checkpoint")?;
            continue;
        }
        full.push_str(&line);
        if let Some(json) = trimmed.strip_prefix(DELTA_SENTINEL) {
            if let Ok(d) = serde_json::from_str::<DeltaJson>(json) {
                let step = d.step.unwrap_or(0).max(0);
                if steps_seen.insert(step) {
                    live_ensure_step(args.db, args.run_id, step).await;
                }
                step_text.entry(step).or_default().push_str(&d.t);
                dirty_steps.insert(step);
            }
        } else if let Some(json) = trimmed.strip_prefix(PROGRESS_SENTINEL) {
            if let Ok(p) = serde_json::from_str::<ProgressJson>(json) {
                match p.kind.as_str() {
                    "tool_call" if !p.name.is_empty() => {
                        let step = p.step.unwrap_or(0).max(0);
                        if steps_seen.insert(step) {
                            live_ensure_step(args.db, args.run_id, step).await;
                        }
                        let ordinal = tool_ordinal;
                        tool_ordinal += 1;
                        if let Some(id) = p.id.clone() {
                            id_to_ordinal.insert(id, ordinal);
                        }
                        live_insert_tool_call(args.db, args.run_id, ordinal, &p.name, step).await;
                    }
                    "tool_result" => {
                        if let Some(ordinal) = p.id.as_deref().and_then(|id| id_to_ordinal.get(id))
                        {
                            live_update_tool_result(
                                args.db,
                                args.run_id,
                                *ordinal,
                                p.ok,
                                p.error.as_deref(),
                            )
                            .await;
                        }
                    }
                    "step_usage" => {
                        let step = p.step.unwrap_or(0).max(0);
                        if steps_seen.insert(step) {
                            live_ensure_step(args.db, args.run_id, step).await;
                        }
                        live_update_step_usage(
                            args.db,
                            args.run_id,
                            step,
                            p.input_tokens,
                            p.output_tokens,
                        )
                        .await;
                    }
                    _ => {}
                }
            }
        }
        if !dirty_steps.is_empty() && last_flush.elapsed() >= STREAM_FLUSH_INTERVAL {
            for step in dirty_steps.drain() {
                if let Some(text) = step_text.get(&step) {
                    live_update_step_text(args.db, args.run_id, step, text).await;
                }
            }
            last_flush = tokio::time::Instant::now();
        }
    }
    // Final flush of any step text not yet written (the terminal __TAS_STEPS__
    // parse reconciles authoritatively right after).
    for step in dirty_steps.drain() {
        if let Some(text) = step_text.get(&step) {
            live_update_step_text(args.db, args.run_id, step, text).await;
        }
    }

    let status = subprocess
        .wait()
        .await
        .context("pydantic-ai wrapper failed to complete")?;
    let stderr_buf = stderr_task.await.unwrap_or_default();

    Ok(std::process::Output {
        status,
        stdout: full.into_bytes(),
        stderr: stderr_buf,
    })
}

// Live step-table writes (best-effort; errors swallowed). The end-of-run
// persist_run_steps / persist_tool_calls DELETE + reinsert the authoritative
// set, so these only have to be good enough to render the table building.
async fn live_ensure_step(db: &sqlx::PgPool, run_id: Uuid, step: i32) {
    let _ = sqlx::query(
        "INSERT INTO run_step (run_id, ordinal) VALUES ($1, $2) \
         ON CONFLICT (run_id, ordinal) DO NOTHING",
    )
    .bind(run_id)
    .bind(step)
    .execute(db)
    .await;
}

async fn persist_checkpoint(db: &sqlx::PgPool, run_id: Uuid, raw: &str) {
    let history = match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(serde_json::Value::Array(items)) => serde_json::Value::Array(items),
        Ok(_) => {
            tracing::warn!(run_id = %run_id, "ignored non-array run checkpoint");
            return;
        }
        Err(e) => {
            tracing::warn!(run_id = %run_id, ?e, "failed to parse run checkpoint");
            return;
        }
    };
    if let Err(e) = sqlx::query(
        "UPDATE run SET message_history = $1, checkpointed_at = now() \
         WHERE id = $2 AND status = 'running'",
    )
    .bind(history)
    .bind(run_id)
    .execute(db)
    .await
    {
        tracing::warn!(run_id = %run_id, ?e, "failed to persist run checkpoint");
    }
}

async fn live_insert_tool_call(
    db: &sqlx::PgPool,
    run_id: Uuid,
    ordinal: i32,
    name: &str,
    step: i32,
) {
    let _ = sqlx::query(
        "INSERT INTO run_tool_call (run_id, ordinal, tool_name, step_ordinal) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(run_id)
    .bind(ordinal)
    .bind(name)
    .bind(step)
    .execute(db)
    .await;
}

async fn live_update_tool_result(
    db: &sqlx::PgPool,
    run_id: Uuid,
    ordinal: i32,
    ok: Option<bool>,
    error: Option<&str>,
) {
    let _ = sqlx::query(
        "UPDATE run_tool_call SET ok = $1, error_message = $2 \
         WHERE run_id = $3 AND ordinal = $4",
    )
    .bind(ok)
    .bind(error)
    .bind(run_id)
    .bind(ordinal)
    .execute(db)
    .await;
}

async fn live_update_step_text(db: &sqlx::PgPool, run_id: Uuid, step: i32, text: &str) {
    let _ = sqlx::query("UPDATE run_step SET summary = $1 WHERE run_id = $2 AND ordinal = $3")
        .bind(text)
        .bind(run_id)
        .bind(step)
        .execute(db)
        .await;
}

async fn live_update_step_usage(
    db: &sqlx::PgPool,
    run_id: Uuid,
    step: i32,
    input_tokens: Option<i32>,
    output_tokens: Option<i32>,
) {
    let _ = sqlx::query(
        "UPDATE run_step SET input_tokens = $1, output_tokens = $2 \
         WHERE run_id = $3 AND ordinal = $4",
    )
    .bind(input_tokens)
    .bind(output_tokens)
    .bind(run_id)
    .bind(step)
    .execute(db)
    .await;
}

/// Run the wrapper and return the parsed result plus the tool calls the
/// agent made. Tool calls are returned on BOTH the success and failure
/// path (the wrapper emits them either way) so a failed/truncated run still
/// records which tools it touched — the most useful case for debugging.
/// An `Err` here is a *run* failure (non-zero exit or infra error); the
/// caller marks the run failed, but still persists the returned tool calls.
pub async fn invoke(
    args: PydanticArgs<'_>,
) -> (anyhow::Result<PydanticResult>, Vec<ToolCall>, Vec<RunStep>) {
    let output = match spawn_and_wait(&args).await {
        Ok(o) => o,
        Err(e) => return (Err(e), Vec::new(), Vec::new()),
    };

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    // ScaleDown compression totals, if the wrapper compressed anything. Persist
    // directly to the run row (best-effort) so the run detail can show what
    // compression saved — on both success and failure paths.
    if let Some(sd) = extract_scaledown(&stdout) {
        persist_scaledown(args.db, args.run_id, sd).await;
    }
    // Prefer the per-step breakdown (carries token usage + step_ordinal per
    // call); fall back to the flat tool list for output from an older wrapper.
    let steps = extract_steps(&stdout);
    let tool_calls = if steps.is_empty() {
        extract_tool_calls(&stdout)
    } else {
        flatten_step_tool_calls(&steps)
    };

    if !output.status.success() {
        // Pull out any stale-connection markers the wrapper emitted
        // before bailing — they tell us *which* slot Composio's API
        // refused. We flip those rows to STALE so the sidebar shows
        // a Connect alert next time the user lands, and the failure
        // reason becomes actionable ("reconnect X") instead of a
        // raw 400.
        let (stale_slots, cleaned_stderr) = parse_stale_markers(&stderr);
        for slot in &stale_slots {
            mark_connection_stale(
                args.db,
                args.workspace_id,
                args.acting_user_id,
                &slot.toolkit,
                &slot.name,
            )
            .await;
        }

        if !stale_slots.is_empty() {
            // Friendlier replacement message — the raw Composio
            // payload still rides along after a separator so a
            // determined operator can see the upstream error.
            let labels = stale_slots
                .iter()
                .map(|s| {
                    if s.name == "default" {
                        s.toolkit.clone()
                    } else {
                        format!("{}/{}", s.toolkit, s.name)
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
            return (
                Err(anyhow!(
                    "Composio rejected the cached connection for: {labels}. \
                     Open the Connections page, click Disconnect on that \
                     slot, then Reconnect to re-authorize.\n\n\
                     ──── raw error ────\n{}",
                    cleaned_stderr
                        .trim()
                        .chars()
                        .take(16_000)
                        .collect::<String>()
                )),
                tool_calls,
                steps,
            );
        }

        let snippet = if stderr.trim().is_empty() {
            stdout.clone()
        } else {
            stderr.clone()
        };
        // Cap at 16 KB — enough for a full Python traceback with
        // multiple call sites plus the exception message. The DB
        // column is TEXT (no length limit on Postgres's side) and
        // the run-detail UI scrolls long messages, so the cap is
        // here only to keep one runaway error from filling a row.
        return (
            Err(anyhow!(
                "pydantic-ai wrapper exited with status {}: {}",
                output.status,
                snippet.trim().chars().take(16_000).collect::<String>()
            )),
            tool_calls,
            steps,
        );
    }

    (Ok(parse_output(&stdout)), tool_calls, steps)
}

#[derive(Debug, Deserialize)]
struct StaleConnectionMarker {
    toolkit: String,
    name: String,
    #[serde(default)]
    #[allow(dead_code)]
    connection_id: String,
}

/// Pull every `__TAS_STALE_CONNECTION__:[json]` line out of stderr
/// and return (parsed markers, stderr with those lines removed).
/// Each marker line carries a JSON array of {toolkit, name,
/// connection_id} entries (the wrapper sometimes flags multiple
/// slots in one go when several share a stale id).
fn parse_stale_markers(stderr: &str) -> (Vec<StaleConnectionMarker>, String) {
    let mut markers: Vec<StaleConnectionMarker> = Vec::new();
    let mut cleaned: Vec<&str> = Vec::new();
    for line in stderr.lines() {
        if let Some(payload) = line.trim().strip_prefix(STALE_CONNECTION_MARKER) {
            match serde_json::from_str::<Vec<StaleConnectionMarker>>(payload) {
                Ok(parsed) => markers.extend(parsed),
                Err(e) => {
                    tracing::warn!(
                        ?e,
                        "stale-connection marker failed to parse — keeping line in stderr"
                    );
                    cleaned.push(line);
                }
            }
        } else {
            cleaned.push(line);
        }
    }
    (markers, cleaned.join("\n"))
}

async fn mark_connection_stale(
    db: &sqlx::PgPool,
    workspace_id: Uuid,
    user_id: &str,
    toolkit: &str,
    name: &str,
) {
    // Best-effort. A failure here means the next run will hit the
    // same Composio 400 — annoying but not catastrophic, and the
    // run's failure reason already names the slot for the user.
    let res = sqlx::query(
        "UPDATE workspace_composio_connection
            SET status = 'STALE', updated_at = NOW()
          WHERE workspace_id = $1 AND user_id = $2
            AND toolkit_slug = $3 AND name = $4",
    )
    .bind(workspace_id)
    .bind(user_id)
    .bind(toolkit)
    .bind(name)
    .execute(db)
    .await;
    if let Err(e) = res {
        tracing::warn!(?e, %toolkit, %name, "failed to mark composio connection stale");
    }
}

/// Strip the trailing `__TAS_USAGE__:{json}` sentinel (if present)
/// out of the wrapper's stdout, returning the user-facing output
/// and the parsed usage payload. A missing or malformed sentinel
/// is non-fatal — we just record no usage rather than failing the
/// run because token counts aren't critical.
fn parse_output(stdout: &str) -> PydanticResult {
    let mut output_lines: Vec<&str> = Vec::new();
    let mut usage = None;
    for line in stdout.lines() {
        if let Some(json_part) = line.strip_prefix(USAGE_SENTINEL) {
            if let Ok(parsed) = serde_json::from_str::<PydanticUsage>(json_part) {
                usage = Some(parsed);
            }
            // Drop the sentinel line either way — never let it leak
            // into the user-facing transcript.
            continue;
        }
        // Tool-call + step sentinels are parsed separately
        // (extract_tool_calls / extract_steps); the streaming delta/progress
        // sentinels were already consumed live. Keep all of them out of the
        // user-facing transcript (the authoritative output is the plain text
        // the wrapper printed at the end).
        if line.starts_with(TOOLS_SENTINEL)
            || line.starts_with(STEPS_SENTINEL)
            || line.starts_with(DELTA_SENTINEL)
            || line.starts_with(PROGRESS_SENTINEL)
            || line.starts_with(CHECKPOINT_SENTINEL)
            || line.starts_with(SCALEDOWN_SENTINEL)
        {
            continue;
        }
        output_lines.push(line);
    }
    // Re-join with `\n` and trim trailing blank lines so the run
    // row's output column doesn't carry rendering noise.
    let joined = output_lines.join("\n");
    PydanticResult {
        output: joined.trim_end().to_string(),
        usage,
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
struct ScaleDownSummary {
    #[serde(default)]
    original_tokens: i32,
    #[serde(default)]
    compressed_tokens: i32,
    #[serde(default)]
    blocks: i32,
}

/// Pull the `__TAS_SCALEDOWN__:{...}` sentinel (ScaleDown compression totals)
/// from the wrapper's stdout. Absent or malformed is non-fatal.
fn extract_scaledown(stdout: &str) -> Option<ScaleDownSummary> {
    for line in stdout.lines() {
        if let Some(json_part) = line.strip_prefix(SCALEDOWN_SENTINEL) {
            if let Ok(parsed) = serde_json::from_str::<ScaleDownSummary>(json_part) {
                if parsed.blocks > 0 {
                    return Some(parsed);
                }
            }
        }
    }
    None
}

/// Persist the compression totals on the run row. Best-effort — errors are
/// swallowed (the columns are display-only and must never fail a run).
async fn persist_scaledown(db: &sqlx::PgPool, run_id: Uuid, sd: ScaleDownSummary) {
    let _ = sqlx::query(
        "UPDATE run SET scaledown_original_tokens = $1, \
                        scaledown_compressed_tokens = $2 \
                  WHERE id = $3",
    )
    .bind(sd.original_tokens)
    .bind(sd.compressed_tokens)
    .bind(run_id)
    .execute(db)
    .await;
}

/// Pull the `__TAS_TOOLS__:[...]` sentinel (a JSON array of
/// `{name, ok, error}`) out of the wrapper's stdout. Absent or malformed
/// is non-fatal — we just record no tool calls.
fn extract_tool_calls(stdout: &str) -> Vec<ToolCall> {
    for line in stdout.lines() {
        if let Some(json_part) = line.strip_prefix(TOOLS_SENTINEL) {
            if let Ok(parsed) = serde_json::from_str::<Vec<ToolCallJson>>(json_part) {
                return parsed
                    .into_iter()
                    .map(|t| ToolCall {
                        name: t.name,
                        ok: t.ok,
                        error: t.error,
                        step_ordinal: None,
                    })
                    .collect();
            }
        }
    }
    Vec::new()
}

/// Pull the `__TAS_STEPS__:[...]` sentinel (a JSON array of per-model-request
/// usage + the tool calls each request emitted) out of the wrapper's stdout.
/// Absent or malformed is non-fatal — we just record no steps.
fn extract_steps(stdout: &str) -> Vec<RunStep> {
    for line in stdout.lines() {
        if let Some(json_part) = line.strip_prefix(STEPS_SENTINEL) {
            if let Ok(parsed) = serde_json::from_str::<Vec<StepJson>>(json_part) {
                return parsed
                    .into_iter()
                    .map(|s| RunStep {
                        ordinal: s.step,
                        summary: s
                            .summary
                            .map(|t| t.trim().to_string())
                            .filter(|t| !t.is_empty()),
                        input_tokens: s.input_tokens,
                        output_tokens: s.output_tokens,
                        cache_read_tokens: s.cache_read_tokens,
                        cache_write_tokens: s.cache_write_tokens,
                        tool_calls: s
                            .tool_calls
                            .into_iter()
                            .map(|t| ToolCall {
                                name: t.name,
                                ok: t.ok,
                                error: t.error,
                                step_ordinal: Some(s.step),
                            })
                            .collect(),
                    })
                    .collect();
            }
        }
    }
    Vec::new()
}

/// Flatten the tool calls across steps into a single call-ordered list,
/// preserving each call's originating step_ordinal. Steps arrive in request
/// order and their calls in emission order, so this is the run's call order.
fn flatten_step_tool_calls(steps: &[RunStep]) -> Vec<ToolCall> {
    steps.iter().flat_map(|s| s.tool_calls.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_output_with_no_sentinel() {
        let stdout = "Hello there!\nHow can I help?\n";
        let result = parse_output(stdout);
        assert_eq!(result.output, "Hello there!\nHow can I help?");
        assert!(result.usage.is_none());
    }

    #[test]
    fn strips_usage_sentinel_and_keeps_output_clean() {
        let stdout = "Hello there!\n__TAS_USAGE__:{\"input_tokens\":42,\"output_tokens\":7}\n";
        let result = parse_output(stdout);
        assert_eq!(result.output, "Hello there!");
        let usage = result.usage.expect("usage parsed");
        assert_eq!(usage.input_output(), Some((42, 7)));
    }

    #[test]
    fn tolerates_legacy_request_response_token_names() {
        let stdout = "ok\n__TAS_USAGE__:{\"request_tokens\":11,\"response_tokens\":3}\n";
        let result = parse_output(stdout);
        let usage = result.usage.expect("usage parsed");
        assert_eq!(usage.input_output(), Some((11, 3)));
    }

    #[test]
    fn malformed_sentinel_is_silently_dropped() {
        let stdout = "ok\n__TAS_USAGE__:not-json\n";
        let result = parse_output(stdout);
        assert_eq!(result.output, "ok");
        assert!(result.usage.is_none());
    }

    #[test]
    fn extracts_tool_calls_and_keeps_output_clean() {
        let stdout = "Done.\n\
            __TAS_TOOLS__:[{\"name\":\"LINEAR_LIST\",\"ok\":true,\"error\":null},\
            {\"name\":\"SLACK_SEND\",\"ok\":false,\"error\":\"channel_not_found\"},\
            {\"name\":\"get_me\",\"ok\":null}]\n\
            __TAS_USAGE__:{\"input_tokens\":5,\"output_tokens\":2}\n";
        let calls = extract_tool_calls(stdout);
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0].name, "LINEAR_LIST");
        assert_eq!(calls[0].ok, Some(true));
        assert_eq!(calls[1].ok, Some(false));
        assert_eq!(calls[1].error.as_deref(), Some("channel_not_found"));
        assert_eq!(calls[2].ok, None);
        // Both sentinels stripped from the transcript.
        assert_eq!(parse_output(stdout).output, "Done.");
    }

    #[test]
    fn no_tools_sentinel_yields_empty() {
        assert!(extract_tool_calls("just output\n").is_empty());
    }

    #[test]
    fn extracts_steps_with_usage_and_tool_calls() {
        let stdout = "Done.\n\
            __TAS_STEPS__:[\
            {\"step\":0,\"input_tokens\":1200,\"output_tokens\":40,\
             \"tool_calls\":[{\"name\":\"LINEAR_LIST\",\"ok\":true,\"error\":null}]},\
            {\"step\":1,\"input_tokens\":1800,\"output_tokens\":12,\
             \"cache_read_tokens\":900,\"tool_calls\":[]}]\n";
        let steps = extract_steps(stdout);
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].ordinal, 0);
        assert_eq!(steps[0].input_tokens, Some(1200));
        assert_eq!(steps[0].output_tokens, Some(40));
        assert_eq!(steps[0].tool_calls.len(), 1);
        assert_eq!(steps[0].tool_calls[0].name, "LINEAR_LIST");
        assert_eq!(steps[0].tool_calls[0].step_ordinal, Some(0));
        assert_eq!(steps[1].cache_read_tokens, Some(900));
        // Flatten keeps call order + step linkage; step 1 had no calls.
        let flat = flatten_step_tool_calls(&steps);
        assert_eq!(flat.len(), 1);
        assert_eq!(flat[0].step_ordinal, Some(0));
        // The steps sentinel is stripped from the user-facing transcript.
        assert_eq!(parse_output(stdout).output, "Done.");
    }

    #[test]
    fn no_steps_sentinel_yields_empty() {
        assert!(extract_steps("just output\n").is_empty());
    }

    #[test]
    fn strips_streaming_sentinels_from_transcript() {
        // Delta/progress lines stream live and must never leak into the final
        // output — only the plain end-of-run text survives.
        let stdout = "__TAS_PROGRESS__:{\"kind\":\"tool_call\",\"name\":\"list-records\"}\n\
            __TAS_DELTA__:{\"t\":\"Hel\"}\n\
            __TAS_DELTA__:{\"t\":\"lo.\"}\n\
            __TAS_CHECKPOINT__:[]\n\
            Hello.\n\
            __TAS_USAGE__:{\"input_tokens\":5,\"output_tokens\":2}\n";
        let result = parse_output(stdout);
        assert_eq!(result.output, "Hello.");
    }
}
