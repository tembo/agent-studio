---
title: Audit & roles
description: The append-only audit timeline and the workspace role model.
---

## Audit

The **Audit** timeline is an append-only record of every change in the
workspace — who did what, from which source, against which agent, and when. It's
filterable by source, actor, agent, and time, and exportable as JSON. Because
agent changes are pull requests and runs are recorded, the audit trail answers
"what changed and who changed it" without reconstructing it after the fact.

## Roles

Workspace membership has three roles, enforced at the API layer:

| Role          | Can do                                                           |
| ------------- | --------------------------------------------------------------- |
| **Admin**     | Manage members, settings, and connections; everything operators can do. |
| **Operator**  | Author, run, and improve agents; authorize their own connections. |
| **Viewer**    | Read agents, runs, and dashboards.                              |

Manage members and their roles under **Settings → Members**. Workspace admins
can open a [member detail view](/agent-studio/dashboard-and-runs/#member-detail-admins)
to inspect connections, automations, and runs before offboarding someone.
When removing a member, TAS shows how many automations run as that person. The
admin can reassign all of them to another current member in the removal step;
if no replacement is selected, enabled schedules are paused before membership
is removed. The last workspace admin still cannot be removed.

## Instance admins

Above workspace roles, **instance admins** are bootstrapped from
`INSTANCE_ADMIN_EMAILS` at deploy time; existing instance admins can add more
in-app under **Instance settings** (sidebar, or the user menu). An instance admin can:

- Set the instance name, branding, **run queue**, and **sign-up policy** (**Instance settings**)
- Add and remove other instance admins (**Instance settings**)
- **Create workspaces** (only instance admins see "Create workspace")
- Access any workspace they're a member of with their assigned workspace role

Everyone else joins a workspace via invitation. On a fresh instance, sign-up is
invite-only: the first person to sign in with an email listed in
`INSTANCE_ADMIN_EMAILS` becomes an instance admin and can create the first
workspace. The sign-up policy can later be opened to a domain allowlist or to
anyone — see [Instance administration](/agent-studio/instance-admin/#sign-up-policy).
See [Setup checklist](/agent-studio/customer-setup/) for the bootstrap checklist.
