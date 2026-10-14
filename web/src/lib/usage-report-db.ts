import "server-only";

import { db } from "@/lib/db";
import { USAGE_PAGE_SIZE, USAGE_TIME_ZONE, type UsageFilters } from "@/lib/usage-report";

export type UsageMetrics = {
  runs: number;
  knownCost: number | null;
  averageCost: number | null;
  missingCosts: number;
  developmentCost: number | null;
  exemptCost: number | null;
  unclassifiedCost: number | null;
  unclassifiedRuns: number;
  reusedRuns: number;
  dryRuns: number;
  evalRuns: number;
  subRuns: number;
};
export type UsageGroupRow = UsageMetrics & {
  label: string;
  filters: Partial<UsageFilters>;
};
export type UsageDay = UsageMetrics & { day: string };
export type UsageRun = {
  id: string;
  agent: string;
  user: string;
  trigger: string;
  automation: string;
  started: string;
  status: string;
  cost: number | null;
  classification: "development" | "exempt" | "unclassified";
  dryRun: boolean;
  reused: boolean;
  subRun: boolean;
};
export type UsageReport = {
  summary: UsageMetrics;
  groups: UsageGroupRow[];
  days: UsageDay[];
  runs: UsageRun[];
  groupCount: number;
};

// Stored run costs are direct costs, not orchestrator totals. Every execution
// appears once; a reuse receipt adds no cost from its producer.
const METRICS = `
  count(*)::int AS runs,
  CASE WHEN count(*) = 0 THEN 0 ELSE sum(cost) END AS "knownCost", avg(cost) AS "averageCost",
  count(*) FILTER (WHERE cost IS NULL)::int AS "missingCosts",
  CASE WHEN count(*) FILTER (WHERE classification = 'development') = 0 THEN 0
    ELSE sum(cost) FILTER (WHERE classification = 'development') END AS "developmentCost",
  CASE WHEN count(*) FILTER (WHERE classification = 'exempt') = 0 THEN 0
    ELSE sum(cost) FILTER (WHERE classification = 'exempt') END AS "exemptCost",
  CASE WHEN count(*) FILTER (WHERE classification = 'unclassified') = 0 THEN 0
    ELSE sum(cost) FILTER (WHERE classification = 'unclassified') END AS "unclassifiedCost",
  count(*) FILTER (WHERE classification = 'unclassified')::int AS "unclassifiedRuns",
  count(*) FILTER (WHERE reused)::int AS "reusedRuns",
  count(*) FILTER (WHERE "dryRun")::int AS "dryRuns",
  count(*) FILTER (WHERE trigger = 'eval')::int AS "evalRuns",
  count(*) FILTER (WHERE "subRun")::int AS "subRuns"`;

/** Call only after checking workspace-admin access. All joins are workspace-scoped. */
export async function getUsageReport(workspaceId: string, filters: UsageFilters): Promise<UsageReport> {
  const { rows } = await db.query<UsageReport>(`
    WITH promotions AS (
      SELECT agent_name, min(created_at) AS first_promoted, min(version_number) AS first_version
      FROM agent_version WHERE workspace_id = $1 GROUP BY agent_name
    ), source AS (
      SELECT r.id, r.agent_name AS agent, r.created_by AS user_id, r.automation_id,
        COALESCE(NULLIF(u.name, '') || ' (' || u.email || ')', u.email, 'Unavailable member') AS "user",
        r.trigger, COALESCE(a.name, CASE WHEN r.trigger IN ('schedule', 'event')
          THEN 'Unavailable automation' ELSE 'No saved automation' END) AS automation,
        COALESCE(r.started_at, r.created_at) AS started, r.status,
        r.is_dry_run AS "dryRun", r.orchestrator_run_id IS NOT NULL AS "subRun",
        r.reused_from_run_id IS NOT NULL AS reused,
        CASE WHEN r.reused_from_run_id IS NOT NULL THEN 0 ELSE r.cost_usd END AS cost,
        CASE
          WHEN p.first_promoted <= r.created_at OR r.agent_version_label ~ '^v[0-9]+$' THEN 'exempt'
          WHEN r.agent_version_label = 'draft' AND (p.first_version IS NULL OR p.first_version = 1) THEN 'development'
          ELSE 'unclassified'
        END AS classification
      FROM run r
      LEFT JOIN promotions p ON p.agent_name = r.agent_name
      LEFT JOIN "user" u ON u.id = r.created_by
      LEFT JOIN automation a ON a.id = r.automation_id AND a.workspace_id = r.workspace_id
      WHERE r.workspace_id = $1
        AND COALESCE(r.started_at, r.created_at) >= ($2::date::timestamp AT TIME ZONE $11)
        AND COALESCE(r.started_at, r.created_at) < (($3::date + 1)::timestamp AT TIME ZONE $11)
        AND ($5::text IS NULL OR r.created_by = $5)
        AND ($6::text IS NULL OR r.agent_name = $6)
        AND ($7::text IS NULL OR COALESCE(r.automation_id::text, 'none') = $7)
        AND ($8::text IS NULL OR r.trigger = $8)
        AND ($9::text IS NULL OR (r.orchestrator_run_id IS NOT NULL) = ($9 = 'sub-agent'))
    ), scoped AS MATERIALIZED (
      SELECT *, (started AT TIME ZONE $11)::date::text AS day,
        CASE $4
          WHEN 'users' THEN jsonb_build_object('user', user_id)
          WHEN 'automations' THEN jsonb_build_object('automation', COALESCE(automation_id::text, 'none'),
            'agent', agent, 'trigger', trigger, 'kind', CASE WHEN "subRun" THEN 'sub-agent' ELSE 'direct' END)
          ELSE jsonb_build_object('agent', agent, 'trigger', trigger,
            'kind', CASE WHEN "subRun" THEN 'sub-agent' ELSE 'direct' END)
        END AS filters,
        CASE $4 WHEN 'users' THEN "user" WHEN 'automations' THEN automation ELSE agent END AS label
      FROM source
    ), grouped AS (
      SELECT filters, label, ${METRICS} FROM scoped GROUP BY filters, label
    ), daily AS (
      SELECT day, ${METRICS} FROM scoped GROUP BY day
    ), totals AS (
      SELECT ${METRICS} FROM scoped
    ), recent AS (
      SELECT id, agent, "user", trigger, automation, started, status, cost, classification,
        "dryRun", reused, "subRun"
      FROM scoped ORDER BY started DESC, id DESC LIMIT ${USAGE_PAGE_SIZE} OFFSET $10
    )
    SELECT (SELECT to_jsonb(totals) FROM totals) AS summary,
      COALESCE((SELECT jsonb_agg(g ORDER BY g."knownCost" DESC NULLS LAST, g.label, g.filters)
        FROM (SELECT * FROM grouped ORDER BY "knownCost" DESC NULLS LAST, label, filters LIMIT 100) g), '[]') AS groups,
      (SELECT count(*)::int FROM grouped) AS "groupCount",
      COALESCE((SELECT jsonb_agg(daily ORDER BY day) FROM daily), '[]') AS days,
      COALESCE((SELECT jsonb_agg(recent ORDER BY started DESC, id DESC) FROM recent), '[]') AS runs
  `, [workspaceId, filters.from, filters.to, filters.group, filters.user ?? null,
    filters.agent ?? null, filters.automation ?? null, filters.trigger ?? null,
    filters.kind ?? null, (filters.page - 1) * USAGE_PAGE_SIZE, USAGE_TIME_ZONE]);
  const report = rows[0];
  const days = new Map(report.days.map((day) => [day.day, day]));
  report.days = [];
  for (let time = Date.parse(filters.from); time <= Date.parse(filters.to); time += 86_400_000) {
    const day = new Date(time).toISOString().slice(0, 10);
    report.days.push(days.get(day) ?? { day, runs: 0, knownCost: 0, averageCost: null,
      missingCosts: 0, developmentCost: 0, exemptCost: 0, unclassifiedCost: 0,
      unclassifiedRuns: 0, reusedRuns: 0, dryRuns: 0, evalRuns: 0, subRuns: 0 });
  }
  return report;
}
