---
title: Running agents
description: Run an agent on demand, read the run detail page, and understand what gets recorded for each run.
---

A **run** is a single execution of an agent. Runs happen on demand, on a
[schedule, or from an event](/agent-studio/automations-triggers/) — this page
covers running on demand and reading the result.

## Run an agent now

Open an agent and use **Run** to execute it once. You can optionally pass an
input message; agents with no input run their instructions directly. By default
a run uses the agent's **stable** version; the chat surface runs the live draft.

The API limits how many agents execute simultaneously. When all execution slots
are occupied, newly accepted runs stay **queued** and start automatically as
capacity becomes available. Instance operators configure the cap with
`API_MAX_CONCURRENT_RUNS`; one slot is reserved for child agents by default so
an orchestrator waiting for a sub-agent cannot consume all root-run capacity.
Queued runs can be stopped normally before they start.

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
  [Tool uses](/agent-studio/tools-and-tool-uses/).
- **Timing & trigger** — when it ran and what triggered it (manual, schedule, or
  event).

Pydantic runs checkpoint their message history after each model/tool node. If
the API or host restarts mid-run, TAS reconstructs the run from its last
checkpoint instead of starting the completed steps over. The status line shows
**Resumed** (and a count after multiple recoveries) when this happened. A tool
that was still executing at the exact moment the process died may still need
the provider's own idempotency protection; completed tool-result nodes are not
replayed.

## When a run fails

Failed runs keep their captured output and tool calls so you can diagnose them.
The agent and workspace dashboards group recent failures, and the run page links
to related context. Common causes — a missing provider key, an unauthorized or
stale connection, or a truncated response — are covered in
[Troubleshooting](/agent-studio/troubleshooting/).

## Improving an agent from a run

If a run is wrong, use **Improve the Agent** to describe what should change. TAS
turns the feedback into a pull request via Tembo and correlates the merged PR
back to your submission. See [Improvements](/agent-studio/improvements/).
