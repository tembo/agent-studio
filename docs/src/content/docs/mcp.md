---
title: MCP server
description: Connect Claude Web, Claude Code, or another MCP client to your TAS workspace to read live state and drive it — list agents, validate specs, trigger runs, browse the tool catalog, and manage automations.
---

Tembo Agent Studio exposes a **Model Context Protocol (MCP) server** so an AI
client like **Claude Web** or **Claude Code** can read and improve your TAS
deployment directly. The MCP server exposes live run history and output, the
tool catalog, connection status, automations, Slack bots, and spec validation,
plus the ability to trigger runs and hand authoring to the Tembo Coding Agent.

## Connect Claude Web

:::caution[Request headers access required]
TAS currently authenticates MCP requests with a personal API key, not OAuth.
Claude's [request-header authentication](https://claude.com/docs/connectors/custom/remote-mcp#authenticating-with-request-headers)
is in beta. If the custom connector form only shows **OAuth Client ID** and
**OAuth Client Secret**, you cannot connect TAS from Claude Web yet. Do not put
a TAS API key in either OAuth field; ask Anthropic for request-header access or
use [Claude Code](#connect-claude-code) below.
:::

1. In TAS, open **Settings → API keys**, create a key, and copy the `tas_...`
   token. It is shown only once.
2. In Claude Web, open **Customize → Connectors**, select **Add custom
   connector**, and enter:
   - **Name:** `Tembo TAS`
   - **Remote MCP server URL:** `https://<your-tas-host>/mcp`
   - **OAuth Client ID / Secret:** leave both blank
3. Under **Request headers**, add a required header:
   - **Header:** `Authorization`
   - **Value:** `Bearer tas_...` (include the `Bearer ` prefix)
4. Add the connector, enable it for a conversation, and ask Claude to “list my
   agents” or “show the last failed run's output.”

For Team and Enterprise plans, an owner adds the connector under
**Organization settings → Connectors**, then members enable it under
**Customize → Connectors**. Claude stores one request header for the whole
organization, so every member using that connector acts as the TAS user who
created the key. If you intentionally want a shared connector, use a dedicated
TAS member with the minimum workspace role and only the connections the team
should share. If each person must act as themselves, use Claude Code for now.

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

The MCP server uses the same [personal API keys](/api/) as the REST API. A key
**acts as you**: tools that run agents use *your* per-user connections, and each
tool is allowed only if your live workspace role permits it. Read tools need
**viewer**; write tools (`trigger_run`, `create_automation`,
`request_agent_change`) need **operator** and return an error for a viewer key.

## Tools

**Read (viewer):**

- `list_agents` — every agent in the repo, including specs that fail to parse.
- `get_agent` — one agent plus its raw spec text and any sidecar tools/skills.
- `validate_agent_spec` — parse a draft spec *without* writing it. Use this
  before committing.
- `list_runs` — recent runs, filterable by status / agent / trigger.
- `get_run` — full output, error, and token usage for one run.
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
- **Per-user connections.** A run triggered through the MCP server uses the
  connections *you* authorized. If a run fails on a missing connection, check
  `list_connections` and authorize it under Connections.
- **The token is shown once.** Revoke or disable a key anytime under Settings →
  API keys; the change takes effect immediately.
