---
title: MCP server
description: Connect Claude Web, Claude Desktop, Claude Code, or another MCP client to your TAS workspace to read live state and drive it — list agents, validate specs, trigger runs, browse the tool catalog, and manage automations.
---

Tembo Agent Studio exposes a **Model Context Protocol (MCP) server** so an AI
client like **Claude Web**, **Claude Desktop**, or **Claude Code** can read and
improve your TAS deployment directly. The MCP server exposes live run history
and output, the tool catalog, connection status, automations, Slack bots, and
spec validation, plus the ability to trigger runs and hand authoring to the
Tembo Coding Agent.

## Connect Claude Web and Desktop

Claude Web and Claude Desktop use the same custom connectors. Add Tembo TAS
once through Claude's connector settings and it becomes available in both
clients when you use the same Claude account or organization.

1. In Claude Web, open the custom connector form:
   - **Pro, Max, or Free:** **Customize → Connectors → Add custom connector**.
   - **Team or Enterprise owner:** **Organization settings → Connectors → Add
     → Custom → Web**. Members connect it afterward under **Customize →
     Connectors**.
2. Enter:
   - **Name:** `Tembo TAS`
   - **Remote MCP server URL:** `https://<your-tas-host>/mcp`
   - **OAuth Client ID / Secret:** leave both blank
   - **Individual sign-in:** keep enabled when the form shows it
3. Click **Add**, then **Connect**. Claude opens TAS: sign in, choose the
   workspace this connector may access, review the requested access, and click
   **Allow**. No TAS API key or pre-registered OAuth client is required.
4. In Claude Web or Desktop, enable **Tembo TAS** for a conversation and ask
   Claude to “list my agents” or “show the last failed run's output.” There is
   no separate Desktop MCP configuration.

The TAS host must be publicly reachable over HTTPS, and its `BETTER_AUTH_URL`
must exactly match that public origin. Each member completes their own OAuth
flow, acts as their own TAS user, and chooses which workspace to expose.

## Connect Claude Code

The agent definition files live in your connected Git repo, which Claude Code
can edit locally. Mint a key under **Settings → API keys**, then:

```bash
claude mcp add --transport http tas https://<your-tas-host>/mcp \
  --header "Authorization: Bearer tas_..."
```

That's it — start a Claude Code session and ask it to "list my agents" or "show
the last failed run's output". Any MCP client that speaks **Streamable HTTP**
works the same way; point it at `https://<your-tas-host>/mcp` with the same
`Authorization: Bearer` header.

## Authentication

Claude Web and Desktop use TAS's OAuth 2.1 flow: Dynamic Client Registration,
S256 PKCE, short-lived signed access tokens, and rotating refresh tokens. The
consent flow binds the token to one workspace. Claude Code and header-based
clients can use the same [personal API keys](/api/) as the REST API instead.

Both methods **act as you**: tools that run agents use *your* per-user
connections, and every request resolves your live workspace role. Read tools
need **viewer**. Write tools (`trigger_run`, `create_automation`,
`request_agent_change`) need both the OAuth `mcp:write` scope (when using OAuth)
and the **operator** role; a viewer cannot gain write access by authorizing a
connector.

## Tools

**Read (viewer):**

- `list_agents` — every agent in the repo, including specs that fail to parse.
- `get_agent` — one agent plus its raw spec text and any sidecar tools/skills.
- `validate_agent_spec` — parse a draft spec *without* writing it. Use this
  before committing.
- `list_runs` — recent runs, filterable by status / agent / trigger.
- `get_run` — full output, safe failure guidance, and token usage for one run.
  Workspace admins additionally receive technical failure diagnostics.
- `list_tools` — your cached tool catalog. Each tool's `slug` is what goes into
  an agent's `connections: tools: [...]`.
- `list_connections` — your connection status across Composio + Native MCP.
- `list_automations` — scheduled automations.
- `list_slack_apps` — the workspace's Slack bots (secret-safe).

**Write (operator):**

- `trigger_run` — run an agent now, acting as you; returns a run id to poll with
  `get_run`.
- `create_automation` — schedule an agent on a cron expression.
- `request_agent_change` — hand an edit or a new-agent request to the Tembo
  Coding Agent, which opens a PR (or commits directly, per your commit mode).

**Slack bots (workspace_admin):**

- `create_slack_app` — create a Slack bot (metadata only; comes up `configuring`
  and needs the one-time browser OAuth install before it's live).
- `update_slack_app` — change a bot's name, the agent labels it may launch,
  owner, or secrets.
- `delete_slack_app` — remove a bot.

## A typical loop with Claude Code

1. Ask Claude Code to read the agent you want to improve (`get_agent`) and the
   relevant runs (`list_runs`, `get_run`) to see what actually happened.
2. It edits the agent's YAML in your local repo checkout — its native strength.
3. Before committing, it can `validate_agent_spec` to catch shape errors, and
   `list_tools` to get the exact connection slugs.
4. After you commit and the change is live, it can `trigger_run` to test, then
   `get_run` to read the result — iterating until the agent behaves.

`request_agent_change` is there for clients that *aren't* themselves coding
agents (or when you'd rather TAS open the PR). When Claude Code can edit the
files directly, that's usually the faster path.

## Notes

- **Stateless.** The server runs in stateless mode — there's no session to keep
  alive; each call is authenticated by the bearer token on its own.
- **Failure details follow your live role.** `get_run` gives every member a safe
  failure summary and recommendation. Raw `errorDetails` are additive for
  workspace admins and omitted for viewers and operators.
- **Per-user connections.** A run triggered through the MCP server uses the
  connections *you* authorized. If a run fails on a missing connection, check
  `list_connections` and authorize it under Connections.
- **The token is shown once.** Revoke or disable a key anytime under Settings →
  API keys; the change takes effect immediately. OAuth clients manage their
  tokens automatically and can be disconnected from Claude's connector
  settings.
