---
title: Settings
description: Workspace keys, members, Slack apps, appearance, and destructive operations.
---

**Settings** is where you wire up the keys, people, and integrations a workspace
needs. Open it from the left sidebar; tabs are listed along the top of the
settings page.

## LLM Providers

Add an **Anthropic** and/or **OpenAI** key. At least one is required for agents
to run; until one is set, the sidebar shows an **"LLM provider needed"** prompt.

A third, optional key lives here too: a **ScaleDown API key**
([scaledown.ai](https://scaledown.ai)) enables prompt compression to cut
frontier-model token usage. Setting the key does nothing on its own — each agent
opts in via the `scaledown:` field in its spec. See
[ScaleDown prompt compression](/agent-studio/authoring-agents/#scaledown-prompt-compression).

## Composio

Two fields, both required for [event triggers](/agent-studio/automations-triggers/#composio-event-triggers):

- **Composio API key** — authenticates Tool Router sessions for Composio-backed
  [connections](/agent-studio/connections/).
- **Composio webhook secret** — HMAC secret Composio signs trigger webhooks with.
  The settings page shows your workspace webhook URL
  (`/api/hooks/composio/{workspace}`); point your Composio app at it and paste
  the matching secret here.

Per-user OAuth for individual toolkits happens on the **Connections** page, not
here.

## Tembo Coding Agent

Each member can connect **Your Tembo account** with a personal Tembo API key.
New-agent chat, chat-to-edit, and
[improvements](/agent-studio/improvements/) then create Tembo Coding Agent
sessions under that member's Tembo identity. When their Tembo account has
GitHub connected, Tembo also uses that GitHub identity to open the resulting
pull request.

The **Workspace fallback account** preserves shared setup: when a member has no
personal key, TAS uses this workspace-level Tembo API key instead. If neither is
connected, agents still run normally, but Tembo-backed authoring is unavailable
and spec changes must be committed by hand.

For Tembo to open PRs, the agents repo must also be authorized in Tembo under
**Source Control** (see [Setup checklist](/agent-studio/customer-setup/)).

**Improvements delivery** sets how those changes land: **Always PR** (default —
a reviewable pull request) or **YOLO**, which commits straight to the default
branch with no PR. See [Improvements → Delivery mode](/agent-studio/improvements/#delivery-mode-always-pr-vs-yolo).

## Repository

Connect the workspace's GitHub repository (URL + PAT). TAS stores agent
definitions under `agents/` and reads/writes through the GitHub API. See
[Getting started → Connect a GitHub repository](/agent-studio/getting-started/#3-connect-a-github-repository)
for PAT scopes.

## Members

Add and remove workspace members, set their [roles](/agent-studio/audit-and-roles/)
(admin / operator / viewer), and copy an invite template. **TAS does not send an
email when you add someone.** The workspace admin must copy the invitation
message and send it to the new member directly. Invited users join the workspace
on first sign-in. Workspace admins can click a member to open their [member
detail view](/agent-studio/dashboard-and-runs/#member-detail-admins).

## Slack apps

**Admin only.** Create and install [TAS-managed Slack bots](/agent-studio/slack-apps/)
that launch label-scoped agents from Slack. Each app gets a coached manifest,
credential fields, and an **Add to Slack** OAuth flow.

## Appearance

- **Theme** — pick a curated theme or customize colors. Stored locally in your
  browser.
- **Favicon** — choose a default pattern or upload a PNG/SVG for the workspace's
  browser tab icon.

## Deleted agents

Lists agents removed from the workspace so you can **restore** them. Restore writes
the file back to the connected repo with a new commit; the deletion record stays
in [Audit](/agent-studio/audit-and-roles/).

## Version

Shows the running TAS CalVer release baked into the deployed image — useful for
confirming an upgrade landed.

## Danger

**Admin only.** **Delete workspace** permanently removes all workspace data
(members, runs, schedules, connections, secrets, settings, audit, invitations).
Your GitHub repository and its agent files are **not** affected. Requires
type-to-confirm.

## Instance settings

Above the workspace settings rail, instance-level configuration (instance name
and branding) lives at the top-level **Settings** page, available to
[instance admins](/agent-studio/audit-and-roles/#instance-admins). For standing
up and operating the instance itself, see
[Deploying & operating](/agent-studio/admin-introduction/).

## Secrets handling

All API keys and tokens are encrypted at rest and shown only as masked previews
— they're never returned to the browser in full.
