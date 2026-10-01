# Issue #449 — run-list pagination slice

This change addresses run-list cursor correctness and transfer/query costs. It
**does not complete #449**. Shared layout inventory loading, automation paging,
selector queries, child-run/step/version bounds, and full route timings remain.

## Contract

- UI pages: at most 50 runs, ordered by `(created_at DESC, id DESC)`.
- Cursor: opaque JSON/base64url pair of database timestamp (six fractional digits)
  and UUID. Timestamp text comes directly from PostgreSQL, not JavaScript Date.
- The next query uses the same tuple ordering and a strict tuple comparison.
- Cursor pages retain filters. New rows sorting before the cursor do not repeat
  already-viewed rows. This is keyset traversal, not snapshot isolation; deleted
  runs or changing filter values can change membership between requests.
- REST accepts `cursor`, emits `next_cursor`, and rejects malformed/conflicting
  input. Existing `before` remains a time filter, not a complete cursor.
- Input previews are truncated in SQL to 200 characters. Detail output is intact.

## Reproduction

Use a disposable PostgreSQL database. The test creates a uniquely named schema
and removes only that schema afterward. Never point it at a production database.
The URL must allow schema creation. Example with a local PostgreSQL 17 container:

```sh
docker run -d --name studio-scale-test -e POSTGRES_PASSWORD=local-test \
  -p 127.0.0.1:55449:5432 postgres:17
cd web
RUN_NAVIGATION_TEST_DATABASE_URL=postgres://postgres:local-test@127.0.0.1:55449/postgres \
RUN_NAVIGATION_BENCHMARK=1 \
RUN_NAVIGATION_PLAN_FILE=/tmp/run-list-plans.json \
pnpm exec vitest run src/lib/run-list-db.integration.test.ts
```

Omit `RUN_NAVIGATION_BENCHMARK` for the small correctness fixture. Without a URL,
this integration file is skipped; pure cursor and API tests still run normally.

The deterministic fixture contains 240 tied/microsecond-separated runs, a second
workspace, 10,000-character inputs, and a concurrent new-run scenario. The large
fixture adds 1,000,000 runs, 100 agent names, 1,000-character inputs, and batches
of 1,000 equal timestamps. It executes the actual list query and captures
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` before/after migration 0095. Tables are a
minimal projection of production schema; workspace IDs are text in this fixture.
Delivery tables are empty and one actor is used. This deliberately tests tied
bursts, not a representative mix of every filter, delivery, or user workload.

## Recorded query plans

Measured October 1, 2026, in the NixOS development VM, PostgreSQL 17 container.
Both measurements use the **new composite-cursor query** over identical synthetic
data. The baseline uses existing recent-run indexes; the second adds the cursor
index. These are single query-plan samples, not p50/p95 application timings.

| Metric | Existing indexes | With cursor index |
| --- | ---: | ---: |
| Execution time | 10.551 ms | 0.445 ms |
| Run rows read | 1,002 | 50 |
| Shared buffer hits | 4,160 | 210 |
| Shared buffer reads | 0 | 3 |
| Sort | Incremental Sort | None |

Full plans: [449-run-list-plans.json](449-run-list-plans.json). The useful evidence
is the reduction from reading/joining the timestamp batch to reading one page;
these timings are not a production speedup claim. Plan samples precede moving
index creation into the equivalent migration file.

Migration 0095 adds `(workspace_id, created_at DESC, id DESC)` and retains the
existing index. Regular index creation blocks writes to `run` while building;
large deployments should schedule migration accordingly. This slice does not
introduce a concurrent-index migration mechanism or remove older indexes without
checking their other consumers. Measure write/storage overhead and filtered/deep
page plans before further index tuning.

## Remaining audit

Measure agent, automation, and run list/detail routes with cold and warm caches,
including parent layouts and GitHub requests. Establish route p50/p95 budgets,
query counts, payload sizes, and explicit collection bounds. Fix shared-layout
inventory scans and lazy/searchable selectors; design globally ordered automation
pagination and relationship paging. Keep #449 open for that evidence and work.
