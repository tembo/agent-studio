---
title: Authoring agents
description: How to create and change agents through chat-to-PR, what's in a Pydantic AgentSpec, and how to pick a model.
---

Agents are authored as files and changed through pull requests. You can write
those files directly, but the usual path is to describe what you want and let
TAS open the PR for you.

## Creating an agent from chat

Describe the agent you want — its job, its tone, the services it should use. TAS
hands the request to the [Tembo Coding Agent Platform](https://tembo.io), which
writes the agent file and opens a pull request against your repo. Review and
merge it; the agent then shows up in the **Agents** list. (This requires a Tembo
API key in **Settings**.)

Not sure what to ask for? [Example Agents](/agent-studio/example-agents/) has
ready-to-use, copy-paste prompts (email triage, ticket roundups, …) that adapt
to whatever you've connected.

## The agent file (Pydantic AgentSpec)

A minimal agent is a YAML file under `agents/pydantic-agentspec/`:

```yaml
name: standup-summary
model: anthropic:claude-sonnet-5
description: Summarize yesterday's commits into a standup note.
instructions: |
  When invoked, summarize the team's activity in three bullet points.
  Be concise and factual.
```

Key fields:

- **`name`** (required) — the slug identifier; must match the filename
  (`name: foo` → `foo.yaml`); lowercase letters, digits, hyphens. It's the
  stable key for URLs, runs, and automations, so don't change it after creation.
- **`title`** (optional) — a free-text display name shown in the UI (e.g.
  `title: "Inbox Triage"`). When you create an agent you can type any name; the
  filename slug is derived from it and the text is saved as `title`. The UI falls
  back to `name` when there's no title.
- **`model`** (required) — `provider:model`, e.g. `anthropic:claude-sonnet-5`,
  `anthropic:claude-opus-4-8`, `anthropic:claude-fable-5`, `openai:gpt-5.5`,
  `openai:gpt-4o-mini`. The provider's key must be set in
  **Settings → LLM Providers**.
- **`instructions`** (required) — the system prompt, usually a `|` block scalar.
- **`connections:`** (optional) — external services the agent calls; see
  [Connections](/agent-studio/connections/).
- **`tools_module:`** (optional) — a sibling Python file of deterministic tool
  functions; see [Sidecar Python tools](/agent-studio/sidecar-python-tools/).
- **`labels:`** (optional) — tags used for grouping and for scoping which
  [Slack app](/agent-studio/slack-apps/) may launch the agent.
- **`scaledown:`** (optional) — opt into [ScaleDown](#scaledown-prompt-compression)
  prompt compression to cut frontier-model tokens (`off` / `prompt` /
  `aggressive`).
- **`skills:`** (optional) — names of [Skills](/agent-studio/skills/) to load,
  giving the agent reusable instructions/procedures on top of `instructions`.
- **`delivery:`** (optional) — describe where this agent intends to deliver its
  result and what durable evidence TAS can observe. The declaration is
  snapshotted on each run, so later edits do not rewrite output history.

  ```yaml
  delivery:
    note: Daily brief for the account team
    destinations:
      - key: tasks-inbox
        label: Tasks Inbox
        evidence:
          type: inbox_item
      - key: email
        label: Email
        evidence:
          type: tool_call
          tool: GMAIL_SEND_EMAIL
  ```

  Destinations are agent-defined — use any stable `key` and human-readable
  `label`. Evidence can be an `inbox_item` produced by the run or a named
  `tool_call`. TAS records the tool name and success only; tool arguments and
  results remain unstored because they may contain secrets or personal data.

  Only add `delivery` when the agent is actually expected to publish its result
  outside its own run. Omit it when the agent only returns output to its caller.
  `delivery` describes destinations and evidence; use `output_schema` when you
  need to control the response shape.

  Evidence is scoped to the exact run carrying the declaration. If an
  orchestrator delegates delivery to a sub-agent, put `delivery` on the
  sub-agent that creates the inbox item or calls the delivery tool. Sub-agent
  evidence does not roll up into the orchestrator's declaration.
- **`model_settings:`** (optional) — a map of model knobs passed through to the
  model, e.g. `max_tokens`, `temperature`, `parallel_tool_calls`. TAS defaults
  `parallel_tool_calls: false` (so tools run one at a time unless you set it
  `true`) and, for Anthropic models, enables prompt caching — both overridable
  here.

  ```yaml
  model_settings:
    max_tokens: 6144
    temperature: 0.2
  ```
- **`request_limit:`** (optional) — cap the number of model requests in a single
  run (Pydantic AI `UsageLimits`). Defaults to 50; lower it to bound cost/looping
  on a tool-heavy agent.
- **`retries:`** (optional, int) — how many times a failing tool call may be
  retried within a run.
- **`instrument:`** (optional, bool) — toggle Pydantic AI run instrumentation
  (OpenTelemetry spans) for this agent.

Your connected repo also carries an authoring guide (`AGENTS.md` and per-framework
`AGENT_GUIDE.md`) that TAS keeps current — that's the canonical, always-up-to-date
field reference for coding agents.

### Built-in run date and time

Every Pydantic agent has a **`get_run_datetime`** tool; no connection or agent
file setting is required. Use it for relative date windows, date-based deduplication,
and any task that depends on "today." It returns the UTC instant when the run
entered `running`, plus local date/time fields in an optional IANA timezone such
as `America/Los_Angeles`. The instant stays fixed for the entire run, including
runs that cross midnight.

## Choosing a model

Model choice is a cost/reliability tradeoff:

- **Default to `anthropic:claude-sonnet-5`** for most agents, tools or not.
  It's the most agentic Sonnet yet — decisive about when to act, so it doesn't
  *hedge* ("would you like me to…") the way earlier Sonnet and mini tiers do —
  with reasoning and tool use close to Opus 4.8 at lower cost.
- **Need more than Sonnet 5?** Step up to `anthropic:claude-opus-4-8`, and to
  `anthropic:claude-fable-5` (Anthropic's most capable, Mythos-class) for the
  hardest reasoning and long-horizon agentic work — reach for Fable only when
  Opus 4.8 isn't enough.
- **Cheaper, simpler jobs.** `anthropic:claude-haiku-4-5` and the mini tiers
  are fine for no-tools or high-volume work with a single, well-defined job and
  imperative instructions; they tend to hedge on tool calls, so prefer Sonnet 5
  for anything that declares `connections:`. Compare cost side-by-side on the
  [Runs](/agent-studio/dashboard-and-runs/) page.

## ScaleDown prompt compression

[ScaleDown](https://scaledown.ai) is an optional prompt-compression layer: bulky
context is routed through a small model that rewrites it to far fewer tokens
while preserving the query, so you spend fewer tokens on the expensive frontier
model. It's **opt-in per agent** and a **no-op** unless a workspace
**ScaleDown API key** is set under
[Settings → LLM Providers](/agent-studio/settings/#llm-providers).

Enable it with the `scaledown:` field:

```yaml
name: long-research
model: anthropic:claude-opus-4-8
scaledown: prompt          # off (default) | prompt | aggressive
instructions: |
  …
```

Modes:

- **`off`** (default, or field absent) — no compression; runs are byte-identical
  to having no key.
- **`prompt`** — compress the static `instructions` **once** at startup. The
  safe, recommended default: it's lossy only on your own system prompt, adds no
  per-turn latency, and is **cache-friendly** — the compressed instructions are
  identical every turn, so Anthropic prompt caching still hits (on a *smaller*
  prefix).
- **`aggressive`** — also compress bulky history blocks (large tool outputs,
  user context) on each turn. Best for long, tool-heavy, cost-sensitive runs.
  Each block is **compressed once and frozen** (memoized by content), so
  repeated turns send identical bytes and prompt caching keeps working instead
  of thrashing. Message structure (tool calls / tool results) and the most
  recent turn are left untouched.

Object form tunes it:

```yaml
scaledown:
  mode: aggressive
  rate: auto             # ScaleDown compression rate
  min_tokens: 400        # only compress blocks larger than this
```

**Notes**

- **Lossy by design.** Compression drops detail to save tokens. Start with
  `prompt`; move to `aggressive` only where token cost matters and you've
  confirmed quality holds.
- **Best-effort.** If ScaleDown is unreachable or errors, the original text is
  used — a run never fails because of compression.
- **Where to see it.** Token savings are logged in the instance/container logs
  (`[scaledown] N → M tokens`); they are not yet surfaced in the run-detail UI.

## Iterating

- **Chat-to-edit** — probe the live draft in the agent chat surface, then submit
  a change request that opens a PR. See
  [Agent lifecycle](/agent-studio/agent-lifecycle/).
- **Improve the Agent** from any run turns feedback into a PR — see
  [Improvements](/agent-studio/improvements/).
- **Promote** a draft to a stable version when you're happy with it; automated
  runs serve stable by default. See
  [Agent lifecycle → promoting](/agent-studio/agent-lifecycle/#promoting-to-stable).

## Your agent list, stars, and forking

All members' agents live in one repo, so the agents list can get crowded. To
keep your day-to-day view tidy:

- **Star** any agent with the ☆ on its row. Stars are personal; they don't
  change the shared repo or the `labels:` taxonomy. Use separate **Owner**
  (**Me** or **Others**) and **Starred** (**True** or **False**) filters to
  combine ownership and star status however you need.
- Search finds agents by name, description, label, model, or connection. Rows
  default to most recently run (agents with no run history come last); use the
  **Sort** menu for name, status, trailing-30-day runs/cost/success, or recent
  activity. Click anywhere on a live-agent row except its explicit controls to
  open it. The trailing-30-day count, average cost, and success rate stay hidden
  until the agent has at least one run in that window; missing model or cost
  values are left blank instead of showing placeholder dashes.
- Add structured filters from **Add filter**. Each active filter is an editable
  pill, and the list updates immediately when you change or remove it. Click
  **is** to switch a filter to **is not**; list-valued filters accept multiple
  selections and match any selected value. Alongside owner, star status,
  status, label, model, and connection filters, you can filter agents by the
  observed **Orchestrator** or **Sub-agent** role, or show only the sub-agents
  called by a particular orchestrator. These relationships come from run
  history; they are not fields in the agent spec, and an agent can match both
  roles in a nested workflow.
- The built-in **All** and **Mine** views are always available and cannot be
  renamed or deleted. Changing their filters marks the view **Unsaved**;
  choosing **Save** creates a custom view without changing the built-in.
- Choose **New view** to name and save the current search, filters, and sort.
  Personal views are visible only to you; shared views are available to every
  member of the workspace. You can keep editing filters while naming a view and
  watch the result list update before you save it. Changing an owned saved view
  keeps it selected, marks it **Unsaved**, and reveals **Save** so you can
  update it in place. Customizing a shared view that you cannot edit creates a
  custom copy instead. Use **Edit view** to rename a custom view or change its
  visibility.
- **Fork** an agent (the **Fork** button on its page) to make your own editable
  copy. The copy is named with an **owner prefix** — `sales-gen` forked by `ryw`
  becomes **`ryw.sales-gen`** — so two people can each keep their own without a
  name collision, and the fork is owned by you (so it shows in your default
  list). A forked tool-using agent shares the original's `tools_module:` file
  (same folder) until you change it. Forking copies the spec verbatim; edits go
  through the usual PR flow.

The optional `<handle>.` prefix is the only place a dot is allowed in an agent
name — plain names stay kebab-case (`a-z0-9` and hyphens).
