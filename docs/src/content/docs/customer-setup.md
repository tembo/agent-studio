---
title: Setup checklist
description: Everything a new customer needs to procure and do to stand up a working Tembo Agent Studio instance, starting from nothing.
---

Everything a new customer needs to **procure** and **do** to stand up a working
Tembo Agent Studio instance, starting from nothing. Each item is tagged
**Required** or **Optional**.

For platform-specific deploy mechanics, see the companion guides:
[Railway](/agent-studio/deploy-railway/) (easiest),
[AWS](/agent-studio/deploy-aws/), [Vercel](/agent-studio/deploy-vercel/). The
full env reference lives in
[`.env.example`](https://github.com/tembo/agent-studio/blob/main/.env.example).

:::note[Mental model]
TAS is single-tenant: one instance is one organization on your own server.
Agents run on **your** LLM provider keys (Anthropic/OpenAI) — Tembo is only
involved in the optional chat-to-PR *authoring* flow. The instance is
**invite-only by default**, bootstrapped by `INSTANCE_ADMIN_EMAILS`. An instance
admin can later open sign-up (domain allowlist or fully open) under Instance
settings — see [Instance administration](/agent-studio/instance-admin/#sign-up-policy).
:::

## Phase 1 — Procure (accounts & keys)

**Infrastructure**

- [ ] **A host that runs Docker** — Railway (easiest), AWS/ECS, or any VM with
  Docker Compose. **Required.**
- [ ] **Postgres 18** — a managed instance with backups (recommended for
  production) or the bundled Postgres container. **Required.**
- [ ] **A domain + TLS** for the public origin (e.g. `agents.acme.com`). The
  platform usually terminates TLS. **Recommended** — you can start on the
  platform-provided URL.

**Authentication** *(Optional for a quickstart)* — with no OAuth provider
configured, the login screen offers **email + password** (sign-up still gated
by `INSTANCE_ADMIN_EMAILS` / invites), so there's nothing to procure. For
production SSO, pick one provider — configuring it turns email/password off
automatically:

- [ ] **Google OAuth** *(easiest)* — create an OAuth 2.0 client at
  <https://console.cloud.google.com/apis/credentials>; or
- [ ] **Microsoft Entra ID** — register an app; note client ID, secret, tenant; or
- [ ] **Generic OIDC** (Okta, Auth0, Keycloak, …) — get the
  `.well-known/openid-configuration` URL + client ID/secret.

**To run agents** *(Required)*

- [ ] **Anthropic API key** and/or **OpenAI API key** — at least one. Agents
  execute on these keys, not Tembo's.
  (<https://console.anthropic.com> / <https://platform.openai.com>)

**Agent storage** *(Required)*

- [ ] **A GitHub repository** to hold agent spec files, plus a **GitHub PAT** for
  TAS to read/write it.

**Optional add-ons**

- [ ] **Tembo API key** — only for the chat-to-PR authoring flow (the "New agent",
  "chat to edit", and "Improve" buttons). Agents run fine without it; you'd
  hand-write specs instead. (<https://tembo.io>)
- [ ] **Composio API key** — only if agents need tool connections (Slack, Google
  Sheets, Gmail, …). (<https://app.composio.dev/developers>)

## Phase 2 — Generate secrets

Generate each with `openssl rand -base64 32`:

- [ ] `BETTER_AUTH_SECRET` — signs sessions.
- [ ] `TAS_ENCRYPTION_KEY` — AES-256-GCM master key for stored workspace secrets.
  Treat it like a DB master credential: **rotating it orphans every stored key**
  (they become undecryptable). The same value must go to **both** the web and api
  services.
- [ ] `INTERNAL_API_TOKEN` — gates web→api internal calls. Same value on **both**
  services.

## Phase 3 — Deploy & configure env

- [ ] **Choose images.** Pull prebuilt from **GHCR** (`compose.release.yaml`, pin
  `TAS_VERSION` to a released CalVer tag) or build from source
  (`docker-compose.yml`).
- [ ] **Set core env** on the web + api services:
  - `DATABASE_URL`, `TAS_ENCRYPTION_KEY`, `INTERNAL_API_TOKEN` — **both** services.
  - `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (= your public origin) — web.
  - **Sign-in** — *optional for a quickstart.* Leave all OAuth vars blank and the
    login screen offers **email + password** (no OAuth app to set up). For
    production, set one OAuth provider instead — `GOOGLE_CLIENT_ID`/
    `GOOGLE_CLIENT_SECRET`, or `MICROSOFT_CLIENT_ID`/`MICROSOFT_CLIENT_SECRET`/
    `MICROSOFT_TENANT_ID`, or the `OIDC_*` set — and email/password turns off
    automatically.
  - **`INSTANCE_ADMIN_EMAILS`** — comma-separated email(s) that bootstrap the
    instance admin. **This is what lets the first person in**; sign-up is
    invite-only by default (it gates email/password sign-up too).
  - `TEMBO_API_URL` — leave the default `https://api.tembo.io` unless targeting a
    staging environment.
- [ ] **Set the OAuth provider's redirect URI** to match your origin *(skip if
  using email/password)*:
  - Google: `${BETTER_AUTH_URL}/api/auth/callback/google`
  - Microsoft: `${BETTER_AUTH_URL}/api/auth/oauth2/callback/microsoft`
  - OIDC: `${BETTER_AUTH_URL}/api/auth/oauth2/callback/oidc`
- [ ] **Deploy.** Database migrations apply automatically when the api container
  boots.

## Phase 4 — First run (as instance admin)

- [ ] Open the URL — the **first-run setup screen** lets you set the **instance
  name** before signing in.
- [ ] **Sign in** with an email listed in `INSTANCE_ADMIN_EMAILS`. You become the
  first user and the instance admin.
- [ ] *(Optional)* **Hand setup to someone else** — add their email under
  **Instance settings → Instance admins** and share the URL. They can sign in
  immediately with full instance-admin access; no env edit needed.
- [ ] **Create your first workspace** (only instance admins can create
  workspaces).

## Phase 5 — Per-workspace setup

- [ ] **Settings → Repository** — connect the GitHub repo (URL + PAT) where agents
  live.
- [ ] **Settings → LLM Providers** — add the Anthropic and/or OpenAI key.
  *Without this, agents can't run.*
- [ ] *(Optional)* **Settings → Composio** — add the Composio key if agents use
  connections.
- [ ] *(Optional)* **Settings → Tembo Coding Agent** — add the Tembo key to enable
  chat-to-PR authoring.
  - [ ] **Authorize the repo in Tembo, too.** For Tembo to open PRs against
    your agents repo, that repo must be connected in Tembo's own dashboard
    under **Source Control**:
    `https://app.tembo.io/<your-tembo-workspace>/settings/integrations?category=Source+Control`.
    Without this, authoring requests fail even with a valid Tembo API key.
- [ ] **Settings → Members** — invite teammates. TAS gives you a copy-paste invite
  template; invited users drop straight into the workspace on first sign-in.

## Phase 6 — Create agents

- [ ] **With a Tembo key** — use "New agent" / "Improve"; Tembo opens a PR against
  your connected repo.
- [ ] **Without a Tembo key** — commit agent spec files (YAML/JSON) to the repo
  directly.
- [ ] **Run** an agent ("Run now"), or attach a schedule.

## The four things people most often forget

1. **`INSTANCE_ADMIN_EMAILS`** — without it, nobody can sign in.
2. **The OAuth redirect URI** — a mismatch makes sign-in 400.
3. **An LLM provider key per workspace** — without it, runs fail.
4. **Tembo is optional** — it powers authoring, not running.
