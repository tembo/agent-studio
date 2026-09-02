---
title: Deploy on Vercel
description: A production deploy where the Next.js web tier runs on Vercel and the Rust api tier runs on a long-lived host.
---

This guide walks through a production deploy where the Next.js
**web** tier runs on Vercel and the Rust **api** tier runs on a
long-lived host (Fly.io, Render, Railway, or your own box). Vercel
is a great fit for the web side, but a poor fit for the api: the
api owns a runner that spawns subprocesses, polls schedules, and
processes webhooks — none of that maps cleanly to Vercel's serverless
function model.

If you'd rather keep everything on one host, the `docker compose`
path in the
[main README](https://github.com/tembo/agent-studio/blob/main/README.md#running-locally)
works on any VPS unchanged.

## Architecture target

```
Browser ──► Vercel (web)  ──► API host (Rust)  ──► Postgres
              │                    │                  │
              │                    │                  │
              └─ better-auth ──────┴──────────────────┘
                 (Google sign-in)
```

Three services, three vendors. Pick managed Postgres separately so
both tiers connect to the same database.

## 1. Postgres

Spin up a managed Postgres 16-or-newer instance with the `pgcrypto` extension
available (TAS uses `gen_random_uuid()`). Recommended providers:

- **Neon** — generous free tier, branch-friendly for staging.
- **Supabase** — Postgres + auth bundle; only use the Postgres side.
- **Vercel Postgres** — convenient if you don't want a second dashboard.
- **AWS RDS / GCP Cloud SQL** — for an existing cloud account.

Capture the `DATABASE_URL` connection string. It will be used by
**both** the api host and Vercel.

The Rust api applies migrations on boot via `sqlx::migrate!()`, so
no manual migration step is needed — just hand over the URL.

## 2. The api tier (Rust)

Pick a host that supports long-lived Rust processes with outbound
network access. Either build from `api/Dockerfile` or — simpler — deploy
the **published image** `ghcr.io/tembo/tas-api:<version>` (signed +
scanned; see the
[main README](https://github.com/tembo/agent-studio/blob/main/README.md#running-from-published-images-no-source-build)):

- **Fly.io** — `fly launch` against `api/Dockerfile`, or `fly deploy
  --image ghcr.io/tembo/tas-api:<version>`.
- **Render** — point at `api/Dockerfile` (start command `tas-api`), or
  deploy the published image directly.
- **Railway** — same shape; bring the Dockerfile or the image.

:::note
If you want the **whole stack** on Railway (web included) rather than the
Vercel split, follow the [Railway guide](/agent-studio/deploy-railway/) instead
— it runs all three tiers from the published images.
:::

### Required env on the api host

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Postgres connection string from step 1. |
| `TAS_ENCRYPTION_KEY` | 32-byte base64. `openssl rand -base64 32`. **Must match the web tier exactly** — web encrypts secrets, api decrypts them. Rotating this orphans every existing workspace secret. |
| `INTERNAL_API_TOKEN` | Shared bearer the web tier sends on `/internal/*`. `openssl rand -base64 32`. **Must match the web tier exactly.** |
| `RUST_LOG` | `info,tas_api=debug` is a sensible starting filter. |
| `API_PORT` | Whatever port the host expects (Fly defaults to 8080). |

### Public URL

You'll need an HTTPS URL the web tier can reach. Most hosts give you
one automatically (`https://<app>.fly.dev`, `https://<app>.onrender.com`).
Record this — it becomes `API_INTERNAL_URL` on Vercel below.

Optional but recommended: lock down ingress to Vercel's egress IPs
once the deploy is stable. Fly.io and Render both support source-IP
firewalling.

## 3. The web tier (Vercel)

### Import the project

1. Push the repo to GitHub.
2. In Vercel: **Add New Project** → import the GitHub repo.
3. **Root Directory**: `web`. (The repo is a monorepo; Vercel needs
   the web subdirectory.)
4. **Framework Preset**: Next.js (detected automatically).
5. **Build Command**: leave as the Next.js default (`next build`).
6. **Install Command**: `pnpm install`.

### Required env on Vercel

Set these under **Settings → Environment Variables** for all
environments (Production, Preview, Development) unless noted.

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Same Postgres URL as the api host. better-auth queries the user/session tables directly. |
| `BETTER_AUTH_SECRET` | 32-byte base64. `openssl rand -base64 32`. Production-only; preview deploys can share or use their own. |
| `BETTER_AUTH_URL` | Your production URL, e.g. `https://tas.example.com`. Used for cookie/session URLs and OAuth redirect URIs. |
| `TAS_ENCRYPTION_KEY` | Must match the value on the api host byte-for-byte. |
| `INTERNAL_API_TOKEN` | Must match the value on the api host byte-for-byte. |
| `API_INTERNAL_URL` | The api host's public URL from step 2 (e.g. `https://tas-api.fly.dev`). The web tier sends `/internal/runs` requests here. |
| `GOOGLE_CLIENT_ID` | OAuth 2.0 client from [Google Cloud Console](https://console.cloud.google.com/apis/credentials). Redirect URI `${BETTER_AUTH_URL}/api/auth/callback/google`. |
| `GOOGLE_CLIENT_SECRET` | Same. |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` / `MICROSOFT_TENANT_ID` | Optional — Microsoft Entra ID. Redirect URI `${BETTER_AUTH_URL}/api/auth/oauth2/callback/microsoft`. Tenant defaults to `common`. |
| `OIDC_DISCOVERY_URL` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_PROVIDER_NAME` | Optional — any OIDC IdP (Okta/Auth0/Keycloak/…). Redirect URI `${BETTER_AUTH_URL}/api/auth/oauth2/callback/oidc`. |
| `INSTANCE_ADMIN_EMAILS` | **Required to bootstrap.** Comma-separated instance-admin emails. Sign-up is invite-only by default — only these admins can sign in to a fresh deployment and create workspaces / invite others. |
| `TAS_INSTANCE_NAME` | Optional brand label shown on the login screen. |
| `TAS_SIGNUP_POLICY` / `TAS_SIGNUP_ALLOWED_DOMAINS` | Optional. Default invite-only. See [Instance administration](/agent-studio/instance-admin/#sign-up-policy). |
| `TEMBO_API_URL` | Defaults to `https://api.tembo.io`. Override for staging. |

For the Google OAuth client, set the authorized redirect URI to:

```
${BETTER_AUTH_URL}/api/auth/callback/google
```

:::caution[Required for sign-in]
Email/password auth is disabled, so without a Google OAuth client the deploy
shows a "configuration needed" login screen and no one can log in. Set
`BETTER_AUTH_URL` to the final public URL first, register the redirect URI
above on a Google **Web application** client, then set `GOOGLE_CLIENT_ID` /
`GOOGLE_CLIENT_SECRET`.
:::

### Connect a custom domain

Vercel → **Settings → Domains**. Attach your domain and update
`BETTER_AUTH_URL` to match (with `https://`). The Google OAuth client's
authorized redirect URI must match too — easy to forget.

### Deploy

Push to the connected branch. Vercel builds and deploys; the api
host picks up requests on the next webhook / scheduled-run tick.

## 4. Post-deploy checklist

- Sign in with Google through the web URL. The first user becomes
  the workspace admin when they create their first workspace.
- Connect a GitHub repo (Settings → Repository).
- Add a Tembo API key (Settings → Tembo API key) if you want
  chat-to-PR authoring.
- Verify the api host can reach `${API_INTERNAL_URL}/health` from
  Vercel's network. A 401 means `INTERNAL_API_TOKEN` mismatch; a
  network error means firewall / DNS.
- Trigger one manual run and confirm it appears in `/runs`.

## 5. Operational notes

- **Scheduled runs** (the `automation` cron) fire from the web
  container's `instrumentation.ts` scheduler. Vercel runs that on
  every cold start, which is acceptable for v0.4 single-tenant
  loads. If a workspace accumulates dozens of automations firing
  every minute, move the scheduler to the api host (it's the
  longer-lived process). Track via the audit timeline — every
  scheduled fire writes an event.
- **Event triggers** (Composio webhooks) terminate at
  `/api/hooks/composio/{workspace}` on the web tier. Vercel's free tier
  has a 10s function timeout; that's fine for webhook verification
  + enqueue, but won't accommodate any inline work. Keep
  `/api/hooks/*` handlers thin (verify → POST `/internal/runs` →
  return).
- **Audit log size.** The `audit_event` table grows linearly with
  workspace activity. The provided indexes (`workspace_id, at`,
  per-agent, per-source) keep reads fast at ~1M rows. Plan a
  retention policy before that point if your scale demands it —
  TAS does not auto-prune.

## 6. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Sign-in succeeds, then a 401 loop. | `BETTER_AUTH_URL` doesn't match the actual public URL, or the cookie is being set on the wrong domain. |
| `failed to decrypt secret` in api logs. | `TAS_ENCRYPTION_KEY` mismatch between web and api. The secret was encrypted with web's key but api can't decrypt. |
| Runs queue but never start. | `API_INTERNAL_URL` wrong on Vercel, or `INTERNAL_API_TOKEN` mismatch. Check api host logs for 401s on `/internal/runs`. |
| Composio webhooks return 401. | The workspace's `composio_webhook_secret` doesn't match what Composio dashboard expects, or the route is hitting a stale Vercel deploy. |
