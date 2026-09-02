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

**A run stays queued while other agents are running.**
The instance has reached its execution limit. It starts automatically when a
slot opens; operators can tune `API_MAX_CONCURRENT_RUNS` against the API
service's memory limit. A sub-agent can also wait behind that orchestrator's
own cap (`API_MAX_CONCURRENT_SUB_AGENTS_PER_ORCHESTRATOR`, default three). If
no runs are active, check the API service logs and networking instead.

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
