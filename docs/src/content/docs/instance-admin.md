---
title: Instance administration
description: Instance admins stand up and run the whole TAS instance — bootstrapping the first account, creating workspaces, setting the instance name, and choosing who may sign up.
---

An **instance admin** sits one level above workspace admins. Where a workspace
admin manages a single workspace, an instance admin manages the **instance
itself** — the deployment that hosts every workspace. This is the person (or few
people) who stood up Tembo Agent Studio (TAS) for your organization.

If you only run agents day to day, you can skip this page — see the
[operator introduction](/agent-studio/introduction/) instead.

## Who is an instance admin

Instance admins come from two places:

- The **`INSTANCE_ADMIN_EMAILS`** environment variable — a comma-separated
  allowlist set at deploy time. This is the bootstrap path: it's what lets the
  first person into a fresh instance, and it stays under the control of whoever
  operates the server (it can't be edited in-app).
- **Instance settings → Instance admins** — any instance admin can grant the
  role to more emails in-app. Added admins can sign in immediately (the
  sign-up gate honors the list); no email is sent, so share the instance
  URL with them. In-app admins can be removed by any other instance admin;
  env-listed ones cannot.

On a **fresh instance**, account creation is **invite-only by default**: the only
people who can sign in are instance admins (env-listed or added in-app) or anyone
holding a pending workspace invitation. So the first instance admin to sign in
bootstraps everything — they can hand setup off right away by adding more
instance admins, or create the first workspace and invite the rest of the team
from there. The sign-up policy can be opened up later (see below).

## What instance admins can do

Beyond everything a workspace admin can do in workspaces they belong to, instance
admins alone can:

- **Create workspaces.** The "Create workspace" action only appears for instance
  admins. Everyone else joins a workspace by invitation.
- **Add and remove instance admins.** Managed under **Instance settings**;
  env-listed admins are shown but only removable by editing the deployment's
  env.
- **Set the instance name and branding.** A dedicated **Instance settings** page
  lives at the top level (`/settings`, outside any workspace) and is visible only
  to instance admins. The instance name shows up in the app shell and sign-in;
  it falls back to the `TAS_INSTANCE_NAME` environment variable until you set one.
- **Set the sign-up policy.** Invite-only (default), an email-domain allowlist,
  or open. See [Sign-up policy](#sign-up-policy).

## Sign-up policy

Account creation defaults to **invite-only** so a freshly deployed instance
stays closed until you choose otherwise. Instance admins change the policy under
**Instance settings → Sign-up policy**. Until an admin saves a value, TAS reads
`TAS_SIGNUP_POLICY` and `TAS_SIGNUP_ALLOWED_DOMAINS` from the environment.

| Policy | Who can create an account |
|---|---|
| **Invite-only** (default) | Instance admins, or anyone holding a pending workspace invitation. |
| **Email-domain allowlist** | Anyone whose **verified** email is at a configured domain (e.g. `acme.com`), plus admins and invitees. Matching is exact — `corp.acme.com` does not match `acme.com`. |
| **Open** | Anyone who can authenticate. |

Workspace membership is **always** by invitation (or instance-admin workspace
creation), even when sign-up is open. Opening sign-up lets people get an account;
it does not let them create workspaces or join existing ones on their own.

**Verified email.** The domain allowlist only matches emails the sign-in provider
marked verified (`email_verified`). Google, Microsoft, and typical OIDC IdPs do.
Email/password sign-up cannot prove domain membership (there is no SMTP), so those
users still need an invite or an instance-admin grant.

Env values, if you prefer not to use the UI:

- `TAS_SIGNUP_POLICY` — `invite_only` (default), `domain_allowlist`, or `open`.
  Hyphens are accepted (`invite-only`).
- `TAS_SIGNUP_ALLOWED_DOMAINS` — comma-separated hostnames without `@`.

## Instance settings vs. workspace settings

It's worth keeping the two scopes straight:

| | Instance admin | Workspace admin |
|---|---|---|
| **Scope** | The whole deployment | One workspace |
| **Set up by** | `INSTANCE_ADMIN_EMAILS` env var, or added in Instance settings | Invited + assigned the `workspace_admin` role |
| **Manages** | Instance name/branding, sign-up policy, creating workspaces, hosting | Members & roles, repository, provider keys, connections, Slack apps |
| **Settings home** | `/settings` (top level) | `/<workspace>/settings` |

For the workspace side, see [Settings](/agent-studio/settings/) and
[Audit & roles](/agent-studio/audit-and-roles/). For standing up the deployment
in the first place — provider keys, the Tembo API key, architecture, and the
platform guides — see the [admin introduction](/agent-studio/admin-introduction/)
and the [setup checklist](/agent-studio/customer-setup/).
