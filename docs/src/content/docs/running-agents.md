---
title: Running agents
description: Run an agent on demand, read the run detail page, and understand what gets recorded for each run.
---

A **run** is a single execution of an agent. Runs happen on demand, on a
[schedule, or from an event](/agent-studio/automations-triggers/) — this page
covers running on demand and reading the result.

## Run an agent now

Open an agent and use **Run** to execute it once. You can optionally pass an
input message; agents with no input run their instructions directly. Manual
runs default to the live **draft** so your latest repository edits are what get
tested. The confirmation dialog names the selected version and lets you choose
the numbered stable snapshot instead. Schedules and other automated runs still
default to stable.

The selected lifecycle also sets the run's analytics environment: a **draft**
run is **Development**, while a promoted/versioned run is **Production**. This
classification is recorded with the run, so later promotions do not rewrite
historical metrics. A sub-run inherits its orchestrator's environment even if
the child agent uses a different version.

**Dry run** is a separate checkbox, not a third version. It runs the same
selected draft or stable spec, but TAS stubs the agent's declared `delivery:`
tools at runtime — email, Slack, inbox items, and any named tool-call
destination are not executed. Other tools may still make real changes. TAS
refuses a dry run when it cannot identify those delivery tools (no `delivery:`
block, Cargo AI, or a Composio tool-router session where a delivery tool-call
cannot be intercepted). Dry runs stay on the original agent's history with a
**Dry run** badge, remain filterable on the Runs page, and are excluded from
dashboard success-rate and delivery metrics.

The API limits how many agents execute simultaneously. When all execution slots
are occupied, newly accepted runs stay **queued** and start automatically as
capacity becomes available. Instance operators configure the cap with
`API_MAX_CONCURRENT_RUNS`. By default, half of those slots are reserved for
sub-agents (two of the default four) so concurrent orchestrators can keep making
progress instead of serializing every sub-agent behind one slot. Queued runs can
be stopped normally before they start.

## The run detail page

Each run records and displays:

- **Output** — the agent's final response, rendered as Markdown.
- **Status** — queued → running → succeeded / failed.
- **Tokens & cost** — input/output token counts and the computed USD cost, so you
  can compare models and prompts.
- **Tools used** — every tool the agent called, in order, with a success/failure
  mark and (on failure) the error. This is captured for Pydantic agents on both
  successful and failed runs — so a run that broke before reaching a step still
  shows what it did call. The same data rolls up in
  [Tool uses](/agent-studio/tools-and-tool-uses/). When one step makes more than
  five calls, its remaining calls start collapsed with the total and failure
  count visible; expand them to browse the bounded, scrollable list.
- **Timing & trigger** — when it ran and what triggered it (manual, schedule, or
  event).
- **Environment** — Production or Development, based on the lifecycle rule in
  effect when the run was created. Dry runs also show a **Dry run** badge.

Pydantic runs checkpoint their message history after each model/tool node. If
the API or host restarts mid-run, TAS reconstructs the run from its last
checkpoint instead of starting the completed steps over. The status line shows
**Resumed** (and a count after multiple recoveries) when this happened. A tool
that was still executing at the exact moment the process died may still need
the provider's own idempotency protection; completed tool-result nodes are not
replayed.

## When a run fails

Failed runs keep their captured output and tool calls. The run page explains the
failure in plain language, recommends what to do next, and links directly to the
relevant connection, provider, or agent settings when possible. The agent and
workspace dashboards group failures by these safe summaries instead of by raw
runtime output.

Workspace admins see the same simple explanation and role-appropriate recovery
guidance as everyone else, plus a collapsed **Technical details** section for
investigating the underlying runtime trace. Technical details are not sent to
viewers or operators through the run page, Runs list, chat, audit timeline, REST
API, MCP, or Slack failure notifications. Runs created before structured failure
summaries were introduced show a generic explanation while retaining their
admin-only diagnostics.

Common causes — a missing provider key, an unauthorized or stale connection, or
a truncated response — are covered in
[Troubleshooting](/agent-studio/troubleshooting/).

## Improving an agent from a run

If a run is wrong, use **Improve the Agent** to describe what should change. TAS
turns the feedback into a pull request via Tembo and correlates the merged PR
back to your submission. See [Improvements](/agent-studio/improvements/).
