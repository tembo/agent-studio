import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { schema, connectionString } = vi.hoisted(() => ({
  schema: `run_navigation_test_${Date.now()}`,
  connectionString: process.env.RUN_NAVIGATION_TEST_DATABASE_URL,
}));
vi.mock("@/lib/db", async () => {
  const { Pool } = await import("pg");
  return { db: new Pool({ connectionString, options: `-c search_path=${schema}` }) };
});

import { db } from "./db";
import { listRunsForWorkspace } from "./run-list-db";
import { decodeRunCursor } from "./run-list-cursor";
import { toLoaded } from "@/app/[workspace]/runs/shape";

// Isolated schema, synthetic data only. The optional large fixture exercises
// the production query; it is not an application-route latency benchmark.
describe.skipIf(!connectionString)("run pagination in PostgreSQL", () => {
  beforeAll(async () => {
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`
      CREATE TABLE "user" (id text PRIMARY KEY, name text, email text);
      CREATE TABLE run (
        id uuid PRIMARY KEY, workspace_id text NOT NULL, agent_name text NOT NULL,
        status text DEFAULT 'succeeded', trigger text DEFAULT 'manual', automation_id uuid,
        created_at timestamp NOT NULL, started_at timestamp, completed_at timestamp,
        user_message text DEFAULT '', failure_summary text, error_message text, output text DEFAULT '',
        cost_usd numeric, agent_version_label text, run_environment text DEFAULT 'production',
        is_dry_run boolean DEFAULT false, created_by text
      );
      CREATE TABLE slack_delivery (run_id uuid PRIMARY KEY, slack_app_id uuid, slack_user_id text, permalink text, channel text);
      CREATE TABLE workspace_slack_app (id uuid PRIMARY KEY, name text);
      CREATE TABLE sms_delivery (run_id uuid PRIMARY KEY, sms_channel_id uuid);
      CREATE TABLE workspace_sms_channel (id uuid PRIMARY KEY, phone_number text);
      CREATE INDEX run_workspace_recent_idx ON run (workspace_id, created_at DESC);
      CREATE INDEX run_workspace_agent_recent_idx ON run (workspace_id, agent_name, created_at DESC);
      INSERT INTO "user" VALUES ('alice', 'Alice', 'alice@example.com');
      INSERT INTO run (id, workspace_id, agent_name, created_at, user_message, created_by)
      SELECT lpad(to_hex(i), 32, '0')::uuid, 'acme', 'digest',
        timestamp '2026-10-01 12:00:00.123456' - (i / 80) * interval '1 microsecond',
        repeat('x', 10000), 'alice'
      FROM generate_series(1, 240) i;
      INSERT INTO run (id, workspace_id, agent_name, created_at)
      VALUES ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'other', 'digest', '2026-10-02');
    `);
  });
  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.end();
  });

  it("returns every tied/microsecond row exactly once and isolates the workspace", async () => {
    const expected = await db.query("SELECT id FROM run WHERE workspace_id = 'acme' ORDER BY created_at DESC, id DESC");
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const rows = await listRunsForWorkspace("acme", {}, { cursor });
      expect(rows.length).toBeLessThanOrEqual(50);
      if (!rows.length) break;
      expect(rows.every((r) => r.userMessagePreview.length === 200)).toBe(true);
      seen.push(...rows.map((r) => r.id));
      cursor = toLoaded(rows[rows.length - 1]).cursor;
    }
    expect(seen).toEqual(expected.rows.map((r) => r.id));
    expect(new Set(seen).size).toBe(240);
  });

  it("does not repeat earlier pages when a newer run arrives", async () => {
    const first = await listRunsForWorkspace("acme", {}, { limit: 10 });
    await db.query(`INSERT INTO run (id, workspace_id, agent_name, created_at)
      VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'acme', 'digest', '2026-10-03')`);
    const next = await listRunsForWorkspace("acme", {}, { limit: 10, cursor: first[9].cursor });
    expect(next).toHaveLength(10);
    expect(next.some((r) => first.some((f) => f.id === r.id))).toBe(false);
    expect(next.some((r) => r.id.startsWith("eeee"))).toBe(false);
    expect(decodeRunCursor(next[0].cursor).createdAt).toBe("2026-10-01T12:00:00.123456");
  });

  it("retains legacy before filtering and validates page bounds", async () => {
    const before = new Date("2026-10-01T12:00:00.124Z");
    const rows = await listRunsForWorkspace("acme", {}, { before, limit: 10000 });
    expect(rows).toHaveLength(50);
    expect(await listRunsForWorkspace("acme", {}, { limit: Number.NaN })).toHaveLength(50);
    expect(await listRunsForWorkspace("acme", {}, { limit: 1.9 })).toHaveLength(1);
    await expect(listRunsForWorkspace("acme", {}, { cursor: "bad" })).rejects.toThrow("Invalid run cursor");
  });
  it.skipIf(!process.env.RUN_NAVIGATION_BENCHMARK)("records plans on one million synthetic runs", async () => {
    await db.query(`INSERT INTO run (id, workspace_id, agent_name, created_at, created_by, user_message)
      SELECT lpad(to_hex(i + 10000), 32, '0')::uuid, 'scale', 'agent-' || (i % 100),
        timestamp '2026-09-01' + (i / 1000) * interval '1 second', 'alice', repeat('x', 1000)
      FROM generate_series(1, 1000000) i`);
    await db.query("ANALYZE run");
    const capture = vi.spyOn(db, "query");
    await listRunsForWorkspace("scale", {}, { limit: 50 });
    const [sql, params] = capture.mock.calls[0];
    capture.mockRestore();
    const plans: Record<string, unknown> = {};
    const measure = async (label: string) => {
      const { rows } = await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
      plans[label] = rows[0]["QUERY PLAN"];
    };
    await measure("existing indexes");
    await db.query(readFileSync(new URL("../../../api/migrations/0095_run_cursor_index.sql", import.meta.url), "utf8"));
    await measure("cursor index");
    if (process.env.RUN_NAVIGATION_PLAN_FILE) {
      writeFileSync(process.env.RUN_NAVIGATION_PLAN_FILE, JSON.stringify(plans, null, 2) + "\n");
    }
    const first = await listRunsForWorkspace("scale", {}, { limit: 50 });
    const second = await listRunsForWorkspace("scale", {}, { limit: 50, cursor: first[49].cursor });
    expect(new Set([...first, ...second].map((r) => r.id)).size).toBe(100);
  }, 120000);

});
