---
title: Agent lifecycle
description: Draft vs stable versions, promotion, ownership, chat-to-edit, pending agents, and restore.
---

Agents move through a predictable lifecycle from first idea to production
behavior. This page covers the stages TAS tracks beyond what's in the Git file
itself.

## Draft and stable

Every agent has two runtime surfaces:

| Surface | What it is | Used by |
| ------- | ---------- | ------- |
| **Draft** | The live file on your repo's default branch | The agent **chat** surface and **Run now** by default (probe and iterate) |
| **Stable** | A numbered snapshot frozen in the database after promotion | Schedules, [Slack](/agent-studio/slack-apps/), [webhooks](/agent-studio/automations-triggers/), and [triggers](/agent-studio/automations-triggers/) by default; optional for **Run now** |

Until you promote a stable version, everything runs the draft. After promotion,
automated paths use stable for predictability while chat and manual runs default
to the draft so you can test changes without surprising production. The manual
run confirmation names the exact version and can switch to a numbered stable
snapshot.

See [Core concepts → versioning](/agent-studio/core-concepts/) for the mental
model.

## Promoting to stable

On the agent detail page, **Promote to Stable (vN)** snapshots the current draft
as the next numbered version and makes it the default for automated runs.

When a draft differs from stable, TAS marks it as **Needs promotion** in the
Agents inventory and on the agent's **Versions** navigation. The inventory badge
shows the number of added and removed lines, along with when the draft and
stable version last changed. Operators and admins also see an **Action needed**
entry in the workspace sidebar. Use its **Review** link to open the affected
agent directly, or to filter the inventory to all drafts awaiting promotion.

These notices never promote a draft automatically. They clear after you promote
the draft, or after you revert the live file so its content matches stable.

- **Who can promote** — the agent's **owner**, or any workspace **admin**. An
  admin who isn't the owner sees a warning before confirming.
- **When it's available** — only when the draft differs from the current stable
  (or no stable exists yet). A broken draft (parse errors) can't be promoted.
- **What it records** — who promoted, when, and the version number. The
  **Versions** section lists every stable snapshot; compare them to see what
  changed when behavior shifted.   The **Versions** tab has a bar for Definition, Evals, Eval file, and
  Code. Evals are optional — agents without a sidecar are not gated. If
  the agent has an eval file, Promote is blocked until assertions pass
  on this draft.

Schedules can opt into running the **draft** instead of stable — useful for
dogfooding before promotion.

## Agent ownership

Each agent can have an **owner** — a workspace member responsible for promoting
changes. Set or change the owner on the agent detail page. Ownership matters for:

- The promote gate (owner or admin)
- Knowing who to ask when an agent misbehaves
- [Member detail](/agent-studio/dashboard-and-runs/#member-detail-admins) and
  offboarding checks

An agent with no assigned owner can still be promoted by any admin.

## Creating agents

### From chat (Tembo)

Describe a new agent; TAS hands the request to the
[Tembo Coding Agent Platform](https://tembo.io) and opens a PR. Requires a Tembo
API key in **Settings → Tembo Coding Agent**. See
[Authoring agents](/agent-studio/authoring-agents/).

### Pending agents

While the PR is open, the agent appears in the **Agents** list with status
**Pending**. Operators can **Dismiss** a pending create to stop tracking it in
TAS — the GitHub PR is left alone and remains reachable from Tembo links.

### By hand

Commit a spec file directly to the connected repo under
`agents/pydantic-agentspec/`. TAS picks it up on the next sync.

## Chat-to-edit

Open an agent and use the **chat** surface to probe its behavior against the
live **draft** — chat always runs the draft, not stable. When something needs to
change, submit a change request from the chat thread. TAS opens a PR via Tembo
(same as new-agent authoring). Review and merge; the draft updates on your
default branch.

This is separate from **Improve the Agent** on a run, which anchors feedback to a
specific execution — see [Improvements](/agent-studio/improvements/).

## Deleting and restoring

**Delete agent** removes the file from the connected repo (via a commit) and
records the deletion in [Audit](/agent-studio/audit-and-roles/). Deleted agents
appear under **Settings → Deleted agents** so you can **restore** them — restore
writes the file back with a new commit.

## Workspace deletion

**Settings → Danger → Delete workspace** removes all workspace data (members,
runs, schedules, connections, secrets, audit) but does **not** touch your
GitHub repository or its agent files. Admin-only, type-to-confirm. See
[Settings](/agent-studio/settings/).
