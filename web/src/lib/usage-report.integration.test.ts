import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { schema, connectionString } = vi.hoisted(() => ({
  schema: `usage_report_test_${Date.now()}`,
  connectionString: process.env.USAGE_REPORT_TEST_DATABASE_URL,
}));
vi.mock("@/lib/db", async () => {
  const { Pool } = await import("pg");
  return {
    db: new Pool({ connectionString, options: `-c search_path=${schema}` }),
  };
});
import { db } from "./db";
import { getUsageReport, listUsageRuns } from "./usage-report-db";
import { parseUsageFilters } from "./usage-report";

describe.skipIf(!connectionString)("usage report PostgreSQL accounting", () => {
  const ws = "00000000-0000-0000-0000-000000000001";
  const other = "00000000-0000-0000-0000-000000000002";
  const automation = "00000000-0000-0000-0000-000000000003";
  const filters = parseUsageFilters({ from: "2026-10-01", to: "2026-10-14" });
  beforeAll(async () => {
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`CREATE TABLE "user" (id text, name text, email text);
      CREATE TABLE automation (id uuid, workspace_id uuid, name text);
      CREATE TABLE agent_version (workspace_id uuid, agent_name text, created_at timestamptz);
      CREATE TABLE run (
        id uuid DEFAULT gen_random_uuid(), workspace_id uuid, agent_name text,
        created_by text, created_at timestamptz, trigger text DEFAULT 'manual',
        automation_id uuid, status text DEFAULT 'succeeded', is_dry_run boolean DEFAULT false,
        orchestrator_run_id uuid, reused_from_run_id uuid, pricing_snapshot jsonb,
        cost_usd numeric, agent_version_label text DEFAULT 'draft');`);
    await db.query(`INSERT INTO "user" VALUES ('alice', 'Alice', 'alice@example.test'), ('bob', 'Bob', 'bob@example.test');
      INSERT INTO automation VALUES ('${automation}', '${ws}', 'Email drafter');
      INSERT INTO agent_version VALUES ('${ws}', 'drafter', '2026-10-07T12:00Z'), ('${other}', 'child', '2026-01-01T00:00Z');`);
    await db.query(
      `INSERT INTO run (workspace_id, agent_name, created_by, created_at, cost_usd, trigger, automation_id, pricing_snapshot) VALUES
      ($1, 'drafter', 'alice', '2026-10-06T12:00Z', 2, 'schedule', $2, '{}'),
      ($1, 'drafter', 'bob', '2026-10-08T12:00Z', 3, 'schedule', $2, '{}'),
      ($1, 'drafter', 'alice', '2026-10-07T12:00Z', 4, 'manual', NULL, '{}'),
      ($1, 'child', 'bob', '2026-10-08T13:00Z', 5, 'manual', NULL, '{}'),
      ($1, 'eval-agent', 'alice', '2026-10-08T14:00Z', 1, 'eval', NULL, '{}'),
      ($1, 'dry-agent', 'alice', '2026-10-08T15:00Z', 0.5, 'manual', NULL, '{}'),
      ($1, 'unknown-cost', 'bob', '2026-10-08T16:00Z', NULL, 'manual', NULL, NULL),
      ($1, 'legacy', 'former-user', '2026-10-08T17:00Z', 6, 'manual', NULL, NULL),
      ($1, 'reused', 'bob', '2026-10-08T18:00Z', 0, 'manual', NULL, NULL),
      ($1, 'deleted-automation', 'bob', '2026-10-08T19:00Z', 0.25, 'schedule', NULL, '{}'),
      ($1, 'before-window', 'bob', '2026-10-01T03:59:59Z', 1000, 'manual', NULL, '{}'),
      ($1, 'after-window', 'bob', '2026-10-15T04:00:00Z', 1000, 'manual', NULL, '{}'),
      ($3, 'drafter', 'alice', '2026-10-08T12:00Z', 1000, 'schedule', $2, '{}')`,
      [ws, automation, other],
    );
    await db.query(`UPDATE run SET orchestrator_run_id = gen_random_uuid() WHERE agent_name = 'child';
      UPDATE run SET is_dry_run = true WHERE agent_name = 'dry-agent';
      UPDATE run SET status = 'failed' WHERE agent_name = 'unknown-cost';
      UPDATE run SET agent_version_label = NULL WHERE agent_name = 'legacy';
      UPDATE run SET reused_from_run_id = gen_random_uuid() WHERE agent_name = 'reused';`);
  });
  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.end();
  });

  it("counts every run's own cost once, retaining unavailable costs and lifecycle uncertainty", async () => {
    const report = await getUsageReport(ws, filters);
    expect(report.find((r) => r.dimension === "total")).toMatchObject({
      runs: 10,
      knownRuns: 9,
      missingCosts: 1,
      legacyCosts: 1,
      total: 21.75,
      development: 8.75,
      exempt: 7,
      unclassified: 6,
      unclassifiedRuns: 1,
      average: 21.75 / 9,
    });
    const agent = (name: string) =>
      report.find((r) => r.dimension === "agents" && r.key === name);
    expect(agent("drafter")).toMatchObject({
      trigger: "schedule",
      total: 5,
      development: 2,
      exempt: 3,
    });
    expect(agent("child")).toMatchObject({ total: 5, development: 5 });
    expect(agent("eval-agent")).toMatchObject({ total: 1, runs: 1 });
    expect(agent("dry-agent")).toMatchObject({ total: 0.5, runs: 1 });
    expect(agent("unknown-cost")).toMatchObject({
      total: 0,
      average: null,
      missingCosts: 1,
    });
    expect(agent("reused")).toMatchObject({
      total: 0,
      average: 0,
      missingCosts: 0,
      legacyCosts: 0,
    });
  });

  it("combines automation spend across run-as users while keeping agent and trigger identity", async () => {
    const report = await getUsageReport(ws, filters);
    expect(
      report.find((r) => r.dimension === "automations" && r.key === automation),
    ).toMatchObject({
      label: "Email drafter",
      agent: "drafter",
      trigger: "schedule",
      runs: 2,
      total: 5,
    });
    expect(
      report.find((r) => r.dimension === "users" && r.key === "alice"),
    ).toMatchObject({ total: 7.5 });
    expect(
      report.find((r) => r.dimension === "users" && r.key === "former-user"),
    ).toMatchObject({ label: "Unavailable member", total: 6 });
    const selected = {
      ...filters,
      automation,
      agent: "drafter",
      trigger: "schedule",
    };
    expect((await listUsageRuns(ws, selected)).map((r) => r.cost)).toEqual([
      3, 2,
    ]);
    expect(
      (await getUsageReport(ws, selected)).find((r) => r.dimension === "total")
        ?.total,
    ).toBe(5);
    expect(
      await listUsageRuns(ws, {
        ...filters,
        automation: "unavailable",
        agent: "deleted-automation",
        trigger: "schedule",
      }),
    ).toHaveLength(1);
  });

  it("scopes both summaries and drill-downs to the workspace, user, agent, and dates", async () => {
    const selected = {
      ...filters,
      user: "alice",
      agent: "drafter",
      from: "2026-10-07",
      to: "2026-10-07",
    };
    expect(await listUsageRuns(ws, selected)).toHaveLength(1);
    expect(
      (await getUsageReport(ws, selected)).find((r) => r.dimension === "total"),
    ).toMatchObject({ total: 4, exempt: 4 });
    expect(
      await getUsageReport(ws, { ...filters, agent: "' OR 1=1 --" }),
    ).toEqual([]);
    expect(
      await listUsageRuns(ws, { ...filters, automation: "not-a-uuid" }),
    ).toEqual([]);
  });

  it("uses Eastern calendar boundaries through DST changes", async () => {
    await db.query(
      `INSERT INTO run (workspace_id, agent_name, created_by, created_at, cost_usd) VALUES
      ($1, 'dst', 'alice', '2026-11-01T03:59:59Z', 100),
      ($1, 'dst', 'alice', '2026-11-01T04:00:00Z', 1),
      ($1, 'dst', 'alice', '2026-11-02T04:59:59Z', 2),
      ($1, 'dst', 'alice', '2026-11-02T05:00:00Z', 100)`,
      [ws],
    );
    const dst = {
      ...filters,
      from: "2026-11-01",
      to: "2026-11-01",
      agent: "dst",
    };
    expect(
      (await getUsageReport(ws, dst)).find((r) => r.dimension === "day"),
    ).toMatchObject({ key: "2026-11-01", total: 3, runs: 2 });
    expect(await listUsageRuns(ws, dst)).toHaveLength(2);
  });

  it("does not reclassify previous development spend after a later promotion", async () => {
    await db.query(
      `INSERT INTO agent_version VALUES ($1, 'child', '2026-10-09T00:00Z')`,
      [ws],
    );
    expect(
      (await getUsageReport(ws, filters)).find(
        (r) => r.dimension === "agents" && r.key === "child",
      ),
    ).toMatchObject({ development: 5, exempt: 0 });
  });

  it("paginates deterministically when runs share a timestamp", async () => {
    await db.query(
      `INSERT INTO run (workspace_id, agent_name, created_by, created_at, cost_usd)
      SELECT $1, 'pagination', 'alice', '2026-10-08T00:00Z', 1 FROM generate_series(1, 51)`,
      [ws],
    );
    const selected = { ...filters, agent: "pagination" };
    const first = await listUsageRuns(ws, selected);
    const second = await listUsageRuns(ws, { ...selected, page: 2 });
    expect(first).toHaveLength(50);
    expect(second).toHaveLength(1);
    expect(new Set([...first, ...second].map((r) => r.id)).size).toBe(51);
  });
});
