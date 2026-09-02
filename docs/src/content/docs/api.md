---
title: REST API
description: Drive your TAS workspace programmatically — list and read agents, trigger and read runs, browse the tool catalog, manage automations, and hand authoring to the Tembo Coding Agent.
---

The **REST API** lets external tools and scripts read and drive a Tembo Agent
Studio workspace over HTTP — the same operations you do in the UI, behind a
bearer token. It pairs with the [MCP server](/mcp/), which exposes the same
capabilities to AI clients like Claude. The REST API uses personal API keys;
the MCP server additionally supports per-user OAuth for hosted clients.

## Authentication

Every request carries a personal API key as a bearer token:

```
Authorization: Bearer tas_xxxxxxxxxxxxxxxxxxxxxxxx
```

Mint a key under **Settings → API keys**. A key:

- **acts as you** — runs it triggers use *your* per-user connections, and it
  can do exactly what your workspace role allows (no more);
- is shown **once** on creation — store it somewhere safe;
- inherits your **live** role, so if an admin changes your role or removes you,
  the key's power changes immediately. Disable or revoke a key anytime from the
  same page.

Requests with a missing, unknown, or disabled key get `401`. A request that
needs a higher role than the key's user holds gets `403`.

## Base URL

```
https://<your-tas-host>/api/v1
```

All endpoints are under `/api/v1`. Responses are JSON. Errors use the shape
`{ "error": "...", "details"?: ... }`.

## Roles

`viewer` < `operator` < `workspace_admin`. Reads need **viewer**; anything that
triggers a run, writes an automation, or kicks off the coding agent needs
**operator**.

## Endpoints

| Method · Path | Purpose | Min role |
|---|---|---|
| `GET /agents` | List agents in the connected repo (valid + invalid). | viewer |
| `GET /agents/{name}` | One agent, including the raw spec text. | viewer |
| `POST /agents/validate` | Parse a spec without writing it. | viewer |
| `GET /runs` | List runs (`?status=`, `?agent=`, `?trigger=`, `?environment=`, `?limit=`, `?before=`). | viewer |
| `POST /runs` | Trigger a run → `202 { run_id }`. | operator |
| `GET /runs/{id}` | Full run incl. output, safe failure guidance, tokens, and cost. Workspace admins additionally receive `errorDetails`. | viewer |
| `GET /tools` | Your cached tool catalog (slugs for `connections:`). | viewer |
| `GET /connections` | Your per-user connection status (no tokens). | viewer |
| `GET /automations` · `POST /automations` | List / create scheduled automations. | viewer / operator |
| `GET·PATCH·DELETE /automations/{id}` | Read / update / delete one. | viewer / operator |
| `GET /slack-apps` · `GET /slack-apps/{id}` | List / read Slack bots (secret-safe). | viewer |
| `POST /slack-apps` | Create a Slack bot (returns it in `configuring` state). | workspace_admin |
| `PATCH·DELETE /slack-apps/{id}` | Update (name/labels/owner/secrets) / delete. | workspace_admin |
| `POST /agent-changes` | Hand an authoring request to the Tembo Coding Agent. | operator |
| `GET /evals?agent=` | List eval suite runs for an agent (`?latest=true` for the newest). | viewer |
| `POST /evals` | Queue an eval suite → `202 { eval_id }`. Body: `{ agent, version?, spec?, eval?, commitSha?, source? }`. | operator |
| `GET /evals/{id}` | One eval suite incl. per-case pass/fail. Poll until `passed` / `failed` / `error`. | viewer |

Creating a Slack bot via the API writes metadata only — it comes up in a
`configuring` state and isn't live until an admin finishes the one-time browser
OAuth **install** under Settings → Slack apps. `agentLabels` are the agent
labels the bot may launch.

## Examples

List agents:

```bash
curl -s https://your-tas-host/api/v1/agents \
  -H "Authorization: Bearer tas_..."
```

Validate a spec before committing it:

```bash
curl -s -X POST https://your-tas-host/api/v1/agents/validate \
  -H "Authorization: Bearer tas_..." \
  -H "Content-Type: application/json" \
  -d '{"content":"name: greet\nmodel: anthropic:claude-sonnet-5\ninstructions: hi","format":"yaml"}'
# → { "valid": true, "framework": "pydantic-agentspec", "name": "greet", "format": "yaml" }
```

Trigger a run, then read its output:

```bash
curl -s -X POST https://your-tas-host/api/v1/runs \
  -H "Authorization: Bearer tas_..." \
  -H "Content-Type: application/json" \
  -d '{"agent":"day-planner","message":"focus on revenue"}'
# → 202 { "run_id": "..." }

curl -s https://your-tas-host/api/v1/runs/<run_id> \
  -H "Authorization: Bearer tas_..."
# → { "run": { "status": "succeeded", "output": "...", "tokensInput": 1234, ... } }
```

Find the tool slugs to put in an agent's `connections:`:

```bash
curl -s https://your-tas-host/api/v1/tools \
  -H "Authorization: Bearer tas_..."
# → { "tools": [ { "source": "composio", "provider": "slack", "slug": "SLACK_SEND_MESSAGE", ... } ] }
```

Ask the Tembo Coding Agent to create a new agent (opens a PR, or commits
directly per your workspace's commit mode):

```bash
curl -s -X POST https://your-tas-host/api/v1/agent-changes \
  -H "Authorization: Bearer tas_..." \
  -H "Content-Type: application/json" \
  -d '{"name":"Weekly digest","description":"Every Monday, summarize last week''s closed deals and DM me on Slack."}'
# → 202 { "task_id": "...", "html_url": "https://...", "kind": "create", "agent_path": "agents/pydantic-agentspec/weekly-digest.yaml" }
```

To edit an existing agent instead, pass `agent` (its name) and a `description`
of the change.

Run an agent's eval suite (see [Agent evals](/agent-studio/agent-evals/)):

```bash
curl -s -X POST https://your-tas-host/api/v1/evals \
  -H "Authorization: Bearer tas_..." \
  -H "Content-Type: application/json" \
  -d '{"agent":"hello-world","version":"draft"}'
# → 202 { "eval_id": "..." }

curl -s https://your-tas-host/api/v1/evals/<eval_id> \
  -H "Authorization: Bearer tas_..."
# → { "eval": { "status": "passed", "passedCount": 2, "cases": [ ... ] } }
```

## Notes

- **Runs are asynchronous.** `POST /runs` returns `202` with a `run_id`
  immediately; poll `GET /runs/{id}` until `status` is `succeeded` or `failed`.
  Eval suites are the same shape (`POST /evals` → poll `GET /evals/{id}`).
  Per-case agent runs use `trigger=eval` and are omitted from `GET /runs`
  unless you pass `?trigger=eval`.
- **Run responses include `runEnvironment`.** Filter `GET /runs` with
  `?environment=production`, `development`, or both as a comma-separated list.
  Draft runs are Development; promoted/versioned runs are Production.
- **Failure details follow your live role.** Failed runs return `failureCode`,
  a safe `errorMessage`, and `failureRecommendation` to every member. Only a
  workspace-admin key receives the raw runner trace in `errorDetails`.
- **Agent files live in your Git repo.** The API reads them through the
  connected repo and validates them, but it doesn't write them — committing is
  your repo's job (or the Tembo Coding Agent's via `POST /agent-changes`).
- **Connections are per-user.** A run triggered with your key uses the
  connections *you* authorized. If `POST /runs` returns a 422 about a missing
  connection, authorize it under Connections first.
