---
title: Dashboard & Runs
description: Read workspace and per-agent health, browse run history, and inspect team activity.
---

## Dashboard

The **Dashboard** is the health overview. The workspace dashboard shows, over the
last 30 days, headline tiles (runs, success rate, spend, average duration), a
trend, the top-failing agents, and recent improvements. Each agent also has its
own dashboard with the same shape scoped to that agent — useful for deciding
whether a model downgrade held up or an agent started failing.

Dashboard metrics show **Production** runs by default, so draft testing does
not lower the live success rate. Use the **Development** or **All runs** tabs to
inspect testing activity or compare the combined workload. The selected tab
applies to the headline metrics, trend, failures, tool use, and recent runs.
**Dry run** executions are excluded from these success-rate, delivery, and
tool-usage rollups even when you browse All runs.

An agent overview puts its five most recent runs first, ahead of the 30-day
configuration and health details. Tool usage shows the five most-used tools and
the total tool and call counts; expand the remainder to browse it in a bounded,
scrollable list.

### Team (workspace admins)

Below the headline tiles, the **Team** section lists every workspace member with
counts for:

| Column | What it shows |
| ------ | ------------- |
| **Connections** | How many tool connections the member has authorized. Hover for the toolkit list. |
| **Automations** | How many scheduled automations **Run as** this member. Hover for the agent names. |
| **Slack (30d)** | How many runs this member instigated from [Slack apps](/agent-studio/slack-apps/) in the last 30 days. Hover for a per-bot breakdown. |
| **Runs (30d)** | Total runs they triggered in the last 30 days. |

The table is sorted by run activity. **Click a member's name** (admins only) to
open their [member detail](#member-detail-admins) — useful before offboarding
someone who owns connections or automations.

## Runs

The **Runs** page is the full, filterable history of every run in the workspace.
Filter by agent, status, trigger, **Environment**, and **Dry run** to find what
you're looking for, then open any run for its
[detail page](/agent-studio/running-agents/) — output, tokens, cost, tools used,
environment, and the effective **Run as** identity. Production, Development, and Dry run
badges keep excluded testing runs visible even when browsing all history. The
workspace list, agent run lists and recent-run panels, automation history, and
run detail all use the same identity. Orchestrator run pages also show the
identity for each sub-run. If a historical identity is no longer available,
TAS displays **Unavailable member** instead of exposing an internal user
identifier.

Use **Search** on either the workspace Runs page or an agent's Runs tab to find
runs by agent name, full run ID, **Run as** member name or email, input, output,
or error text. Search combines with the agent, status, and trigger filters. The
active search and filters are stored in the page URL, so copying the URL shares
the same view. Submit an empty search or choose **Clear** to remove only the
search while keeping the other filters.

### Environment rules

The environment is recorded when a run is created and does not change later:

| Selected agent version | Run environment |
| ---------------------- | --------------- |
| **Draft** | **Development** |
| **Promoted/versioned** | **Production** |

A sub-run always inherits the orchestrator run's environment. This keeps one
orchestrated workflow in a single analytics bucket even when its child agents
use different selected versions. For runs created before environment tracking
was added, TAS applies the same rule from the recorded version label and carries
the root run's environment through its historical sub-runs. Older runs without
a recorded version are treated as Production because their original lifecycle
cannot be reconstructed safely.

### Source column

Each row shows **how the run was instigated** and explicitly labels **who it
acted as** with **Run as**:

| Source | Meaning |
| ------ | ------- |
| **Manual** | Someone clicked Run (or ran from chat). Shows the acting member. Admins see a **Run as** picker in the Run-now dialog to execute under another member's connections. |
| **Scheduled** | Fired by an [automation](/agent-studio/automations-triggers/). Shows the automation's **Run as** owner. |
| **Event** | Fired by a Composio trigger or [external webhook](/agent-studio/automations-triggers/#external-webhooks). Shows the trigger/webhook owner. |
| **Slack** | Launched from a [Slack app](/agent-studio/slack-apps/). Shows who the run acted as and a **View in Slack** link to the originating message. |

The "Action needed" alerts in the sidebar (failing agents, missing connections,
missing LLM key) link straight to the relevant surface.

## Outputs

The **Outputs** page is a report-first view of successful runs. Every successful
run with non-empty output appears here, including sub-agent runs. Search the
output body, or filter by producing agent, orchestrator, **Run as** member,
completion date, and delivery evidence. Open a result to see a rendered Markdown
preview, the exact raw text, its agent version and execution provenance, and a
link to the source run. Orchestrator provenance appears only for an output
produced by a sub-agent; a top-level output shows only its producing agent.

Each agent also has an **Outputs** tab with the same report view fixed to that
agent. Search and the orchestrator, **Run as**, date, and delivery-evidence
filters remain available there; use the workspace **Activity → Outputs** page to
search across agents.

An output's delivery status is evidence-based: **Confirmed** means TAS observed
the inbox item or successful tool call declared by that exact agent version. It
does not claim that a person read an email or message. **Partial**, **Failed**,
and **Unobserved** distinguish mixed, unsuccessful, and absent evidence;
**Undeclared** means the agent did not define delivery intent.

## Member detail (admins)

From **Settings → Members** or the Dashboard **Team** table, workspace admins
can open a read-only view of any member's footprint:

- **Connections** — every Composio and Native MCP connection they've authorized.
- **Automations** — schedules that **Run as** them (with links to each automation).
- **Recent runs** — the last 20 runs they triggered.

Use this before removing a member to see what still depends on their credentials.
To change connections on their behalf, use the **Viewing** dropdown on the
[Connections](/agent-studio/connections/) page (rename and refresh only — OAuth
must still be performed by the member).

### Reusing a recent output

REST `POST /api/v1/runs` and the MCP `trigger_run` tool accept an optional
`outputReuse` policy. Use it for reports whose previously generated text is
acceptable instead of executing their tools again:

```json
{
  "agent": "daily-report",
  "message": "Summarize account 123",
  "outputReuse": { "reportType": "account-summary", "maxAgeSeconds": 300 }
}
```

Reuse is off by default. Both the original request and later callers must opt
in with the same report type. Matching requires the same workspace, acting
user, authorization scopes, stable agent version, exact input, and execution
content (including tool modules and skills). Local connection, secret, or
membership changes invalidate matching. Two API keys for the same acting user
can share compatible results; two different acting users cannot.

`maxAgeSeconds` is an integer from 0 to 604800 (seven days), measured from the
original producer's completion. Use `requireFresh: true` or `maxAgeSeconds: 0`
to execute again; the new successful result can satisfy later requests. Missing,
expired, or incompatible results run normally. A failed scope or lookup query
also falls back to normal execution. Concurrent misses may each execute.

Only successful, nonempty production results from stable agents are eligible.
Failed, partial-delivery, unobserved-delivery, development, evaluation, and
dry-run results are excluded. This first version has no override for those
exclusions and does not reuse across agent versions. Parent development and
dry-run settings still apply to subagents.

A hit creates a new completed run associated with the calling parent, with zero
new tokens/cost and `reusedFromRunId` linking to the original producer. The run
page links to that producer, and the parent's sub-run list distinguishes reused
outputs. MCP `trigger_run` returns `reusedFromRunId`; REST's create response uses
`reused_from_run_id`. `get_run` and REST run details expose `reusedFromRunId` and
`outputReuseType`. Poll the returned run ID as usual. Reused runs never extend
the original output's freshness window.

Reuse returns saved text only: it does **not** repeat tools, deliveries, or other
side effects, and does not claim that a delivery happened again. Keep reuse off
when those actions are required. Use a fresh result after upstream authorization
changes that have not been synchronized into Studio, or when current external
data is essential. Existing historical outputs without an opt-in key are not
eligible.

### Run history page limits

Workspace and agent run lists load at most 50 rows per page. **Load more** keeps
the exact timestamp and run ID of the last row so runs with identical timestamps
remain reachable. Newer runs arriving while you browse appear when you refresh
the list. Input previews are limited to 200 characters before transfer from the
database; open a run to read its full input.
