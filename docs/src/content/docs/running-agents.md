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
runs default to the live **draft** when it differs from stable, so your latest
repository edits are what get tested. If draft and stable are the same spec,
the dialog offers only the numbered stable snapshot. When a pending draft
exists, the confirmation names the selected version and lets you choose stable
instead. Schedules and other automated runs still default to stable.

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

The API limits how many agents execute simultaneously (ten by default). When all
execution slots are occupied, newly accepted runs stay **queued** and start
automatically as capacity becomes available. Queued sub-agents are started
before new orchestrator runs, so in-flight work can finish its children first.
Instance admins set the caps under
[Instance settings → Run queue](/agent-studio/instance-admin/#run-queue)
(sidebar **Instance settings**, or the user menu). Until an admin saves a value,
the API reads `API_MAX_CONCURRENT_RUNS` and
`API_MAX_CONCURRENT_SUB_AGENTS_PER_ORCHESTRATOR` from the environment. By
default, half of the slots are reserved for sub-agents (five of the default ten)
so concurrent orchestrators can keep making progress. Each orchestrator is also
limited to three concurrent sub-agents; further children of that parent stay
queued until one finishes. Queued runs can be stopped normally before they start.

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
- **Timing & trigger** — queued, started, and completed timestamps in your local
  time zone (hover or focus a timestamp to see UTC), plus what triggered the run
  (manual, schedule, or event). Started appears once recorded, with the queue
  wait alongside it. Completed appears once the run ends; **Ran for** shows
  elapsed time when both start and completion are known. A run cancelled before
  starting shows queued and completed times without a start time or duration.
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

All workspace members, including viewers and operators, can expand the collapsed
**Technical details** section on a failed run to inspect and copy its underlying
runtime trace. The section appears when diagnostics are available, including on
older runs without a structured failure summary. Recovery guidance and actions
still follow the member's role. Viewing diagnostics requires access to the run's
workspace.

This access applies to the run detail page. Runs lists, chat, audit timelines,
REST API, MCP, and Slack failure notifications continue to use their existing
failure summaries and diagnostic access rules.

Common causes — a missing provider key, an unauthorized or stale connection, or
a truncated response — are covered in
[Troubleshooting](/agent-studio/troubleshooting/).

## Improving an agent from a run

If a run is wrong, use **Improve the Agent** to describe what should change. TAS
turns the feedback into a pull request via Tembo and correlates the merged PR
back to your submission. See [Improvements](/agent-studio/improvements/).

### Finding a Run as member

Workspace admins can choose another member in the **Run now → Run as** picker.
It initially shows the current user. Enter a name or email and choose **Search**,
then select the member from the results. Search loads at most 25 choices; narrow
the query with an email address when more members match. Labels include email
addresses to distinguish people with the same name. The selected member stays
selected when you search again or a search fails.

Member options load only when requested, rather than loading the whole directory
when opening an agent. Existing admin and membership checks still apply when a
run is submitted.

## How cost estimates work

Agent Studio uses a version-specific catalog of public USD token rates, manually
reviewed against provider pricing and shipped in app releases. It does **not**
refresh prices automatically. The current catalog was verified October 7, 2026.
The run's **Pricing** row links to the provider's source and shows the verification
date and base input/output rates per million tokens.

For example, Sonnet 4.6 is $3 input / $15 output per million tokens; Sonnet 5 and
5.5 are $2 / $10. The same one million input and one million output tokens cost
an estimated $18 versus $12, before caching. Actual task costs also depend on
token usage, tool calls, and caching; a cheaper token rate need not make every
task cheaper.

New completed runs store their rates alongside their cost, so run details and
history keep the same estimate when the catalog changes. Runs from before this
change retain their stored cost and are labeled **Legacy estimate · rates not
recorded**; their per-step token counts remain visible without repricing them.
Unknown model IDs and unsupported variants show no estimate rather than inheriting
a family price. Missing usage can also prevent an estimate.

Cache reads and writes use model-specific rates. Cache writes assume the default
five-minute lifetime; one-hour cache writes are not separately reported by the
runner. GPT-5.4/5.5 and Haiku 5.5 prompt-length tiers are calculated per request,
including cached input, not from the sum of an entire run. If a tiered model's
request usage is incomplete (for example after resuming an older checkpoint),
the total is unavailable rather than guessed.

These are standard token-price estimates, not invoices. They exclude provider
tool fees, regional or service-tier premiums, batch discounts, and negotiated
rates. Use your provider bill for actual charges. The inventory's trailing
30-day average still includes historical runs across model and agent versions;
compare individual runs' model, version, tokens, and saved cost to assess a change.
