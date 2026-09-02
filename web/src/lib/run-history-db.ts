import "server-only";

import { db } from "@/lib/db";
import type {
  RunEnvironment,
  RunEnvironmentFilter,
} from "@/lib/run-environment";
import type { RunSummary, RunTrigger } from "@/lib/runs-db";

type RunSummaryRow = {
  id: string;
  agent_name: string;
  status: RunSummary["status"];
  created_at: Date;
  completed_at: Date | null;
  trigger: RunTrigger;
  automation_id: string | null;
  created_by_name: string | null;
  created_by_email: string | null;
  run_environment: RunEnvironment;
};

export type RunExecutionIdentity = {
  name: string | null;
  email: string | null;
};

function toRunSummary(row: RunSummaryRow): RunSummary {
  return {
    id: row.id,
    agentName: row.agent_name,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    trigger: row.trigger,
    automationId: row.automation_id,
    createdByName: row.created_by_name,
    createdByEmail: row.created_by_email,
    runEnvironment: row.run_environment,
  };
}

export async function listRecentRunsForAgent(
  workspaceId: string,
  agentName: string,
  limit = 10,
  environment: RunEnvironmentFilter = "all",
): Promise<RunSummary[]> {
  const { rows } = await db.query<RunSummaryRow>(
    `SELECT r.id, r.agent_name, r.status, r.created_at, r.completed_at,
            r.trigger, r.automation_id, r.run_environment,
            u.name AS created_by_name, u.email AS created_by_email
       FROM run r
       LEFT JOIN "user" u ON u.id = r.created_by
       WHERE r.workspace_id = $1 AND r.agent_name = $2
         AND r.trigger <> 'eval'
         AND ($3::TEXT = 'all' OR r.run_environment = $3)
      ORDER BY r.created_at DESC
      LIMIT $4`,
    [workspaceId, agentName, environment, limit],
  );
  return rows.map(toRunSummary);
}

export async function listRecentRunsForAutomation(
  workspaceId: string,
  automationId: string,
  limit = 10,
): Promise<RunSummary[]> {
  const { rows } = await db.query<RunSummaryRow>(
    `SELECT r.id, r.agent_name, r.status, r.created_at, r.completed_at,
            r.trigger, r.automation_id, r.run_environment,
            u.name AS created_by_name, u.email AS created_by_email
       FROM run r
       LEFT JOIN "user" u ON u.id = r.created_by
      WHERE r.workspace_id = $1 AND r.automation_id = $2
      ORDER BY r.created_at DESC
      LIMIT $3`,
    [workspaceId, automationId, limit],
  );
  return rows.map(toRunSummary);
}

export async function getRunExecutionIdentity(
  workspaceId: string,
  runId: string,
): Promise<RunExecutionIdentity> {
  const { rows } = await db.query<{
    name: string | null;
    email: string | null;
  }>(
    `SELECT u.name, u.email
       FROM run r
       LEFT JOIN "user" u ON u.id = r.created_by
      WHERE r.workspace_id = $1 AND r.id = $2`,
    [workspaceId, runId],
  );
  return rows[0] ?? { name: null, email: null };
}
