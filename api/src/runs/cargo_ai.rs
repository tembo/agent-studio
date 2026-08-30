//! Subprocess wrapper that runs a Cargo AI agent via the bundled
//! `cargo-ai` CLI (installed into the runtime image at
//! /usr/local/bin/cargo-ai, see api/Dockerfile).
//!
//! Strategy: the on-disk agent file is already cargo-ai's native
//! schema (version + inputs + agent_schema + actions). We accept it
//! as-is, inject two small extras, and pipe it to `cargo-ai run
//! --stdin`:
//!
//!   1. The freeform user_message (if any) is appended to inputs[]
//!      as a trailing text block so chat-thread runs flow naturally.
//!   2. A synthetic `_tas_emit_output` action is appended to
//!      actions[] so the validated LLM response reaches stdout.
//!      cargo-ai 0.3 validates against agent_schema but doesn't
//!      print the result; once our upstream `--emit-output` PR
//!      lands we delete this synthesis and pass the flag instead.
//!
//! Anything else in the file — customer-authored actions[] with
//! JSONLogic, exec steps, multi-step inputs[], etc. — passes through
//! unchanged.

use anyhow::{anyhow, bail, Context};
use serde_json::{json, Value};
use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// Cargo AI's strict schema version. Injected only when the source
/// file omits `version`; if the file declares its own we respect it.
/// Bump together with the cargo-ai version in api/Dockerfile.
const CARGO_AI_SCHEMA_VERSION: &str = "2026-03-03.r1";

const CARGO_AI_BIN: &str = "/usr/local/bin/cargo-ai";

pub struct CargoAiArgs<'a> {
    /// The raw cargo-ai native agent JSON as it sits in the repo —
    /// e.g. `agents/cargo-ai/hello-world.json`. Passed through to
    /// cargo-ai with only the two injections described in the
    /// module docs.
    pub spec_json: &'a str,
    /// The provider half of `runtime_vars.model` (e.g. "openai"). Maps
    /// to cargo-ai's `--server` flag.
    pub provider: &'a str,
    /// The model half of `runtime_vars.model` (e.g. "gpt-4o-mini").
    pub model: &'a str,
    /// Provider API key — passed to cargo-ai as `--token`, bypassing
    /// its profile / keychain auth flow.
    pub api_key: &'a str,
    /// Optional freeform user input to append as an extra `inputs[]`
    /// block. Empty string means "no user input"; cargo-ai treats
    /// what's in the JSON as the full prompt.
    pub user_message: &'a str,
}

pub struct CargoAiResult {
    pub stdout: String,
}

pub async fn invoke(args: CargoAiArgs<'_>) -> anyhow::Result<CargoAiResult> {
    let prepared = prepare_spec(args.spec_json, args.user_message)
        .context("couldn't prepare Cargo AI spec for cargo-ai")?;

    let mut child = Command::new(CARGO_AI_BIN)
        .arg("run")
        .arg("--stdin")
        .arg("--server")
        .arg(args.provider)
        .arg("--model")
        .arg(args.model)
        .arg("--token")
        .arg(args.api_key)
        .arg("--no-update-check")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("failed to spawn cargo-ai")?;

    {
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| anyhow!("cargo-ai child stdin not captured"))?;
        stdin
            .write_all(prepared.as_bytes())
            .await
            .context("failed to write prepared spec to cargo-ai stdin")?;
    }

    let output = child
        .wait_with_output()
        .await
        .context("cargo-ai process failed to complete")?;

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    if !output.status.success() {
        // Surface whatever cargo-ai wrote to stderr so the run row's
        // failure reason has actionable detail, not just an exit
        // code.
        let snippet = if stderr.trim().is_empty() {
            stdout.clone()
        } else {
            stderr.clone()
        };
        bail!(
            "cargo-ai exited with status {}: {}",
            output.status,
            snippet.trim().chars().take(16_000).collect::<String>()
        );
    }

    Ok(CargoAiResult { stdout })
}

/// Take cargo-ai native JSON, inject the two extras the runner owns
/// (user_message + emit action), strip studio-only metadata cargo-ai
/// doesn't know, and return the serialised payload ready for stdin.
fn prepare_spec(native_json: &str, user_message: &str) -> anyhow::Result<String> {
    let parsed: Value =
        serde_json::from_str(native_json).context("agent JSON was not valid JSON")?;
    let mut obj = match parsed {
        Value::Object(m) => m,
        _ => bail!("agent JSON must be a top-level object"),
    };

    // Studio-only fields cargo-ai doesn't validate — strip so they
    // don't trip schema enforcement on its end.
    obj.remove("name");
    obj.remove("description");
    obj.remove("runtime_vars");

    obj.entry("version")
        .or_insert_with(|| json!(CARGO_AI_SCHEMA_VERSION));

    if !obj.contains_key("agent_schema") {
        bail!("agent JSON is missing `agent_schema` (required by cargo-ai)");
    }

    // Append the user message as a trailing text input. Cargo-ai
    // treats every inputs[] entry as context fed to the LLM, so
    // appending preserves the customer's prompt ordering.
    if !user_message.is_empty() {
        let inputs = obj
            .entry("inputs")
            .or_insert_with(|| Value::Array(Vec::new()));
        let arr = inputs
            .as_array_mut()
            .ok_or_else(|| anyhow!("agent JSON's `inputs` is not an array"))?;
        arr.push(json!({ "type": "text", "text": format!("User input: {}", user_message) }));
    }

    // Compute the emit action before grabbing a mutable borrow of
    // actions[]. Customer actions[] must keep firing (their
    // exec/etc. side-effects) — we only append.
    let emit_action = synthesize_emit_action(obj.get("agent_schema"));

    // cargo-ai's schema requires `actions` to always be present
    // (even an empty array). Ensure it exists, then append the emit
    // action if we synthesised one.
    let actions = obj
        .entry("actions")
        .or_insert_with(|| Value::Array(Vec::new()));
    let arr = actions
        .as_array_mut()
        .ok_or_else(|| anyhow!("agent JSON's `actions` is not an array"))?;
    if let Some(action) = emit_action {
        arr.push(action);
    }

    Ok(Value::Object(obj).to_string())
}

/// Build a single always-true cargo-ai action that prints one line
/// per top-level field of agent_schema (`field: value`). The runner
/// extracts these lines from stdout to recover the model's reply.
/// Returns None when agent_schema has no `properties` block —
/// cargo-ai already handles empty-output agents on its own.
fn synthesize_emit_action(agent_schema: Option<&Value>) -> Option<Value> {
    let props = agent_schema?
        .get("properties")
        .and_then(|p| p.as_object())?;

    if props.is_empty() {
        return None;
    }

    let mut steps = Vec::with_capacity(props.len());
    for (field_name, _) in props {
        // `printf` is portable across the bookworm-slim runtime
        // image; the first arg is the format string, the rest fill
        // the placeholders.
        steps.push(json!({
            "kind": "exec",
            "program": "printf",
            "args": ["%s: %s\n", field_name, { "var": field_name }],
        }));
    }

    Some(json!({
        "name": "_tas_emit_output",
        "logic": { "==": [1, 1] },
        "run": steps,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passthrough_preserves_native_shape() {
        let native = serde_json::json!({
            "version": "2026-03-03.r1",
            "inputs": [
                { "type": "text", "text": "Greet warmly." }
            ],
            "agent_schema": {
                "type": "object",
                "properties": { "greeting": { "type": "string" } }
            },
            "actions": [
                {
                    "name": "notify",
                    "logic": { "==": [1, 1] },
                    "run": [
                        { "kind": "exec", "program": "echo", "args": [{ "var": "greeting" }] }
                    ]
                }
            ]
        })
        .to_string();
        let prepared = prepare_spec(&native, "").unwrap();
        let parsed: Value = serde_json::from_str(&prepared).unwrap();
        assert_eq!(parsed["version"], "2026-03-03.r1");
        let inputs = parsed["inputs"].as_array().unwrap();
        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0]["text"], "Greet warmly.");
        // Customer's action is preserved; emit action appended.
        let actions = parsed["actions"].as_array().unwrap();
        assert_eq!(actions.len(), 2);
        assert_eq!(actions[0]["name"], "notify");
        assert_eq!(actions[1]["name"], "_tas_emit_output");
    }

    #[test]
    fn appends_user_message_to_inputs() {
        let native = serde_json::json!({
            "inputs": [{ "type": "text", "text": "Greet warmly." }],
            "agent_schema": { "properties": { "greeting": { "type": "string" } } },
        })
        .to_string();
        let prepared = prepare_spec(&native, "Hi there!").unwrap();
        let parsed: Value = serde_json::from_str(&prepared).unwrap();
        let inputs = parsed["inputs"].as_array().unwrap();
        assert_eq!(inputs.len(), 2);
        assert_eq!(inputs[1]["type"], "text");
        assert_eq!(inputs[1]["text"], "User input: Hi there!");
    }

    #[test]
    fn injects_version_when_missing() {
        let native = serde_json::json!({
            "inputs": [{ "type": "text", "text": "Hi" }],
            "agent_schema": { "properties": { "reply": { "type": "string" } } },
        })
        .to_string();
        let prepared = prepare_spec(&native, "").unwrap();
        let parsed: Value = serde_json::from_str(&prepared).unwrap();
        assert_eq!(parsed["version"], CARGO_AI_SCHEMA_VERSION);
    }

    #[test]
    fn respects_caller_supplied_version() {
        let native = serde_json::json!({
            "version": "2099-99-99.rX",
            "inputs": [{ "type": "text", "text": "Hi" }],
            "agent_schema": { "properties": { "reply": { "type": "string" } } },
        })
        .to_string();
        let prepared = prepare_spec(&native, "").unwrap();
        let parsed: Value = serde_json::from_str(&prepared).unwrap();
        assert_eq!(parsed["version"], "2099-99-99.rX");
    }

    #[test]
    fn strips_studio_only_fields() {
        let native = serde_json::json!({
            "name": "hello",
            "description": "studio metadata",
            "runtime_vars": { "model": "openai:gpt-4o-mini" },
            "inputs": [{ "type": "text", "text": "Hi" }],
            "agent_schema": { "properties": { "reply": { "type": "string" } } },
        })
        .to_string();
        let prepared = prepare_spec(&native, "").unwrap();
        let parsed: Value = serde_json::from_str(&prepared).unwrap();
        assert!(parsed.get("name").is_none());
        assert!(parsed.get("description").is_none());
        assert!(parsed.get("runtime_vars").is_none());
    }

    #[test]
    fn synthesises_emit_action_with_one_step_per_schema_property() {
        let native = serde_json::json!({
            "inputs": [{ "type": "text", "text": "Hi" }],
            "agent_schema": {
                "properties": {
                    "greeting": { "type": "string" },
                    "mood": { "type": "string" }
                }
            },
        })
        .to_string();
        let prepared = prepare_spec(&native, "").unwrap();
        let parsed: Value = serde_json::from_str(&prepared).unwrap();
        let actions = parsed["actions"].as_array().unwrap();
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0]["name"], "_tas_emit_output");
        let steps = actions[0]["run"].as_array().unwrap();
        assert_eq!(steps.len(), 2);
        // serde_json::Map iteration is insertion order; both fields land.
        let field_names: Vec<&str> = steps
            .iter()
            .map(|s| s["args"][1].as_str().unwrap())
            .collect();
        assert!(field_names.contains(&"greeting"));
        assert!(field_names.contains(&"mood"));
    }

    #[test]
    fn rejects_specs_missing_agent_schema() {
        let native = serde_json::json!({
            "inputs": [{ "type": "text", "text": "Hi" }],
        })
        .to_string();
        assert!(prepare_spec(&native, "").is_err());
    }
}
