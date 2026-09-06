import "server-only";

import { db } from "@/lib/db";
import type { RunEnvironment } from "@/lib/run-environment";
import type { RunSummary, RunTrigger } from "@/lib/runs-db";

export type RunListFilters = {
  statuses?: RunSummary["status"][];
  agentName?: string;
  triggers?: RunTrigger[];
  environments?: RunEnvironment[];
  search?: string;
  /** Acting user (run.created_by) — used by the member-detail view. */
  createdBy?: string;
  /** When true, only dry-run rows. Absent/false shows every run. */
  dryRun?: boolean;
};

export type RunListItem = {
  id: string;
  agentName: string;
  status: RunSummary["status"];
  trigger: RunTrigger;
  automationId: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  userMessagePreview: string;
  errorMessagePreview: string | null;
  costUsd: number | null;
  createdByName: string | null;
  createdByEmail: string | null;
  slack: {
    appName: string;
    slackUserId: string | null;
    permalink: string | null;
    channel: string;
  } | null;
  sms?: {
    phoneNumber: string;
  } | null;
  agentVersionLabel: string | null;
  runEnvironment: RunEnvironment;
  isDryRun: boolean;
};

const LIST_RUNS_MAX_PAGE = 50;
const UUID_RE =
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

// Keep this expression identical to migration 0076's trigram index expression.
// PostgreSQL can then use the GIN index for substring matches instead of
// scanning every historical run in the workspace.
const SEARCH_TEXT_SQL = `(r.agent_name || E'\n' || COALESCE(r.user_message, '') || E'\n' || COALESCE(r.output, '') || E'\n' || COALESCE(r.failure_summary, '') || E'\n' || COALESCE(r.error_message, ''))`;

export async function listRunsForWorkspace(
  workspaceId: string,
  filters: RunListFilters,
  options: { limit?: number; before?: Date } = {},
): Promise<RunListItem[]> {
  const limit = Math.min(
    Math.max(1, options.limit ?? LIST_RUNS_MAX_PAGE),
    LIST_RUNS_MAX_PAGE,
  );
  const params: unknown[] = [workspaceId];
  const where: string[] = [`r.workspace_id = $1`];

  if (filters.statuses && filters.statuses.length > 0) {
    params.push(filters.statuses);
    where.push(`r.status = ANY($${params.length}::text[])`);
  }
  if (filters.agentName && filters.agentName.trim()) {
    params.push(filters.agentName.trim());
    where.push(`r.agent_name = $${params.length}`);
  }
  if (filters.triggers && filters.triggers.length > 0) {
    params.push(filters.triggers);
    where.push(`r.trigger = ANY($${params.length}::text[])`);
  } else {
    where.push(`r.trigger <> 'eval'`);
  }
  if (filters.environments && filters.environments.length > 0) {
    params.push(filters.environments);
    where.push(`r.run_environment = ANY($${params.length}::text[])`);
  }
  if (filters.dryRun) {
    where.push(`r.is_dry_run`);
  }
  if (filters.createdBy && filters.createdBy.trim()) {
    params.push(filters.createdBy.trim());
    where.push(`r.created_by = $${params.length}`);
  }
  if (filters.search && filters.search.trim()) {
    const search = filters.search.trim();
    const identityIds = await listMatchingIdentityIds(search);
    const searchClauses: string[] = [];

    params.push(`%${escapeLikePattern(search)}%`);
    searchClauses.push(
      `${SEARCH_TEXT_SQL} ILIKE $${params.length} ESCAPE '\\'`,
    );

    if (UUID_RE.test(search)) {
      params.push(search);
      searchClauses.push(`r.id = $${params.length}::uuid`);
    }
    if (identityIds.length > 0) {
      params.push(identityIds);
      searchClauses.push(`r.created_by = ANY($${params.length}::text[])`);
    }
    where.push(`(${searchClauses.join(" OR ")})`);
  }
  if (options.before) {
    params.push(options.before);
    where.push(`r.created_at < $${params.length}`);
  }

  params.push(limit);

  const { rows } = await db.query<{
    id: string;
    agent_name: string;
    status: RunSummary["status"];
    trigger: RunTrigger;
    automation_id: string | null;
    created_at: Date;
    started_at: Date | null;
    completed_at: Date | null;
    user_message: string;
    failure_summary: string | null;
    cost_usd: string | null;
    created_by_name: string | null;
    created_by_email: string | null;
    slack_app_name: string | null;
    slack_user_id: string | null;
    slack_permalink: string | null;
    slack_channel: string | null;
    sms_phone_number: string | null;
    agent_version_label: string | null;
    run_environment: RunEnvironment;
    is_dry_run: boolean;
  }>(
    `SELECT r.id, r.agent_name, r.status, r.trigger, r.automation_id,
            r.created_at, r.started_at, r.completed_at, r.user_message,
            r.failure_summary, r.cost_usd, r.agent_version_label,
            r.run_environment, r.is_dry_run,
            u.name AS created_by_name, u.email AS created_by_email,
            sa.name AS slack_app_name, sd.slack_user_id,
            sd.permalink AS slack_permalink, sd.channel AS slack_channel,
            sc.phone_number AS sms_phone_number
       FROM run r
       LEFT JOIN "user" u ON u.id = r.created_by
       LEFT JOIN slack_delivery sd ON sd.run_id = r.id
       LEFT JOIN workspace_slack_app sa ON sa.id = sd.slack_app_id
       LEFT JOIN sms_delivery smsd ON smsd.run_id = r.id
       LEFT JOIN workspace_sms_channel sc ON sc.id = smsd.sms_channel_id
      WHERE ${where.join(" AND ")}
      ORDER BY r.created_at DESC
      LIMIT $${params.length}`,
    params,
  );

  return rows.map((row) => ({
    id: row.id,
    agentName: row.agent_name,
    status: row.status,
    trigger: row.trigger,
    automationId: row.automation_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    userMessagePreview: (row.user_message ?? "").slice(0, 200),
    errorMessagePreview:
      row.status === "failed"
        ? (row.failure_summary ?? "The run ended unexpectedly.")
        : null,
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    createdByName: row.created_by_name,
    createdByEmail: row.created_by_email,
    slack: row.slack_channel
      ? {
          appName: row.slack_app_name ?? "Slack",
          slackUserId: row.slack_user_id,
          permalink: row.slack_permalink,
          channel: row.slack_channel,
        }
      : null,
    sms: row.sms_phone_number
      ? { phoneNumber: row.sms_phone_number }
      : null,
    agentVersionLabel: row.agent_version_label,
    runEnvironment: row.run_environment,
    isDryRun: row.is_dry_run,
  }));
}

export async function listAgentNamesWithRunsForWorkspace(
  workspaceId: string,
): Promise<string[]> {
  const { rows } = await db.query<{ agent_name: string }>(
    `SELECT DISTINCT agent_name
       FROM run
      WHERE workspace_id = $1
      ORDER BY agent_name ASC`,
    [workspaceId],
  );
  return rows.map((row) => row.agent_name);
}

async function listMatchingIdentityIds(search: string): Promise<string[]> {
  const pattern = `%${escapeLikePattern(search)}%`;
  const { rows } = await db.query<{ id: string }>(
    `SELECT id
       FROM "user"
      WHERE name ILIKE $1 ESCAPE '\\' OR email ILIKE $1 ESCAPE '\\'`,
    [pattern],
  );
  return rows.map((row) => row.id);
}

function escapeLikePattern(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}
