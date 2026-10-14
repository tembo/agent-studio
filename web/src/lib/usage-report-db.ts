import "server-only";

import { db } from "@/lib/db";
import {
  USAGE_PAGE_SIZE,
  USAGE_TIME_ZONE,
  type UsageFilters,
} from "@/lib/usage-report";

export type SpendClass = "development" | "exempt" | "unclassified";
export type UsageBucket = {
  dimension: "users" | "agents" | "automations" | "day" | "total";
  key: string;
  trigger: string | null;
  agent: string | null;
  label: string;
  runs: number;
  knownRuns: number;
  missingCosts: number;
  legacyCosts: number;
  unclassifiedRuns: number;
  total: number;
  development: number;
  exempt: number;
  unclassified: number;
  average: number | null;
};

// Version rows are immutable promotion snapshots (including ones no longer
// selected by agent_release). Looking at the run's selected version or today's
// stable pointer would misclassify draft runs and rewrite pre-promotion spend.
const SOURCE = `WITH first_promotion AS (
  SELECT agent_name, MIN(created_at) AS promoted_at
    FROM agent_version WHERE workspace_id = $1 GROUP BY agent_name
), usage AS (
  SELECT r.id, r.agent_name, r.created_by, r.created_at, r.trigger,
         r.automation_id, r.status, r.is_dry_run, r.orchestrator_run_id,
         r.reused_from_run_id, r.pricing_snapshot,
         CASE WHEN r.reused_from_run_id IS NOT NULL THEN 0 ELSE r.cost_usd END AS cost,
         COALESCE(NULLIF(u.name, '') || ' (' || u.email || ')', u.email, 'Unavailable member') AS user_label,
         COALESCE(a.name, 'Unavailable automation') AS automation_label,
         (r.created_at AT TIME ZONE $4)::date::text AS day,
         CASE WHEN p.promoted_at <= r.created_at THEN 'exempt'
              WHEN r.agent_version_label = 'draft' THEN 'development'
              ELSE 'unclassified' END AS spend_class
    FROM run r
    LEFT JOIN first_promotion p ON p.agent_name = r.agent_name
    LEFT JOIN "user" u ON u.id = r.created_by
    LEFT JOIN automation a ON a.id = r.automation_id AND a.workspace_id = r.workspace_id
   WHERE r.workspace_id = $1
     AND r.created_at >= ($2::date::timestamp AT TIME ZONE $4)
     AND r.created_at < (($3::date + 1)::timestamp AT TIME ZONE $4)
     AND ($5::text IS NULL OR r.agent_name = $5)
     AND ($6::text IS NULL OR r.created_by = $6)
     AND ($7::text IS NULL OR COALESCE(r.automation_id::text, 'unavailable') = $7)
     AND ($8::text IS NULL OR r.trigger = $8)
)`;

function queryValues(workspaceId: string, filters: UsageFilters) {
  return [
    workspaceId,
    filters.from,
    filters.to,
    USAGE_TIME_ZONE,
    filters.agent ?? null,
    filters.user ?? null,
    filters.automation ?? null,
    filters.trigger ?? null,
  ];
}

export async function getUsageReport(
  workspaceId: string,
  filters: UsageFilters,
): Promise<UsageBucket[]> {
  const { rows } = await db.query<UsageBucket>(
    `${SOURCE}
    SELECT d.dimension, d.key, d.trigger, d.agent, MAX(d.label) AS label,
           COUNT(*)::int AS runs, COUNT(cost)::int AS "knownRuns",
           COUNT(*) FILTER (WHERE cost IS NULL)::int AS "missingCosts",
           COUNT(*) FILTER (WHERE cost IS NOT NULL AND pricing_snapshot IS NULL AND reused_from_run_id IS NULL)::int AS "legacyCosts",
           COUNT(*) FILTER (WHERE spend_class = 'unclassified')::int AS "unclassifiedRuns",
           COALESCE(SUM(cost), 0)::double precision AS total,
           COALESCE(SUM(cost) FILTER (WHERE spend_class = 'development'), 0)::double precision AS development,
           COALESCE(SUM(cost) FILTER (WHERE spend_class = 'exempt'), 0)::double precision AS exempt,
           COALESCE(SUM(cost) FILTER (WHERE spend_class = 'unclassified'), 0)::double precision AS unclassified,
           AVG(cost)::double precision AS average
      FROM usage
      CROSS JOIN LATERAL (VALUES
        ('total', 'all', NULL, NULL, 'All runs'),
        ('users', created_by, NULL, NULL, user_label),
        ('agents', agent_name, trigger, NULL, agent_name),
        ('automations', COALESCE(automation_id::text, 'unavailable'), trigger, agent_name, automation_label),
        ('day', day, NULL, NULL, day)
      ) d(dimension, key, trigger, agent, label)
     WHERE d.dimension <> 'automations' OR automation_id IS NOT NULL OR usage.trigger IN ('schedule', 'event')
     GROUP BY d.dimension, d.key, d.trigger, d.agent
     ORDER BY total DESC, runs DESC, d.key, d.trigger, d.agent`,
    queryValues(workspaceId, filters),
  );
  return rows;
}

export type UsageRun = {
  id: string;
  agent_name: string;
  created_at: Date;
  trigger: string;
  status: string;
  is_dry_run: boolean;
  orchestrator_run_id: string | null;
  reused_from_run_id: string | null;
  user_label: string;
  automation_label: string;
  automation_id: string | null;
  cost: number | null;
  spend_class: SpendClass;
};

export async function listUsageRuns(
  workspaceId: string,
  filters: UsageFilters,
): Promise<UsageRun[]> {
  const { rows } = await db.query<UsageRun>(
    `${SOURCE}
    SELECT id, agent_name, created_at, trigger, status, is_dry_run,
           orchestrator_run_id, reused_from_run_id, user_label, automation_label,
           automation_id, cost::double precision, spend_class
      FROM usage ORDER BY created_at DESC, id DESC LIMIT $9 OFFSET $10`,
    [
      ...queryValues(workspaceId, filters),
      USAGE_PAGE_SIZE,
      (filters.page - 1) * USAGE_PAGE_SIZE,
    ],
  );
  return rows;
}
