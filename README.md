<div align="center">
  <h1>Tembo Agent Studio</h1>
<a href="https://tembo.io"><img alt="Made by Tembo" src="https://img.shields.io/badge/MADE%20BY%20TEMBO-0f172a.svg?style=for-the-badge&labelColor=000&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB2aWV3Qm94PSIwIDAgMzIgMzIiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgZmlsbD0ibm9uZSI%2BPGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoNiA2KSBzY2FsZSgwLjE5OTMpIHRyYW5zbGF0ZSgwIC0yLjUwODYxKSIgZmlsbD0iI2ZmZmZmZiI%2BPHBhdGggZD0iTTMzLjQ1MDMgNjkuNDA5NkgwVjEwMi44NkgzMy40NTAzVjY5LjQwOTZaIi8%2BPHBhdGggZD0iTTEwMC4zNDggNjkuNDA5Nkg2Ni44OTc0VjEwMi44NkgxMDAuMzQ4VjY5LjQwOTZaIi8%2BPHBhdGggZD0iTTEwMC4zNTEgMzUuOTU4OVYyLjUwODYxSDBWMzUuOTU4OUgzMy40NTAzTDMzLjQ1MDMgNjkuNDA5Nkw2Ni45MDA2IDY5LjQwOTJWMzUuOTU4OUgxMDAuMzUxWiIvPjwvZz48L3N2Zz4%3D"></a>
<a href="https://github.com/tembo/agent-studio/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/tembo/agent-studio.svg?style=for-the-badge&labelColor=000000"></a>
<a href="https://github.com/tembo/agent-studio/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/tembo/agent-studio.svg?style=for-the-badge&labelColor=000000"></a>
<a href="https://github.com/tembo/agent-studio/discussions"><img alt="Join the community on GitHub" src="https://img.shields.io/badge/Join%20the%20community-blueviolet.svg?style=for-the-badge&logo=Github&labelColor=000000&logoWidth=20"></a>
</div>

> Self-hosted control plane for AI agents. Definitions live in Git, every
> change is a commit (PR by default, or direct commit in YOLO mode), and runs,
> audit logs, and identity stay in your environment.

Tembo Agent Studio (TAS) treats agents like production software, not editable
prompts in a vendor console. Agents are spec files in a GitHub repository you
own. New agents, edits, and run feedback produce reviewable Git diffs. Runs,
identity, audit history, secrets, and approvals stay in your deployment.

## At a Glance

| Area | What TAS provides |
| --- | --- |
| Source of truth | Agent definitions in your GitHub repository |
| Authoring | Pull requests by default, direct commits in YOLO mode |
| Runtime | Self-hosted web app, Rust API, and Postgres |
| Agent frameworks | Pydantic AgentSpec and Cargo AI |
| Triggers | Manual runs, schedules, external events, webhooks, and Slack apps |
| Tools | Composio integrations, native MCP servers, and reusable Skills |
| Governance | Tasks Inbox, roles, audit log, draft/stable versions, agent locks |

Tembo's hosted Coding Agent Platform is optional. TAS can run hand-authored
agent specs without it. Add a Tembo API key when you want natural-language
authoring, chat-to-edit, and "Improve" flows that open PRs for review.

## Quickstart

Fastest path on any Docker host:

```bash
./scripts/dev-up.sh
```

The script is safe to rerun. On first run it:

- writes `.env` with random development secrets,
- enables email/password sign-in by leaving OAuth unset,
- boots Postgres, the API, and the web app with Docker Compose,
- waits for the web app,
- seeds an admin account and prints the login details.

When it finishes, open `http://localhost:3000`, sign in, and create a workspace.
The bundled sample agents under [`agents/`](./agents) appear automatically until
you connect your own GitHub repository.

## Manual Setup

### 1. Prepare `.env`

```bash
cp .env.example .env
```

At minimum, set these required secrets:

- `BETTER_AUTH_SECRET`
- `TAS_ENCRYPTION_KEY`
- `INTERNAL_API_TOKEN`

Generate each with:

```bash
openssl rand -base64 32
```

Set `INSTANCE_ADMIN_EMAILS` to one or more comma-separated emails. These users
can create the first workspace and reach instance-level settings. Without this
value, the instance is invite-only by default and nobody can bootstrap
administration. Sign-up policy (invite-only / domain allowlist / open) is
configurable later under Instance settings.

By default, when no OAuth provider is configured, the login screen offers
email/password sign-in. This is useful for local development and sandbox
evaluation.

For production or multi-user deployments, configure one OAuth provider instead.
Email/password turns off automatically when any provider is set:

- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, or
- `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, and
  `MICROSOFT_TENANT_ID`, or
- `OIDC_DISCOVERY_URL`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET`

### 2. Start the stack

Build from source with the default compose file:

```bash
docker compose up --build
```

Or run published GHCR images:

```bash
docker compose -f compose.release.yaml pull
docker compose -f compose.release.yaml up -d
```

### 3. Open the app

Once healthy:

- Web: `http://localhost:3000`
- API health: `http://localhost:8080/health`
- Postgres: `localhost:5432`

The API applies database migrations automatically on boot via `sqlx::migrate!()`.

### 4. Finish workspace setup

After the first admin signs in:

1. Create a workspace.
2. Connect the GitHub repository that stores agent definitions.
3. Add an Anthropic and/or OpenAI API key so agents can run.
4. Add a Composio key if agents need external app connections.
5. Optionally add a Tembo API key to enable chat-to-PR authoring and run
   improvement requests.

The full zero-to-running checklist lives in
[Customer setup](https://tembo.github.io/agent-studio/customer-setup/).

## Core Concepts

- **Workspaces** group agents, runs, members, secrets, connections, and audit
  history.
- **Agents** are versioned files in Git. TAS tracks draft and stable versions,
  the backing commit, and the run history for each agent.
- **Runs** execute an agent once and record model output, tool use, cost, and
  operational status.
- **Connections** let agents act through user-authorized external systems such
  as Slack, Gmail, Sheets, Attio, Linear, HubSpot, and native MCP providers.
- **Tasks Inbox** is the human-review surface for agent output that needs a
  decision before acting in the source system.
- **Automations and webhooks** run agents on schedules, external events, or
  signed inbound requests.

## Deployment

- **Local or self-managed host:** [`docker-compose.yml`](./docker-compose.yml)
  builds from source.
- **Prebuilt images from GHCR:** [`compose.release.yaml`](./compose.release.yaml)
  pulls `ghcr.io/tembo/tas-api` and `ghcr.io/tembo/tas-web`.
- **Managed platforms:** see the deployment guides for
  [Railway](https://tembo.github.io/agent-studio/deploy-railway/),
  [AWS](https://tembo.github.io/agent-studio/deploy-aws/), and
  [Vercel](https://tembo.github.io/agent-studio/deploy-vercel/).

Pin `TAS_VERSION` in `.env` when using `compose.release.yaml` so upgrades are
intentional and reproducible.

## Local Development

Prerequisites:

- Docker or OrbStack
- Node `22+`
- `pnpm` `10.24+`
- Rust `1.93+`

Run everything with Docker:

```bash
docker compose up --build
```

Or run only Postgres in Docker and develop services on the host:

```bash
docker compose up -d postgres
```

API:

```bash
cd api
cargo run
```

Web:

```bash
cd web
pnpm install
pnpm dev
```

Useful verification commands:

```bash
# web
cd web
pnpm lint
pnpm test

# api
cd api
cargo test
```

When you change product behavior, update the user manual under [`docs/`](./docs)
in the same change. If you edit markdown under `docs/src/content/docs/`, run
`cd web && pnpm gen:docs` so the in-app docs bundle stays in sync.

## Repository Layout

```text
agent-studio/
|-- web/                  Next.js control plane UI
|-- api/                  Rust API, runner orchestration, migrations
|-- docs/                 Astro Starlight user manual
|-- agents/               Bundled sample agent specs
|-- context/              Planning, phase notes, demos, user stories
|-- scripts/dev-up.sh     One-command local/sandbox bootstrap
|-- docker-compose.yml    Source-build compose stack
`-- compose.release.yaml  Published-image compose stack
```

Repo-specific contributor guidance lives in [`AGENTS.md`](./AGENTS.md). If you
change product behavior, update the user docs under [`docs/`](./docs) in the
same change.

## Documentation

The product manual is published at
[`tembo.github.io/agent-studio`](https://tembo.github.io/agent-studio/). Source
files live under [`docs/`](./docs).

Recommended entry points:

- [Introduction](https://tembo.github.io/agent-studio/introduction/)
- [Getting started](https://tembo.github.io/agent-studio/getting-started/)
- [Customer setup](https://tembo.github.io/agent-studio/customer-setup/)
- [Authoring agents](https://tembo.github.io/agent-studio/authoring-agents/)
- [Running agents](https://tembo.github.io/agent-studio/running-agents/)
- [Connections](https://tembo.github.io/agent-studio/connections/)
- [Model Context Protocol (MCP)](https://tembo.github.io/agent-studio/mcp/)
- [Slack Apps](https://tembo.github.io/agent-studio/slack-apps/)
- [Skills](https://tembo.github.io/agent-studio/skills/)
- [Tasks Inbox](https://tembo.github.io/agent-studio/tasks-inbox/)
- [Automations & triggers](https://tembo.github.io/agent-studio/automations-triggers/)
- [Example Agents](https://tembo.github.io/agent-studio/example-agents/)
- [API Reference](https://tembo.github.io/agent-studio/api/)

See [`CHANGELOG.md`](./CHANGELOG.md) for shipped work and
[`ROADMAP.md`](./ROADMAP.md) for what is next.

## License

[MIT](./LICENSE)
