---
title: Roadmap
description: Where Tembo Agent Studio is headed.
---

Ideas we're exploring to make Tembo Agent Studio better — in no particular
order, and none of it promised or dated. Each idea links to a GitHub Discussion
with a draft **TASIP** (Tembo Agent Studio Improvement Proposal) where you can
weigh in: tell us your use case, push back, or 👍 the ones you want most. Your
input is what moves an idea from "maybe" to scheduled work.

## Behavior variants

When two teams want an agent to behave differently — terse for support, chatty
for sales — TAS proposes a *variant* instead of silently averaging contradictory
feedback. Each variant keeps its own lineage and history, so you can run
team-specific behavior safely or reconcile them later.

[Discuss & shape it →](https://github.com/tembo/agent-studio/discussions/96)

## Human-in-the-loop steps

Let an agent pause mid-run to ask a person for a decision or input through a
structured form, then resume with the answer. This unlocks workflows that need
human judgment at a checkpoint — approval, disambiguation, sign-off — without
giving up automation everywhere else.

[Discuss & shape it →](https://github.com/tembo/agent-studio/discussions/97)

## Cross-deployment learning

Optionally let independent TAS deployments exchange behavioral *patterns* — never
raw data — under explicit policy (island by default, share-only, receive-only,
or both). Stop reinventing the same agent improvements in parallel while keeping
strict data isolation; every imported pattern still lands as a reviewable PR with
its origin attached.

[Discuss & shape it →](https://github.com/tembo/agent-studio/discussions/100)

## Self-extending TAS

Point your instance at your own fork so a Tembo coding agent can build the
platform extensions you need — a new connection type, a custom substrate — and
PR them back, staying upgrade-safe with upstream. Deep integrations without
waiting on the core roadmap.

[Discuss & shape it →](https://github.com/tembo/agent-studio/discussions/101)

## Org-level policy templates

Define governance policy once at the org level (e.g. "high-audit" vs
"light-touch") and have workspaces inherit it — tightening but not loosening.
Enterprises get consistent guardrails across many teams without micromanaging
each workspace.

[Discuss & shape it →](https://github.com/tembo/agent-studio/discussions/102)

## Agent labels & grouping

Group the agents list and dashboards by label — sales, support, compliance — so
a large agent footprint stays navigable, and use labels to scope things like
which Slack app can launch which agents. (Labels already exist; this adds the
group-by views.)

[Discuss & shape it →](https://github.com/tembo/agent-studio/discussions/103)

## Richer trigger setup

Replace free-text trigger entry with schema-driven config forms pulled from each
provider, so setting up an event trigger is discoverable and self-documenting
instead of memorizing slugs.

[Discuss & shape it →](https://github.com/tembo/agent-studio/discussions/105)

## Audit streaming to your SIEM

Stream audit events to your security tooling (Datadog, Splunk, …) in real time,
not just exported snapshots, so you can correlate TAS activity with the rest of
your compliance infrastructure and alert on it.

[Discuss & shape it →](https://github.com/tembo/agent-studio/discussions/106)

## Have a different idea?

Open a discussion in the
[Ideas category](https://github.com/tembo/agent-studio/discussions/categories/ideas)
— that's where roadmap ideas start.
