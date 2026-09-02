import "server-only";

import { db } from "@/lib/db";
import type { RunEnvironmentFilter } from "@/lib/run-environment";

export type AgentStats30d = {
  totalRuns: number;
  succeeded: number;
  failed: number;
  totalCostUsd: number;
  avgDurationMs: number | null;
};

export type DailyRunBand = {
  status: "success" | "failed" | "other";
  count: number;
};

export type AgentDailyRunBands = {
  day: string;
  bands: DailyRunBand[];
  total: number;
};

export type WorkspaceTopFailingAgent = {
  agentName: string;
  failures: number;
  totalRuns: number;
  lastSeen: Date;
  exampleRunId: string;
};

type RunStatusRow = { day: Date; status: string; created_at: Date };

function rowsToBands(rows: RunStatusRow[]): AgentDailyRunBands[] {
  const out = new Map<string, AgentDailyRunBands>();
  for (const row of rows) {
    const day = row.day.toISOString().slice(0, 10);
    const status: DailyRunBand["status"] =
      row.status === "succeeded"
        ? "success"
        : row.status === "failed"
          ? "failed"
          : "other";
    let entry = out.get(day);
    if (!entry) {
      entry = { day, bands: [], total: 0 };
      out.set(day, entry);
    }
    const last = entry.bands.at(-1);
    if (last?.status === status) last.count += 1;
    else entry.bands.push({ status, count: 1 });
    entry.total += 1;
  }
  return Array.from(out.values());
}

export async function getAgentStats30d(
  workspaceId: string,
  agentName: string,
  environment: RunEnvironmentFilter = "production",
): Promise<AgentStats30d> {
  const { rows } = await db.query<{
    total_runs: string;
    succeeded: string;
    failed: string;
    total_cost_usd: string | null;
    avg_duration_ms: string | null;
  }>(
    `SELECT
        COUNT(*)::TEXT                                      AS total_runs,
        COUNT(*) FILTER (WHERE status = 'succeeded')::TEXT  AS succeeded,
        COUNT(*) FILTER (WHERE status = 'failed')::TEXT     AS failed,
        COALESCE(SUM(cost_usd), 0)::TEXT                    AS total_cost_usd,
        ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)
          FILTER (WHERE completed_at IS NOT NULL AND started_at IS NOT NULL))::TEXT
                                                            AS avg_duration_ms
       FROM run
      WHERE workspace_id = $1 AND agent_name = $2
        AND ($3::TEXT = 'all' OR run_environment = $3)
        AND NOT is_dry_run
        AND created_at >= NOW() - INTERVAL '30 days'`,
    [workspaceId, agentName, environment],
  );
  return mapStats(rows[0]);
}

export async function getAgentDailyRunBands30d(
  workspaceId: string,
  agentName: string,
  environment: RunEnvironmentFilter = "production",
): Promise<AgentDailyRunBands[]> {
  const { rows } = await db.query<RunStatusRow>(
    `SELECT date_trunc('day', created_at) AS day, status, created_at
       FROM run
      WHERE workspace_id = $1 AND agent_name = $2
        AND ($3::TEXT = 'all' OR run_environment = $3)
        AND NOT is_dry_run
        AND created_at >= NOW() - INTERVAL '30 days'
      ORDER BY created_at ASC`,
    [workspaceId, agentName, environment],
  );
  return rowsToBands(rows);
}

export async function listWorkspaceTopFailingAgents30d(
  workspaceId: string,
  limit = 5,
  environment: RunEnvironmentFilter = "production",
): Promise<WorkspaceTopFailingAgent[]> {
  const { rows } = await db.query<{
    agent_name: string;
    failures: string;
    total_runs: string;
    last_seen: Date;
    example_run_id: string;
  }>(
    `SELECT
        agent_name,
        COUNT(*) FILTER (WHERE status = 'failed')::TEXT  AS failures,
        COUNT(*)::TEXT                                    AS total_runs,
        MAX(created_at) FILTER (WHERE status = 'failed') AS last_seen,
        (ARRAY_AGG(id ORDER BY created_at DESC)
           FILTER (WHERE status = 'failed'))[1]          AS example_run_id
       FROM run
      WHERE workspace_id = $1
        AND ($3::TEXT = 'all' OR run_environment = $3)
        AND NOT is_dry_run
        AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY agent_name
     HAVING COUNT(*) FILTER (WHERE status = 'failed') > 0
      ORDER BY failures DESC, last_seen DESC
      LIMIT $2`,
    [workspaceId, limit, environment],
  );
  return rows.map((row) => ({
    agentName: row.agent_name,
    failures: Number(row.failures),
    totalRuns: Number(row.total_runs),
    lastSeen: row.last_seen,
    exampleRunId: row.example_run_id,
  }));
}

export async function getWorkspaceStats30d(
  workspaceId: string,
  environment: RunEnvironmentFilter = "production",
): Promise<AgentStats30d> {
  const { rows } = await db.query<{
    total_runs: string;
    succeeded: string;
    failed: string;
    total_cost_usd: string | null;
    avg_duration_ms: string | null;
  }>(
    `SELECT
        COUNT(*)::TEXT                                      AS total_runs,
        COUNT(*) FILTER (WHERE status = 'succeeded')::TEXT  AS succeeded,
        COUNT(*) FILTER (WHERE status = 'failed')::TEXT     AS failed,
        COALESCE(SUM(cost_usd), 0)::TEXT                    AS total_cost_usd,
        ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)
          FILTER (WHERE completed_at IS NOT NULL AND started_at IS NOT NULL))::TEXT
                                                            AS avg_duration_ms
       FROM run
      WHERE workspace_id = $1
        AND ($2::TEXT = 'all' OR run_environment = $2)
        AND NOT is_dry_run
        AND created_at >= NOW() - INTERVAL '30 days'`,
    [workspaceId, environment],
  );
  return mapStats(rows[0]);
}

export async function getWorkspaceDailyRunBands30d(
  workspaceId: string,
  environment: RunEnvironmentFilter = "production",
): Promise<AgentDailyRunBands[]> {
  const { rows } = await db.query<{
    day: Date;
    status: DailyRunBand["status"];
    count: string;
  }>(
    `WITH normalised AS (
       SELECT date_trunc('day', created_at) AS day,
              CASE status
                WHEN 'succeeded' THEN 'success'
                WHEN 'failed'    THEN 'failed'
                ELSE 'other'
              END AS status,
              created_at
         FROM run
        WHERE workspace_id = $1
          AND ($2::TEXT = 'all' OR run_environment = $2)
          AND NOT is_dry_run
          AND created_at >= NOW() - INTERVAL '30 days'
     ), marked AS (
       SELECT day, status, created_at,
              CASE
                WHEN LAG(status) OVER (PARTITION BY day ORDER BY created_at)
                     IS DISTINCT FROM status
                THEN 1 ELSE 0
              END AS starts_band
         FROM normalised
     ), banded AS (
       SELECT day, status, created_at,
              SUM(starts_band) OVER (
                PARTITION BY day ORDER BY created_at ROWS UNBOUNDED PRECEDING
              ) AS band
         FROM marked
     )
     SELECT day, status, COUNT(*)::TEXT AS count
       FROM banded
      GROUP BY day, band, status
      ORDER BY day ASC, MIN(created_at) ASC`,
    [workspaceId, environment],
  );

  const out = new Map<string, AgentDailyRunBands>();
  for (const row of rows) {
    const day = row.day.toISOString().slice(0, 10);
    let entry = out.get(day);
    if (!entry) {
      entry = { day, bands: [], total: 0 };
      out.set(day, entry);
    }
    const count = Number(row.count);
    entry.bands.push({ status: row.status, count });
    entry.total += count;
  }
  return Array.from(out.values());
}

function mapStats(row: {
  total_runs: string;
  succeeded: string;
  failed: string;
  total_cost_usd: string | null;
  avg_duration_ms: string | null;
}): AgentStats30d {
  return {
    totalRuns: Number(row.total_runs ?? "0"),
    succeeded: Number(row.succeeded ?? "0"),
    failed: Number(row.failed ?? "0"),
    totalCostUsd: Number(row.total_cost_usd ?? "0"),
    avgDurationMs: row.avg_duration_ms ? Number(row.avg_duration_ms) : null,
  };
}
