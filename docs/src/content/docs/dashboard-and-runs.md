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
Filter by agent, status, and trigger to find what you're looking for, then open
any run for its [detail page](/agent-studio/running-agents/) — output, tokens,
cost, tools used, and the effective **Run as** identity. The workspace list,
agent run lists and recent-run panels, automation history, and run detail all
use the same identity. Orchestrator run pages also show the identity for each
sub-run. If a historical identity is no longer available, TAS displays
**Unavailable member** instead of exposing an internal user identifier.

Use **Search** on either the workspace Runs page or an agent's Runs tab to find
runs by agent name, full run ID, **Run as** member name or email, input, output,
or error text. Search combines with the agent, status, and trigger filters. The
active search and filters are stored in the page URL, so copying the URL shares
the same view. Submit an empty search or choose **Clear** to remove only the
search while keeping the other filters.

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
link to the source run.

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
