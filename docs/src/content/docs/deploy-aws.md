---
title: Deploy on AWS
description: Deploy TAS on ECS Fargate with RDS for Postgres — managed containers and managed, automatically-backed-up Postgres.
---

This guide deploys TAS on **ECS Fargate** with **RDS** for Postgres:
managed containers and managed, automatically-backed-up Postgres. Both
services run the published GHCR images (`ghcr.io/tembo/tas-api`,
`ghcr.io/tembo/tas-web` — public, so no ECR mirroring required).

:::note
We deliberately **don't** document a single-EC2 box running the bundled
Postgres container — that pattern invites running a database with no backups.
Use RDS. If you genuinely want one box, run `compose.release.yaml` on it but
still point `DATABASE_URL` at RDS and terminate TLS in front of `web` (see
step 5).
:::

:::caution[Use `x86_64`]
The images are `linux/amd64` only today — do not pick Graviton/`arm64` Fargate
(`ARM64` platform) until arm64 images ship, or containers fail with `exec
format error`.
:::

The one AWS-specific wrinkle versus Vercel/Railway is **TLS**: AWS
doesn't hand you HTTPS for free, and better-auth needs an HTTPS origin
in production (secure cookies + the Google OAuth redirect). Step 5
terminates it at an ALB.

## Architecture target

```
Browser ──HTTPS──► ALB (ACM cert) ──► web (Fargate) ──► api (Fargate) ──► RDS
                                         │                  │              │
                                         └─ both query RDS ─┴──────────────┘
```

`api` is never public — `web` reaches it over the VPC via ECS Service
Connect. Only `web` sits behind the ALB.

## 1. RDS Postgres

- Postgres **16 or newer** (18 recommended), in private subnets, with automated backups enabled
  (the whole reason we're here).
- `gen_random_uuid()` is built in (PG13+); no extension setup needed.
- Security group: inbound `5432` from the ECS **task** security group
  only.
- Record the connection string as `DATABASE_URL`.

The Rust api applies migrations on boot via `sqlx::migrate!()`, so
there's no manual migration step.

## 2. Secrets Manager

Store these and reference them from the task definitions (so they never
sit in plaintext task JSON):

- `DATABASE_URL`
- `TAS_ENCRYPTION_KEY`, `INTERNAL_API_TOKEN` — **one value each, shared
  by both task defs.** `openssl rand -base64 32`. Mismatch = undecryptable
  secrets / 401s between the tiers.
- `BETTER_AUTH_SECRET` (web only). `openssl rand -base64 32`.
- `GOOGLE_CLIENT_SECRET` (web only).

## 3. Task definitions (pull the public images)

**`api` task** — image `ghcr.io/tembo/tas-api:<version>`, container port
`8080`, no public ingress. Env:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | from Secrets Manager |
| `TAS_ENCRYPTION_KEY` | from Secrets Manager |
| `INTERNAL_API_TOKEN` | from Secrets Manager |
| `API_MAX_CONCURRENT_RUNS` | Maximum simultaneous agent executions per task (default `10`); tune against the task's memory limit. |
| `API_RESERVED_SUB_AGENT_RUNS` | Slots reserved for sub-agents (default: half of the maximum, so `5` when the maximum is `10`; set `0` if orchestration is unused). |
| `API_MAX_CONCURRENT_SUB_AGENTS_PER_ORCHESTRATOR` | Concurrent sub-agent runs allowed for one orchestrator (default `3`). Extra children of that parent stay queued. |
| `RUST_LOG` | `info,tas_api=debug` |

(AWS VPC networking is IPv4, so the default bind is reachable — no
`API_BIND_ADDR` override needed.)

**`web` task** — image `ghcr.io/tembo/tas-web:<version>`, container port
`3000`. Env:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | from Secrets Manager (better-auth + app CRUD query it directly) |
| `TAS_ENCRYPTION_KEY` | from Secrets Manager (**must match api**) |
| `INTERNAL_API_TOKEN` | from Secrets Manager (**must match api**) |
| `BETTER_AUTH_SECRET` | from Secrets Manager |
| `BETTER_AUTH_URL` | `https://<your-domain>` |
| `NEXT_PUBLIC_BETTER_AUTH_URL` | `https://<your-domain>` |
| `API_INTERNAL_URL` | `http://api.<namespace>:8080` (Service Connect DNS) |
| `GOOGLE_CLIENT_ID` | OAuth 2.0 client. Redirect URI `https://<domain>/api/auth/callback/google`. |
| `GOOGLE_CLIENT_SECRET` | from Secrets Manager |
| `MICROSOFT_*` / `OIDC_*` | Optional alternative providers (Entra ID / any OIDC IdP). Redirect URIs `https://<domain>/api/auth/oauth2/callback/{microsoft,oidc}`. See `.env.example`. |
| `INSTANCE_ADMIN_EMAILS` | **Required to bootstrap** — comma-separated instance-admin emails. Sign-up is invite-only by default; only these admins can sign in to a fresh deployment and create workspaces / invite others. |
| `TAS_INSTANCE_NAME` | optional brand label |
| `TAS_SIGNUP_POLICY` / `TAS_SIGNUP_ALLOWED_DOMAINS` | Optional. Default invite-only. See [Instance administration](/agent-studio/instance-admin/#sign-up-policy). |

:::note
Pulling from GHCR needs no credentials (the images are public). To keep images
in-account, mirror them to **ECR** and reference the ECR URI.
:::

## 4. web → api private networking

Enable **ECS Service Connect** (or Cloud Map) on the cluster so `web`
resolves `api` by name. Set `API_INTERNAL_URL` to the api service's
Service Connect DNS (`http://api.<namespace>:8080`). The api service
needs **no** load balancer — it's internal only.

## 5. Public TLS (ALB + ACM)

- Request an **ACM** certificate for your domain (same region as the
  ALB).
- Application Load Balancer: an HTTPS:443 listener with the ACM cert →
  target group → the `web` service on port `3000`. Redirect `:80 → :443`.
- Point your domain (Route 53 or elsewhere) at the ALB.
- Set `BETTER_AUTH_URL` / `NEXT_PUBLIC_BETTER_AUTH_URL` to
  `https://<domain>`, and the Google OAuth client's authorized redirect
  URI to `https://<domain>/api/auth/callback/google`.

:::caution
**Sign-in requires the Google OAuth client.** Email/password is disabled, so
the stack deploys but no one can log in until it exists. Order: domain/ALB up →
set `BETTER_AUTH_URL` → create the Google **Web application** client with the
redirect URI above → set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` → web
redeploys.
:::

## 6. Deploy + verify

Bring up the `api` service first (it migrates the RDS schema on boot),
then `web`. Then:

- Open `https://<domain>` and sign in with Google — the first user
  becomes workspace admin on first workspace creation.
- Connect a GitHub repo (Settings → Repository).
- Trigger one manual run and confirm it lands in `/runs`.

## Operational notes

- **Upgrades.** Bump the image tag in both task defs and redeploy; the
  api migrates on boot. Pin versions, not `latest`, for reproducible
  rollouts.
- **Scheduler + webhooks run on `web`.** The `automation` cron
  (`instrumentation.ts`) and Composio trigger webhooks
  (`/api/hooks/composio/{workspace}`) live in the web container — keep at
  least one `web` task running; don't scale it to zero.
- **Secrets parity.** `TAS_ENCRYPTION_KEY` and `INTERNAL_API_TOKEN` must
  be byte-for-byte identical on web and api. Rotating `TAS_ENCRYPTION_KEY`
  orphans every existing workspace secret.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `exec format error` on container start. | Ran the `amd64` image on `arm64`/Graviton Fargate. Use the `X86_64` platform. |
| Sign-in succeeds, then a 401 loop. | `BETTER_AUTH_URL` isn't the real HTTPS origin, or TLS isn't terminating in front of `web` (cookies need `https`). |
| A run stays queued while other runs are active. | The per-task concurrency cap is full; it starts when a slot opens. Tune `API_MAX_CONCURRENT_RUNS` against task memory. If sub-agents queue behind simultaneous orchestrators, reserve more capacity with `API_RESERVED_SUB_AGENT_RUNS`. If one orchestrator's children sit queued while other work is running, raise `API_MAX_CONCURRENT_SUB_AGENTS_PER_ORCHESTRATOR`. |
| Run dispatch fails and no run is created. | web can't reach api: wrong `API_INTERNAL_URL`, or Service Connect not enabled. `/internal/*` 401s mean `INTERNAL_API_TOKEN` mismatch. |
| `failed to decrypt secret` in api logs. | `TAS_ENCRYPTION_KEY` differs between web and api. |
| api can't reach Postgres. | RDS security group doesn't allow the task SG on `5432`, or `DATABASE_URL` host is wrong. |
