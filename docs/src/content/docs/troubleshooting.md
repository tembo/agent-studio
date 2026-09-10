---
title: Troubleshooting
description: Common run failures and where to look when something isn't working.
---

When something's off, the [run detail page](/agent-studio/running-agents/) and
the [Tool uses](/agent-studio/tools-and-tool-uses/) view are the first places to
look — they show the agent's output and exactly which tools it called (even on
failed runs). Failure cards give every member a safe summary and recommended
action. Workspace admins can expand **Technical details** on the run page when
the summary is not enough; viewers and operators do not receive raw runtime
traces.

## Common issues

**"Memory report was not queued" / a Memory write shows Failed.**
The run's Memory warning includes a safe reason code and an action to take:

- `memory_report_invalid_timestamp`: use an RFC 3339 `occurred_at` with a
  timezone, such as `2026-09-09T12:00:00Z`, or omit it to use the current time.
- `memory_report_invalid_external_id`: supply a nonempty string of at most
  512 bytes, or omit it to let Studio generate an identifier.
- `memory_report_forbidden_identity`: remove `principal_id`, `filed_by`,
  `tenant_id`, `workspace_id`, and `report_id`; Studio supplies identity.
- `memory_report_payload_too_large`: shorten the report to fit within 64 KiB.
- `memory_report_invalid_arguments`: pass a JSON object as tool arguments.
- `memory_report_invalid_invocation`: ask an administrator to check the Studio
  runner integration; the model should not invent an invocation ID.
- `memory_report_encryption_failed` or `memory_report_storage_failed`: ask an
  administrator to check encryption configuration or database availability and
  migrations, respectively. API logs include the run ID and safe reason code,
  not report contents or raw database errors.

A failed Memory write does not fail the whole agent run or undo a successful
Slack post. The run transcript and **Tool uses** mark unsuccessful Memory writes
as **Failed**, even when the tool returned normally. This does not trigger
automatic model retries. Queued receipts and simulated dry-run writes are not
failures; queued still means awaiting asynchronous delivery, not extracted.
Older runs retain their original generic warning and tool outcome; Studio
cannot reconstruct a discarded error from those records.

**A run stays queued while other agents are running.**
The instance has reached its execution limit. It starts automatically when a
slot opens. Instance admins can raise the caps under
[Instance settings → Run queue](/agent-studio/instance-admin/#run-queue).
Queued sub-agents start before new orchestrator runs. A sub-agent can also wait
behind that orchestrator's own cap (default three). If no runs are active, check
the API service logs and networking instead.

**"LLM provider needed" / runs won't start.**
The workspace has no Anthropic or OpenAI key. Add one under
**Settings → LLM Providers** ([Settings](/agent-studio/settings/)).

**A connection-using agent fails with "no active connection".**
The [acting user](/agent-studio/core-concepts/) hasn't authorized that service,
or the agent declared a provider/slot nobody has connected. Use the sidebar
**"Action needed → Connect"** prompt or authorize it under
[Connections](/agent-studio/connections/).

**A run fails with an auth/401 error mid-way.**
The connection's credential expired or was revoked (the connection is marked
stale). Reconnect it under [Connections](/agent-studio/connections/).

**A run fails opening a Native MCP session (Stripe, Attio, …) but a rerun works.**
Hosted MCP handshakes are flaky under load. Studio waits up to 30s for
initialize and retries transient connect / "connection closed" / 5xx / 429
errors on handshake and tool calls. A 401 still means reconnect the
connection. `retries:` on the agent spec is a model-tool retry, not a
whole-run retry — do not bump it to paper over MCP transport failures.

**An MCP server returns an error while closing a completed run.**
Agent Studio preserves the completed output and records the session-cleanup
error as an operator warning. An error while opening the session or while the
agent is still working remains a run failure and appears in the run details.

**The agent narrates instead of acting, or truncates.**
A lower-tier model may hedge on tool use, or the response hit the token cap. Try
a more capable model or raise `max_tokens` in `model_settings`. See
[Authoring agents → choosing a model](/agent-studio/authoring-agents/).

**A declared `tools_module` "couldn't be loaded".**
The sibling `.py` is missing from the repo, or it doesn't export a non-empty
`tools = [...]` list. See [Sidecar Python tools](/agent-studio/sidecar-python-tools/).

**"Improve the Agent" seems to do nothing.**
Usually a stale browser tab from a previous deployment — hard-refresh and retry.
Confirm either your personal Tembo account or the workspace fallback account is
connected in [Settings](/agent-studio/settings/). If work appears under the
fallback account, connect your own Tembo API key before submitting again.

**The wrong tool slug / tools don't appear.**
Composio and Native MCP use different slugs for the same provider — make sure the
agent's `tools:` list matches the connection's `source:`. See
[Connections](/agent-studio/connections/).

## Still stuck?

Check the agent and workspace [dashboards](/agent-studio/dashboard-and-runs/) for
failure groups, and the [Audit](/agent-studio/audit-and-roles/) timeline for what
changed and when. For instance-level problems, see
[Deploying & operating](/agent-studio/admin-introduction/) and the
self-hosting guides.
