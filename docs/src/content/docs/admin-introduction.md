---
title: Introduction
description: Setting up and operating a Tembo Agent Studio instance — self-hosting, architecture, the Tembo API key, roles, and deploy guides.
---

The admin-side companion to the [operator introduction](/agent-studio/introduction/).
This covers standing up and running a Tembo Agent Studio (TAS) instance, rather
than building and running agents in one.

TAS is **self-hostable first**: identity, data, and runtime stay inside your
environment. You deploy it on your own infrastructure, point it at a Git repo
you own, set provider keys, and invite your team.

## How it fits with Tembo

TAS is the **control plane**. The authoring step — turning a chat message into a
diff — is delegated to the [Tembo Coding Agent Platform](https://tembo.io). You
plug a **Tembo API key** into workspace settings, and TAS uses it to open pull
requests against your repo: new agents from chat, and "improve the agent"
submissions from any run. TAS calls out to Tembo coding agents the way a CI
system calls out to compilers.

Until a Tembo API key is set, chat-to-PR authoring stays hidden — running
existing agents only needs an LLM provider key (Anthropic or OpenAI).

## Architecture in one breath

A Next.js web control plane, a Rust (axum + sqlx) API that owns the runtime and
Postgres migrations, and a Postgres database. Agent definitions live in your
connected GitHub repo; the API runs agents as subprocess calls into the bundled
`pydantic-ai` wrapper.

## Ways to run it

- **Local / from source** — `docker compose up --build` brings up web, API, and
  Postgres. Good for evaluation and development.
- **From prebuilt images** — `compose.release.yaml` pulls pinned images from
  GHCR instead of compiling from source. Its Postgres service is available to
  the web and API containers on the Compose network, with no host port exposed.
- **Managed hosts** — the full stack on **Railway** or **AWS** (ECS Fargate +
  RDS), or the web tier on **Vercel** with the API on a long-lived host.

## What admins manage

- **[Settings](/agent-studio/settings/)** — repository, LLM provider keys, the
  Tembo API key, Composio, Slack apps, and branding.
- **[Audit & roles](/agent-studio/audit-and-roles/)** — the append-only audit
  timeline and the viewer / operator / workspace-admin model (plus instance
  admins).
- **[Slack apps](/agent-studio/slack-apps/)** — installing and scoping the
  workspace Slack apps that launch agents.

## Deploy guides

- **[Setup checklist](/agent-studio/customer-setup/)** — start here. A
  zero-to-running checklist from accounts and keys through first sign-in.
- **[Deploy on Railway](/agent-studio/deploy-railway/)** — full stack on Railway
  from published images.
- **[Deploy on AWS](/agent-studio/deploy-aws/)** — ECS Fargate + RDS.
- **[Deploy on Vercel](/agent-studio/deploy-vercel/)** — web on Vercel, API on a
  long-lived host, managed Postgres.

## Versioning

Production instances pin to explicit CalVer release tags (e.g. `v2026.6.12`);
released container images are published to GHCR with signatures and SBOMs. See
the [Changelog](/agent-studio/changelog/) for what's in each release.
