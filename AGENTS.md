# Tembo Agent Studio — repo guide

This file is the entry point for coding agents working on TAS itself.
Subdirectories may carry their own `AGENTS.md` that extends this one;
read both when editing files inside that subdir.

## Stack

Monorepo, three runtime pieces, all started by `docker-compose.yml`:

- `web/` — Next.js 16 (App Router, Turbopack) + Tailwind v4 + better-auth.
  Package manager is **pnpm**. See [`web/AGENTS.md`](./web/AGENTS.md).
- `api/` — Rust + axum + sqlx, owns Postgres migrations and the runner.
  See [`api/AGENTS.md`](./api/AGENTS.md).
- `postgres` — single database shared by web and api.

`agents/` holds seed agent fixtures. `context/` holds phase docs (PRFAQ,
user stories, demo scripts per phase). The product user manual lives in
`docs/` (Astro Starlight, published to GitHub Pages) — see
[`docs/README.md`](./docs/README.md).

## Running the app (one command)

In a Tembo sandbox (or any Docker host), bring up a fully working instance with
a seeded admin login:

```bash
./scripts/dev-up.sh
```

It writes a `.env` (random secrets, **no OAuth → email/password sign-in**), runs
`docker compose up`, waits for the web app, and seeds an instance-admin account
(`admin@tembo.local` / `tembo-dev-password` by default; override with
`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`). Sign in and create a workspace —
the bundled sample agents (`./agents`, mounted via `TAS_LOCAL_AGENTS_DIR`) load
automatically with no repo connected; connect a GitHub repo (with a PAT) to load
your own. Re-runnable.

`tembo.nix` (repo root) adds the Rust toolchain on top of the sandbox's
preinstalled Node 22 / pnpm / Docker, so `cargo build`/`cargo test` work too. It
is also what Tembo snapshots bake in — keep it committed so prebuilt sessions
include it.

## Commands

```bash
# Boot everything (postgres + api + web). Idempotent.
docker compose up --build

# Web only — host pnpm against the docker postgres.
docker compose up -d postgres
cd web && pnpm install && pnpm dev

# API only — host cargo against the docker postgres.
docker compose up -d postgres
cd api && cargo run
```

Once healthy: web at `http://localhost:3000`, api at
`http://localhost:8080/health`.

## Database migrations

Postgres migrations live in `api/migrations/` as numbered `.sql`
files. The Rust API runs them at boot via `sqlx::migrate!()`.

- **Never edit a migration that has already been applied to any
  environment.** Add a new numbered file instead. Editing in place
  silently drifts schemas across deployments.
- **Additive by default.** Use `ALTER TABLE … ADD COLUMN IF NOT
  EXISTS` with a `DEFAULT` (or `NOT NULL DEFAULT`) so existing rows
  keep working without a backfill.
- **Renames need both a column and the readers.** When renaming, ship
  the migration + the TS/Rust callers in the same PR.

## Keep the docs in sync

When you add or change product behavior, update the docs **in the same
change** — they're the product's source of truth for users and drift fast if
treated as a follow-up. Don't ship a feature without touching the docs it
affects.

- **User-facing behavior** (a page, flow, setting, agent-spec field, connection
  type, automation surface) → update the matching page in the Astro Starlight
  user manual under `docs/src/content/docs/`. Rough map: `running-agents.md`
  (the run view), `authoring-agents.md` (agent spec + model settings),
  `connections.md` (Composio / Native MCP / Secrets), `automations-triggers.md`
  (schedules / triggers / webhooks), `settings.md` + `audit-and-roles.md`
  (admin), `dashboard-and-runs.md`.
- **Behavior the runner injects into every agent** (output discipline,
  `parallel_tool_calls`, etc.) is user-visible — document it in
  `authoring-agents.md` / `troubleshooting.md`.
- **Code structure / conventions** → update the nearest `AGENTS.md` (this file,
  `web/AGENTS.md`, `api/AGENTS.md`).
- The in-app docs viewer reads a **generated bundle**
  (`web/src/lib/docs-content.ts`), not the markdown directly. After editing
  anything under `docs/src/content/docs/` — including the generated
  `changelog.md` / `roadmap.md` — run **`cd web && pnpm gen:docs`** and commit
  the regenerated `docs-content.ts` in the same change. Skip it and the published
  manual updates but the in-app `/docs` drifts.
- A **new** doc page needs a sidebar entry in **both** `docs/astro.config.mjs`
  (published site) **and** `web/src/app/[workspace]/docs/nav.ts` (in-app sidebar +
  the slug allow-list that rewrites `/agent-studio/<slug>/` cross-links). Miss
  `nav.ts` and the page is unreachable in-app and its inbound links 404.

CI runs a non-blocking `docs-sync` reminder that flags changes touching
`web/src/app/**` or `api/src/**` without any `docs/` change. It's a nudge, not
a gate — if a change genuinely needs no doc update, ignore it.

## Commit style

Conventional commits with the current phase tag — match the existing
history:

```
feat(v0.2): chat-to-edit thread per agent + broader PR scan
fix(v0.2): cargo-ai extractor — keep continuation lines + drop stderr footer
refactor(v0.2): rename feedback → improvement everywhere
docs(readme): merge Overview + Vision into one tighter section
```

The phase tag is whatever phase is in flight per
[`ROADMAP.md`](./ROADMAP.md). Drop the tag for non-product changes
(docs-only, tooling).

## Pull requests

After completing and verifying any coding task, commit the changes, push the
branch, and open a pull request. Do not wait for a separate request to open the
pull request.

## Backlog prioritization

The [Agent Studio Backlog project](https://github.com/orgs/tembo/projects/1)
is the source of truth for execution order and initiative. GitHub Issues remain
the source for scope, type, provenance, risk, components, and dependencies. When
auditing, sequencing, or re-prioritizing issues, use
[`.agents/skills/reprioritize-backlog/SKILL.md`](./.agents/skills/reprioritize-backlog/SKILL.md).
Every open issue should have exactly one type, one `priority: *` label, and one
`status: *` label; Priority and Status must match the corresponding Project
fields. The additive `user request` label is validated-demand evidence and raises
priority, but never overrides P0 safety work or a hard dependency. Order is a
global, unique, positive number for open work, and the Project's manual item
positions must mirror it so the default view is useful without an explicit
sort. Strategic re-prioritization remains a human judgment. Automation
synchronizes taxonomy and deterministically refreshes Order from the approved
metadata and dependency graph; it does not infer business priority from issue
prose.

## What to leave alone

- `node_modules/`, `target/`, `.next/`, `dist/` — build outputs.
- Applied migrations in `api/migrations/` (see above).
- `pnpm-lock.yaml` and `Cargo.lock` — never hand-edit; let the tools
  regenerate.

## Conventions that apply repo-wide

- **Don't add features beyond what the task requires.** Three similar
  lines is fine; premature abstractions aren't.
- **Don't write comments that just restate the code.** Comments
  exist for the *why* — non-obvious constraints, surprising
  invariants, workarounds for specific bugs.
- **Don't add backwards-compat shims for code you're authoring in the
  same PR.** Internal callers can change in lockstep.
- **No `--no-verify`** and no skipping hooks on commit. If a hook
  fails, fix the underlying issue.
- **Don't estimate how long tasks will take.** No "half a day,"
  "~hour," "multi-day" framing when proposing work. Describe the
  shape and scope of a task (what changes, what depends on what)
  and let the human decide whether to take it on.
