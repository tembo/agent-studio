import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { schema, connectionString } = vi.hoisted(() => ({
  schema: `usage_report_${Date.now()}`, connectionString: process.env.USAGE_REPORT_TEST_DATABASE_URL,
}));
vi.mock("@/lib/db", async () => {
  const { Pool } = await import("pg");
  return { db: new Pool({ connectionString, options: `-c search_path=${schema}` }) };
});
import { db } from "./db";
import { getUsageReport } from "./usage-report-db";
import { parseUsageFilters } from "./usage-report";

const schedule = "00000000-0000-0000-0000-000000000001";
const options = (extra = {}) => parseUsageFilters({ from: "2026-10-01", to: "2026-10-14", ...extra });

describe.skipIf(!connectionString)("usage report accounting in PostgreSQL", () => {
  beforeAll(async () => {
    await db.query(`CREATE SCHEMA ${schema};
      CREATE TABLE "user" (id text PRIMARY KEY, name text, email text);
      CREATE TABLE automation (id uuid PRIMARY KEY, workspace_id text, name text);
      CREATE TABLE agent_version (workspace_id text, agent_name text, version_number int, created_at timestamptz);
      CREATE TABLE run (
        id uuid PRIMARY KEY, workspace_id text NOT NULL, agent_name text NOT NULL, created_by text,
        automation_id uuid, trigger text DEFAULT 'manual', status text DEFAULT 'succeeded',
        created_at timestamptz NOT NULL, started_at timestamptz, cost_usd numeric(12,6),
        agent_version_label text, is_dry_run boolean DEFAULT false,
        orchestrator_run_id uuid, reused_from_run_id uuid
      );
      INSERT INTO "user" VALUES ('alice', 'Alice', 'alice@example.com'), ('bob', 'Bob', 'bob@example.com');
      INSERT INTO automation VALUES ('${schedule}', 'acme', 'Email every two hours');
      INSERT INTO agent_version VALUES ('acme', 'email', 1, '2026-10-05T12:00:00Z'),
        ('other', 'never-promoted', 1, '2026-09-01T00:00:00Z'),
        ('acme', 'incomplete', 2, '2026-10-10T00:00:00Z');
      INSERT INTO run (id, workspace_id, agent_name, created_by, automation_id, trigger,
        created_at, started_at, cost_usd, agent_version_label)
      VALUES
        ('00000000-0000-0000-0000-000000000001', 'acme', 'email', 'alice', '${schedule}', 'schedule', '2026-10-03T12:00Z', '2026-10-03T12:00Z', 10, 'draft'),
        ('00000000-0000-0000-0000-000000000002', 'acme', 'email', 'bob', '${schedule}', 'schedule', '2026-10-06T12:00Z', '2026-10-06T12:00Z', 20, 'draft'),
        ('00000000-0000-0000-0000-000000000003', 'acme', 'never-promoted', 'bob', null, 'manual', '2026-10-07T12:00Z', '2026-10-07T12:00Z', 3, 'draft'),
        ('00000000-0000-0000-0000-000000000004', 'acme', 'never-promoted', 'bob', null, 'eval', '2026-10-07T13:00Z', '2026-10-07T13:00Z', 2, 'draft'),
        ('00000000-0000-0000-0000-000000000005', 'acme', 'legacy', 'alice', null, 'manual', '2026-10-07T12:00Z', '2026-10-07T12:00Z', 4, null),
        ('00000000-0000-0000-0000-000000000006', 'acme', 'legacy', 'alice', null, 'manual', '2026-10-07T12:00Z', '2026-10-07T12:00Z', null, null),
        ('00000000-0000-0000-0000-000000000007', 'acme', 'email', 'bob', null, 'manual', '2026-10-07T12:00Z', '2026-10-07T12:00Z', 20, 'v1'),
        ('00000000-0000-0000-0000-000000000008', 'acme', 'incomplete', 'bob', null, 'manual', '2026-10-07T12:00Z', '2026-10-07T12:00Z', 1, 'draft'),
        ('00000000-0000-0000-0000-000000000009', 'other', 'email', 'alice', '${schedule}', 'schedule', '2026-10-07T12:00Z', '2026-10-07T12:00Z', 999, 'draft');
      UPDATE run SET orchestrator_run_id = '00000000-0000-0000-0000-000000000002', is_dry_run = true WHERE id = '00000000-0000-0000-0000-000000000003';
      UPDATE run SET reused_from_run_id = '00000000-0000-0000-0000-000000000002' WHERE id = '00000000-0000-0000-0000-000000000007';
      UPDATE run SET status = 'failed' WHERE id = '00000000-0000-0000-0000-000000000006';
    `);
  });
  afterAll(async () => { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.end(); });

  it("counts each execution once, keeps unavailable prices explicit, and isolates workspaces", async () => {
    const report = await getUsageReport("acme", options());
    expect(report.summary).toMatchObject({ runs: 8, knownCost: 40, missingCosts: 1,
      developmentCost: 15, exemptCost: 20, unclassifiedCost: 5, unclassifiedRuns: 3,
      subRuns: 1, dryRuns: 1, evalRuns: 1, reusedRuns: 1 });
    expect(report.summary.averageCost).toBeCloseTo(40 / 7);
    expect(report.days).toHaveLength(14);
    expect(report.days[0]).toMatchObject({ day: "2026-10-01", runs: 0, knownCost: 0 });
    expect(report.runs.find((r) => r.id.endsWith("0007"))?.cost).toBe(0);
  });
  it("preserves development spend before promotion while exempting later draft runs", async () => {
    const report = await getUsageReport("acme", options({ agent: "email", trigger: "schedule" }));
    expect(report.summary).toMatchObject({ runs: 2, knownCost: 30, developmentCost: 10, exemptCost: 20 });
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0].knownCost).toBe(30);
    expect(report.runs.map((r) => r.classification)).toEqual(["exempt", "development"]);
  });
  it("attributes to run-as users and rolls schedules up across users", async () => {
    const users = await getUsageReport("acme", options({ group: "users" }));
    expect(users.groups.find((r) => r.filters.user === "alice")?.knownCost).toBe(14);
    expect(users.groups.find((r) => r.filters.user === "bob")?.knownCost).toBe(26);
    const automations = await getUsageReport("acme", options({ group: "automations", automation: schedule }));
    expect(automations.groups).toHaveLength(1);
    expect(automations.groups[0]).toMatchObject({ label: "Email every two hours", runs: 2, knownCost: 30 });
  });
  it("drills down to the same exact agent, trigger and sub-agent group", async () => {
    const report = await getUsageReport("acme", options());
    const group = report.groups.find((r) => r.filters.kind === "sub-agent")!;
    const detail = await getUsageReport("acme", options(group.filters));
    expect(detail.summary.runs).toBe(group.runs);
    expect(detail.summary.knownCost).toBe(group.knownCost);
    expect(detail.runs.every((r) => r.subRun)).toBe(true);
  });
  it("shows absent costs as unavailable, but empty selections as zero spend", async () => {
    const report = await getUsageReport("acme", options({ agent: "legacy" }));
    expect(report.summary).toMatchObject({ knownCost: 4, missingCosts: 1, developmentCost: 0 });
    const empty = await getUsageReport("acme", options({ user: "outsider" }));
    expect(empty.summary).toMatchObject({ runs: 0, knownCost: 0, averageCost: null });
    expect(empty.runs).toEqual([]);
  });
  it("uses Eastern date boundaries and start time, including DST and unfinished work", async () => {
    await db.query(`INSERT INTO run (id,workspace_id,agent_name,created_at,started_at,cost_usd,agent_version_label)
      VALUES ('00000000-0000-0000-0000-000000000010','dates','agent','2026-11-01T03:00Z','2026-11-01T04:00Z',1,'draft'),
      ('00000000-0000-0000-0000-000000000011','dates','agent','2026-11-02T04:59Z',null,null,'draft'),
      ('00000000-0000-0000-0000-000000000012','dates','agent','2026-11-02T04:59Z','2026-11-02T05:00Z',100,'draft')`);
    const report = await getUsageReport("dates", options({ from: "2026-11-01", to: "2026-11-01" }));
    expect(report.summary).toMatchObject({ runs: 2, knownCost: 1, missingCosts: 1 });
    expect(report.days[0].runs).toBe(2);
  });
  it("paginates tied timestamps without repeating runs and keeps complete totals", async () => {
    await db.query(`INSERT INTO run (id, workspace_id, agent_name, created_at, cost_usd)
      SELECT lpad(to_hex(i + 100),32,'0')::uuid,'pages','agent','2026-10-03T12:00Z',1 FROM generate_series(1,65) i`);
    const first = await getUsageReport("pages", options());
    const second = await getUsageReport("pages", options({ page: "2" }));
    expect(first.runs).toHaveLength(50);
    expect(second.runs).toHaveLength(15);
    expect(new Set([...first.runs, ...second.runs].map((r) => r.id)).size).toBe(65);
    expect(second.summary.knownCost).toBe(65);
  });
});
