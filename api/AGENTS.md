# Tembo Agent Studio — api/

Rust + axum + sqlx + tokio. The api owns Postgres migrations, the run
executor, and the auth boundary between the web layer and the runtime.

## Build / run

```bash
cargo run            # uses .env + docker postgres on host
cargo check          # fast compile-only
cargo test           # — (no test suite yet; add when behavior is non-trivial)
```

In docker, `api/Dockerfile` builds the release binary, bundles the
`cargo-ai` CLI as a sibling binary, and bundles a Python venv with
`pydantic-ai` for the passthrough runner.

## Architecture

- `src/main.rs` — wires axum router, applies migrations, hands the
  `AppState` to handlers.
- `src/routes/` — public routes (currently just `/health`).
- `src/runs/` — the run subsystem. Handlers + runner + per-framework
  passthrough adapters.
- `src/auth.rs` — bearer-token middleware for `/internal/*`. The
  shared secret is `INTERNAL_API_TOKEN`, injected from the env;
  only the web container holds the other end.
- `src/workspace.rs`, `src/crypto.rs` — workspace lookups + AES-GCM
  symmetric encryption for workspace secrets (PATs, API keys).

## Runners are passthrough

Both supported frameworks shell out to the upstream tool:

- **Cargo AI** → bundled `cargo-ai` CLI (`src/runs/cargo_ai.rs`).
- **Pydantic AgentSpec** → bundled python venv at
  `${PYDANTIC_AI_VENV}` running `scripts/run_pydantic.py`
  (`src/runs/pydantic.rs`).

The Pydantic wrapper is split by responsibility:

- `scripts/run_pydantic.py` — CLI entry point, agent construction, and run loop.
- `scripts/pydantic_protocol.py` — stdout sentinels, checkpoints, streaming,
  and terminal usage/tool/step serialization.
- `scripts/pydantic_connections.py` — connection parsing plus Composio and
  native-MCP toolset construction.
- `scripts/pydantic_scaledown.py` — optional ScaleDown prompt compression.
- `scripts/pydantic_dry_run.py` — stub declared delivery tools when `TAS_DRY_RUN=1`.

Keep protocol changes covered in `tests/test_run_pydantic_protocol.py`; those
tests launch the real wrapper against a loopback provider and exercise the same
stdin/stdout contract consumed by Rust.

The Rust side does **not** call provider SDKs directly. If you're
tempted to add a third framework, follow the same passthrough shape:
hand the spec to the upstream tool, capture stdout, parse a small
result envelope.

## Migrations

See [`../AGENTS.md`](../AGENTS.md) for the repo-wide policy. Specifics
for this crate:

- Files live at `migrations/####_short_name.sql`. Number is
  zero-padded to 4 digits, monotonically increasing.
- The macro is `sqlx::migrate!("./migrations")` — it's compile-time,
  so adding a new file invalidates the cargo build cache automatically.
- Migrations run at api boot. They run **after** Postgres reports
  healthy via docker-compose's healthcheck, so the web container's
  `depends_on: api` chain is the right way to wait for them.

## Adding a route

1. Add the handler module under `src/routes/` (or `src/runs/handlers.rs`
   if it's run-related).
2. Wire it in `src/main.rs` — `Router::new().route("/path", get(…))`.
3. For internal-only endpoints, nest under `/internal` so the bearer
   middleware applies. Public endpoints stay at the root router.
4. Return `Json<T>` for happy paths. Errors are
   `(StatusCode, String)` — surface the failure plainly to the web
   side, which renders it to the user.

## Logging

`tracing` crate, configured in `main.rs`. Default filter is
`info,tas_api=debug`. Log at `info` for state transitions
(`run_id → running`, `run_id → succeeded`), `debug` for everything
else.

## Adding a column to `run` (or any existing table)

The runner writes runs in `src/runs/handlers.rs` (the `INSERT`) and
reads them in the same file (the `SELECT` in `get_run` plus the
`sqlx::FromRow` on `RunRecord`). Keep all three in sync in the same
PR. The web layer reads runs from Postgres directly in `runs-db.ts`
and `runs-api.ts` — update those too if the column is user-facing.

## What the api does NOT do

- It does not call GitHub. Repo reads/writes live in `web/src/lib/github.ts`.
- It does not parse agent files. The web layer parses; the api takes
  the parsed `spec_content` + `spec_format` and hands them to the
  runner.
- It does not know about better-auth sessions. The web layer
  authenticates users; the api trusts the bearer token between them.
