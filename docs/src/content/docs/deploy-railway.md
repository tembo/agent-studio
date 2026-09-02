---
title: Deploy on Railway
description: A production deploy where all three tiers run on Railway from the prebuilt GHCR images — no source build.
---

This guide walks through a production deploy where **all three tiers
run on Railway** from the prebuilt GHCR images — no source build. Unlike
the [Vercel split](/agent-studio/deploy-vercel/) (web on Vercel, api elsewhere),
Railway runs the full stack on one vendor: the api is a long-lived
process that spawns subprocesses and polls schedules, which Railway
handles natively.

If you'd rather keep everything on your own box, the
[published-images compose path](https://github.com/tembo/agent-studio/blob/main/README.md#running-from-published-images-no-source-build)
in the main README works on any VPS unchanged.

## Architecture target

```
Browser ──► web (public domain)
              │  private network (IPv6)
              ├──────────► api ──────────► Postgres
              └──────────────────────────────┘
                 both services query Postgres directly
```

Three Railway services in one project/environment. The images are
public on GHCR, so there's no registry auth to configure:

- `ghcr.io/tembo/tas-api`
- `ghcr.io/tembo/tas-web`

Postgres is Railway's managed plugin — the upstream `postgres` image
is never republished by TAS.

## 1. Project + Postgres

1. Create a new Railway project.
2. **Add → Database → PostgreSQL.** Railway provisions PostgreSQL (16 or newer) and
   exposes a `DATABASE_URL` you reference from the other services as
   `${{Postgres.DATABASE_URL}}` (the private-network URL — use this, not
   the public one).

The Rust api applies migrations on boot via `sqlx::migrate!()`, so
there's no manual migration step — just hand both services the URL.

## 2. The api service

**Add → Service → Deploy from Docker Image** → `ghcr.io/tembo/tas-api:2026.5.31`
(pin a version; don't track `latest`).

### Required variables

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}`. |
| `TAS_ENCRYPTION_KEY` | 32-byte base64. `openssl rand -base64 32`. **Must match the web service exactly** — web encrypts secrets, api decrypts them. Rotating it orphans every existing workspace secret. |
| `INTERNAL_API_TOKEN` | Shared bearer the web service sends on `/internal/*`. `openssl rand -base64 32`. **Must match the web service exactly.** |
| `API_MAX_CONCURRENT_RUNS` | Optional; maximum agents executing in this api service at once (default `4`). Extra runs stay queued. Lower this when Python runner processes approach the service's memory limit. |
| `API_RESERVED_SUB_AGENT_RUNS` | Optional; slots reserved for sub-agents launched by an orchestrator (default: half of the maximum, so `2` when the maximum is `4`; must be lower than the maximum). Set `0` if the instance does not use orchestrators. |
| `RUST_LOG` | `info,tas_api=debug` is a sensible start. |

Put `TAS_ENCRYPTION_KEY` and `INTERNAL_API_TOKEN` in Railway **shared
variables** so the two services can't drift.

### Networking

- **No public domain** — the api is reached only by the web service over
  Railway's private network. Its private address is
  `<service-name>.railway.internal` (e.g. `api.railway.internal`).
- **IPv6 / the one gotcha.** Railway's service-to-service network is
  IPv6-only. TAS images **from `2026.5.31` onward bind dual-stack
  (`[::]:8080`) by default**, so the api is reachable with no extra
  config. If you pin an image *older* than `2026.5.31`, add
  `API_BIND_ADDR=[::]:8080` — without it the api binds IPv4-only and the
  web service can't reach it.

## 3. The web service

**Add → Service → Deploy from Docker Image** → `ghcr.io/tembo/tas-web:2026.5.31`.

Generate a public domain first (**Settings → Networking → Generate
Domain**) — that HTTPS URL is your `BETTER_AUTH_URL`. Railway sets `PORT`
automatically and the web image honors it, so no target-port config is
needed.

### Required variables

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}`. better-auth and the app CRUD query Postgres directly. |
| `TAS_ENCRYPTION_KEY` | Must match the api service byte-for-byte (shared variable). |
| `INTERNAL_API_TOKEN` | Must match the api service byte-for-byte (shared variable). |
| `BETTER_AUTH_SECRET` | 32-byte base64. `openssl rand -base64 32`. |
| `BETTER_AUTH_URL` | The generated domain, e.g. `https://tas-web-production.up.railway.app`. |
| `NEXT_PUBLIC_BETTER_AUTH_URL` | Same value as `BETTER_AUTH_URL`. |
| `API_INTERNAL_URL` | `http://api.railway.internal:8080` (the api service's private domain + port). |
| `GOOGLE_CLIENT_ID` | OAuth 2.0 client from [Google Cloud Console](https://console.cloud.google.com/apis/credentials). Redirect URI `https://<web-domain>/api/auth/callback/google`. |
| `GOOGLE_CLIENT_SECRET` | Same. |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` / `MICROSOFT_TENANT_ID` | Optional — Microsoft Entra ID sign-in. Redirect URI `https://<web-domain>/api/auth/oauth2/callback/microsoft`. Tenant defaults to `common`. |
| `OIDC_DISCOVERY_URL` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_PROVIDER_NAME` | Optional — any OIDC IdP (Okta/Auth0/Keycloak/…). Redirect URI `https://<web-domain>/api/auth/oauth2/callback/oidc`. |
| `INSTANCE_ADMIN_EMAILS` | **Required to bootstrap.** Comma-separated emails granted instance-admin. Sign-up is invite-only by default — only these admins can sign in to a fresh instance and create workspaces / invite others. Set yours or no one can get in. |
| `TAS_INSTANCE_NAME` | Optional brand label on the login screen. |
| `TAS_SIGNUP_POLICY` / `TAS_SIGNUP_ALLOWED_DOMAINS` | Optional. Default invite-only. See [Instance administration](/agent-studio/instance-admin/#sign-up-policy). |

### Sign-in: Google OAuth (required)

:::caution
**Without this the instance deploys but no one can log in.** Email/password
auth is disabled, so the login screen shows "configuration needed" until a
Google OAuth client is set. The redirect URI needs the final public URL, so
the order matters:

1. Generate the web domain (step 3) and set `BETTER_AUTH_URL` +
   `NEXT_PUBLIC_BETTER_AUTH_URL` to it.
2. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials),
   create an OAuth 2.0 **Web application** client with the authorized
   redirect URI `https://<web-domain>/api/auth/callback/google`.
3. Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` on the web service —
   it redeploys and sign-in works.
:::

If you later attach a custom domain (Railway → Settings → Networking),
update `BETTER_AUTH_URL`, `NEXT_PUBLIC_BETTER_AUTH_URL`, **and** the
Google redirect URI to match.

## 4. Post-deploy checklist

- Open the web domain and sign in with Google. The first user becomes
  the workspace admin when they create their first workspace.
- Connect a GitHub repo (Settings → Repository).
- Add a Tembo API key (Settings → Tembo API key) for chat-to-PR
  authoring.
- Trigger one manual run and confirm it lands in `/runs` and starts when an
  execution slot is available.

## 5. Operational notes

- **Upgrades.** Bump the image tag on both services to the new version
  and redeploy; the api applies any new migrations on boot. Changing the
  image in service settings only *stages* it on Railway — you must
  redeploy for the new image to actually roll. The running version is
  shown in the login-screen footer (baked into the image), so you can
  confirm what's live without guessing.
- **Pin versions for production; `latest` only for throwaway instances.**
  Point the services at an explicit tag (e.g. `ghcr.io/tembo/tas-web:2026.6.2`)
  rather than `:latest`. Pinning gives reproducible deploys and trivial
  rollback (re-point to the previous tag), and prevents an unrelated
  restart from silently jumping versions. `:latest` tracks the newest
  release but still needs a manual redeploy to pick it up *and* gives up
  those guarantees — fine for a personal/dogfood box, not for a customer
  instance.
- **Scheduled runs** (the `automation` cron) and **event triggers**
  (Composio webhooks at `/api/hooks/composio/{slug}`) run on the web
  service — keep it on a plan that doesn't sleep, or scheduled fires
  pause while it's idle.
- **Secrets parity.** `TAS_ENCRYPTION_KEY` and `INTERNAL_API_TOKEN` must
  be identical on web and api. Shared variables are the safest way to
  guarantee that.

## 6. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| A run stays queued while other runs are active. | The concurrency cap is full; it starts when a slot opens. Tune `API_MAX_CONCURRENT_RUNS` against service memory. If sub-agents queue behind simultaneous orchestrators, reserve more capacity with `API_RESERVED_SUB_AGENT_RUNS`. |
| Run dispatch fails and no run is created. | web may not reach api. On images older than `2026.5.31`, set `API_BIND_ADDR=[::]:8080` on the api service (IPv6 private network). Otherwise check `API_INTERNAL_URL` = `http://<api-service>.railway.internal:8080`. |
| `/internal/runs` returns 401 in api logs. | `INTERNAL_API_TOKEN` differs between web and api. |
| `failed to decrypt secret` in api logs. | `TAS_ENCRYPTION_KEY` mismatch — web encrypted with a different key than api holds. |
| Sign-in succeeds, then a 401 loop. | `BETTER_AUTH_URL` / `NEXT_PUBLIC_BETTER_AUTH_URL` don't match the actual public domain. |
| `image pull` fails. | The pinned tag doesn't exist, or the GHCR package was made private — these images are public; verify the tag. |
