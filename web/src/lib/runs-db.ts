import "server-only";

import { db } from "@/lib/db";
import type {
  RunEnvironment,
  RunEnvironmentFilter,
} from "@/lib/run-environment";

// Read-only DB views of the run table. The Rust API owns writes (creating
// runs, marking them succeeded/failed); the web layer reads for list +
// detail pages. Both surfaces hit the same Postgres so this is safe.

export type RunTrigger = "manual" | "schedule" | "event" | "eval";

export type RunSummary = {
  id: string;
  agentName: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  createdAt: Date;
  completedAt: Date | null;
  trigger: RunTrigger;
  automationId: string | null;
  createdByName: string | null;
  createdByEmail: string | null;
  runEnvironment: RunEnvironment;
  isDryRun: boolean;
};

export type AgentSummary = {
  agentName: string;
  /** Production runs in the last 30 days, used for the success rate. */
  totalRuns30d: number;
  succeeded30d: number;
  failed30d: number;
  /** Average estimated USD cost over the 30d runs that have a cost (null when
   *  none — e.g. only cargo-ai runs or unpriced models). */
  avgCostUsd30d: number | null;
  /** Latest run regardless of age — null when the agent has never run. */
  lastRunStatus: "queued" | "running" | "succeeded" | "failed" | "cancelled" | null;
  lastRunAt: Date | null;
};

/**
 * Workspace agent-inventory rollup. For each name in `agentNames`,
 * returns 30-day counts + the latest-run snapshot in one round trip.
 * Agents with zero runs come back with all zeros + null last-run —
 * the inventory table still wants to render their row.
 */
export async function listAgentSummaries30d(
  workspaceId: string,
  agentNames: string[],
): Promise<Map<string, AgentSummary>> {
  const out = new Map<string, AgentSummary>();
  if (agentNames.length === 0) return out;

  // CTE: 30d aggregations + the latest run per agent. LEFT JOIN so a
  // name that exists in the repo but has no runs at all still shows
  // up — we want every agent in the inventory, not just the ones
  // that have fired.
  const { rows } = await db.query<{
    agent_name: string;
    total_runs_30d: string | null;
    succeeded_30d: string | null;
    failed_30d: string | null;
    avg_cost_30d: string | null;
    last_run_status: AgentSummary["lastRunStatus"];
    last_run_at: Date | null;
  }>(
    `WITH agent_names AS (
        SELECT UNNEST($2::text[]) AS agent_name
     ),
     agent_stats AS (
        SELECT
            agent_name,
            COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')                                AS total_runs_30d,
            COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days' AND status = 'succeeded')        AS succeeded_30d,
            COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days' AND status = 'failed')           AS failed_30d,
            AVG(cost_usd) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days' AND cost_usd IS NOT NULL)   AS avg_cost_30d
           FROM run
          WHERE workspace_id = $1 AND agent_name = ANY($2::text[])
            AND run_environment = 'production'
            AND trigger <> 'eval'
            AND NOT is_dry_run
          GROUP BY agent_name
     ),
     latest AS (
        SELECT DISTINCT ON (agent_name) agent_name, status, created_at
          FROM run
         WHERE workspace_id = $1 AND agent_name = ANY($2::text[])
           AND trigger <> 'eval'
         ORDER BY agent_name, created_at DESC
     )
     SELECT
        n.agent_name,
        s.total_runs_30d::TEXT,
        s.succeeded_30d::TEXT,
        s.failed_30d::TEXT,
        s.avg_cost_30d::TEXT,
        l.status      AS last_run_status,
        l.created_at  AS last_run_at
       FROM agent_names n
       LEFT JOIN agent_stats s USING (agent_name)
       LEFT JOIN latest l      USING (agent_name)`,
    [workspaceId, agentNames],
  );

  for (const r of rows) {
    out.set(r.agent_name, {
      agentName: r.agent_name,
      totalRuns30d: Number(r.total_runs_30d ?? "0"),
      succeeded30d: Number(r.succeeded_30d ?? "0"),
      failed30d: Number(r.failed_30d ?? "0"),
      avgCostUsd30d: r.avg_cost_30d === null ? null : Number(r.avg_cost_30d),
      lastRunStatus: r.last_run_status,
      lastRunAt: r.last_run_at,
    });
  }
  return out;
}

export {
  listAgentNamesWithRunsForWorkspace,
  listRunsForWorkspace,
} from "@/lib/run-list-db";
export type { RunListFilters, RunListItem } from "@/lib/run-list-db";

export type AgentFailureGroup = {
  /** Safe failure summary, used as the grouping key. */
  errorPrefix: string;
  occurrences: number;
  lastSeen: Date;
  /** One example run id so the user can click through to the full row. */
  exampleRunId: string;
};

/**
 * Top-K safe failure summaries from the last 30 days for one agent.
 * The runner assigns stable summaries, so repeated root causes collapse
 * without exposing diagnostic traces to the dashboard.
 */
export type FailingAgentRecent = {
  agentName: string;
  failures: number;
  lastFailureAt: Date;
};

/**
 * Agents whose **most recent run failed** AND the failure is within
 * the last 24 hours. Drives the "Action needed" sidebar alerts that
 * flag broken agents alongside the missing-connection alerts.
 *
 * The latest-run filter is intentional: a transient failure that
 * the operator already fixed with a subsequent successful run
 * should clear from the sidebar — otherwise yesterday's rate-limit
 * blip nags everyone for a day. The `latest_run` CTE picks the
 * single newest run per agent (any time, any status); the outer
 * query keeps only the agents where that newest run is a failure.
 */
export async function listFailingAgents24h(
  workspaceId: string,
  userId: string,
): Promise<FailingAgentRecent[]> {
  // Scoped to the viewer's own runs (created_by) — the sidebar alert is "your
  // agents are failing", so another member's failures shouldn't nag you. The
  // owner/acting-user is `created_by` (manual click, or the automation/webhook
  // owner for triggered runs).
  const { rows } = await db.query<{
    agent_name: string;
    failures: string;
    last_failure_at: Date;
  }>(
    `WITH latest_run AS (
       SELECT DISTINCT ON (agent_name)
              agent_name, status, created_at
         FROM run
         WHERE workspace_id = $1 AND created_by = $2
           AND NOT is_dry_run
         ORDER BY agent_name, created_at DESC
     )
     SELECT r.agent_name,
            COUNT(*)::TEXT  AS failures,
            MAX(r.created_at) AS last_failure_at
       FROM run r
       JOIN latest_run l
         ON l.agent_name = r.agent_name AND l.status = 'failed'
      WHERE r.workspace_id = $1
        AND r.created_by = $2
         AND r.status = 'failed'
         AND NOT r.is_dry_run
         AND r.created_at >= NOW() - INTERVAL '24 hours'
      GROUP BY r.agent_name
      ORDER BY failures DESC, last_failure_at DESC`,
    [workspaceId, userId],
  );
  return rows.map((r) => ({
    agentName: r.agent_name,
    failures: Number(r.failures),
    lastFailureAt: r.last_failure_at,
  }));
}

export async function listAgentFailureGroups30d(
  workspaceId: string,
  agentName: string,
  limit = 5,
  environment: RunEnvironmentFilter = "production",
): Promise<AgentFailureGroup[]> {
  const { rows } = await db.query<{
    error_prefix: string;
    occurrences: string;
    last_seen: Date;
    example_run_id: string;
  }>(
    `SELECT
        COALESCE(failure_summary, 'The run ended unexpectedly.')    AS error_prefix,
        COUNT(*)::TEXT                                              AS occurrences,
        MAX(created_at)                                             AS last_seen,
        (ARRAY_AGG(id ORDER BY created_at DESC))[1]                 AS example_run_id
       FROM run
      WHERE workspace_id = $1 AND agent_name = $2
        AND status = 'failed'
        AND ($4::TEXT = 'all' OR run_environment = $4)
        AND NOT is_dry_run
        AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY error_prefix
      ORDER BY occurrences DESC, last_seen DESC
      LIMIT $3`,
    [workspaceId, agentName, limit, environment],
  );
  return rows.map((r) => ({
    errorPrefix: r.error_prefix,
    occurrences: Number(r.occurrences),
    lastSeen: r.last_seen,
    exampleRunId: r.example_run_id,
  }));
}

// Tools an agent called during a run, in call order (pydantic runs only).
// ok: true = returned, false = errored, null = never returned (run ended).
// stepOrdinal links the call to the model step that emitted it (null for runs
// recorded before per-step tracking).
export type RunToolCall = {
  ordinal: number;
  toolName: string;
  ok: boolean | null;
  errorMessage: string | null;
  stepOrdinal: number | null;
};

export async function listToolCallsForRun(
  workspaceId: string,
  runId: string,
): Promise<RunToolCall[]> {
  const { rows } = await db.query<{
    ordinal: number;
    tool_name: string;
    ok: boolean | null;
    error_message: string | null;
    step_ordinal: number | null;
  }>(
    `SELECT tc.ordinal, tc.tool_name, tc.ok, tc.error_message, tc.step_ordinal
       FROM run_tool_call tc
       JOIN run r ON r.id = tc.run_id
      WHERE tc.run_id = $1 AND r.workspace_id = $2
      ORDER BY tc.ordinal ASC`,
    [runId, workspaceId],
  );
  return rows.map((r) => ({
    ordinal: r.ordinal,
    toolName: r.tool_name,
    ok: r.ok,
    errorMessage: r.error_message,
    stepOrdinal: r.step_ordinal,
  }));
}

// Per model-request token usage for a run, in step order (pydantic runs only).
// input_tokens are cumulative-by-nature (each request resends the history);
// output_tokens are what the model generated that step.
export type RunStep = {
  ordinal: number;
  /** The model's one-line "what I'm doing this step" note, if it wrote one. */
  summary: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};

export async function listStepsForRun(
  workspaceId: string,
  runId: string,
): Promise<RunStep[]> {
  const { rows } = await db.query<{
    ordinal: number;
    summary: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cache_write_tokens: number | null;
  }>(
    `SELECT s.ordinal, s.summary, s.input_tokens, s.output_tokens,
            s.cache_read_tokens, s.cache_write_tokens
       FROM run_step s
       JOIN run r ON r.id = s.run_id
      WHERE s.run_id = $1 AND r.workspace_id = $2
      ORDER BY s.ordinal ASC`,
    [runId, workspaceId],
  );
  return rows.map((r) => ({
    ordinal: r.ordinal,
    summary: r.summary,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
  }));
}

// Per-tool usage for an agent over the last 30 days — which tools it leans
// on and how often each fails. Mirrors listAgentFailureGroups30d.
export type AgentToolUsage = {
  toolName: string;
  calls: number;
  ok: number;
  failed: number;
};

export async function listAgentToolUsage30d(
  workspaceId: string,
  agentName: string,
  limit = 50,
  environment: RunEnvironmentFilter = "production",
): Promise<AgentToolUsage[]> {
  const { rows } = await db.query<{
    tool_name: string;
    calls: string;
    ok: string;
    failed: string;
  }>(
    `SELECT tc.tool_name,
            COUNT(*)::TEXT                              AS calls,
            COUNT(*) FILTER (WHERE tc.ok IS TRUE)::TEXT  AS ok,
            COUNT(*) FILTER (WHERE tc.ok IS FALSE)::TEXT AS failed
       FROM run_tool_call tc
       JOIN run r ON r.id = tc.run_id
      WHERE r.workspace_id = $1 AND r.agent_name = $2
        AND ($4::TEXT = 'all' OR r.run_environment = $4)
        AND NOT r.is_dry_run
        AND r.created_at >= NOW() - INTERVAL '30 days'
      GROUP BY tc.tool_name
      ORDER BY calls DESC, tc.tool_name ASC
      LIMIT $3`,
    [workspaceId, agentName, limit, environment],
  );
  return rows.map((r) => ({
    toolName: r.tool_name,
    calls: Number(r.calls),
    ok: Number(r.ok),
    failed: Number(r.failed),
  }));
}

// ── Workspace-wide tool-call log (the "Tool uses" page) ──────────────

export type ToolCallOutcome = "ok" | "failed" | "no-result";

export type ToolCallListFilters = {
  agentName?: string;
  toolName?: string;
  outcomes?: ToolCallOutcome[];
  /** ILIKE across tool_name + error_message. */
  search?: string;
};

export type ToolCallListItem = {
  id: string;
  runId: string;
  agentName: string;
  toolName: string;
  ok: boolean | null;
  errorMessage: string | null;
  createdAt: Date;
};

const LIST_TOOL_CALLS_MAX_PAGE = 50;

/** Distinct tool names called in the workspace in the last 30 days — the
 *  "Tool" filter dropdown on the Tool uses page. */
export async function listToolNamesForWorkspace(
  workspaceId: string,
): Promise<string[]> {
  const { rows } = await db.query<{ tool_name: string }>(
    `SELECT DISTINCT tc.tool_name
       FROM run_tool_call tc
       JOIN run r ON r.id = tc.run_id
      WHERE r.workspace_id = $1
        AND r.created_at >= NOW() - INTERVAL '30 days'
      ORDER BY tc.tool_name ASC`,
    [workspaceId],
  );
  return rows.map((r) => r.tool_name);
}

export async function listToolCallsForWorkspace(
  workspaceId: string,
  filters: ToolCallListFilters,
  // Keyset cursor: tool calls in one run share a created_at (batch insert),
  // so we page on (created_at, id) to avoid skipping rows at the boundary.
  options: { limit?: number; before?: { createdAt: Date; id: string } } = {},
): Promise<ToolCallListItem[]> {
  const limit = Math.min(
    Math.max(1, options.limit ?? LIST_TOOL_CALLS_MAX_PAGE),
    LIST_TOOL_CALLS_MAX_PAGE,
  );
  const params: unknown[] = [workspaceId];
  const where: string[] = [`r.workspace_id = $1`];

  if (filters.agentName && filters.agentName.trim()) {
    params.push(filters.agentName.trim());
    where.push(`r.agent_name = $${params.length}`);
  }
  if (filters.toolName && filters.toolName.trim()) {
    params.push(filters.toolName.trim());
    where.push(`tc.tool_name = $${params.length}`);
  }
  if (filters.outcomes && filters.outcomes.length > 0) {
    const ors = filters.outcomes.map((o) =>
      o === "ok" ? "tc.ok IS TRUE" : o === "failed" ? "tc.ok IS FALSE" : "tc.ok IS NULL",
    );
    where.push(`(${ors.join(" OR ")})`);
  }
  if (filters.search && filters.search.trim()) {
    params.push(`%${filters.search.trim()}%`);
    where.push(
      `(tc.tool_name ILIKE $${params.length} OR tc.error_message ILIKE $${params.length})`,
    );
  }
  if (options.before) {
    params.push(options.before.createdAt);
    const tsIdx = params.length;
    params.push(options.before.id);
    const idIdx = params.length;
    where.push(`(tc.created_at, tc.id) < ($${tsIdx}, $${idIdx})`);
  }

  params.push(limit);

  const { rows } = await db.query<{
    id: string;
    run_id: string;
    agent_name: string;
    tool_name: string;
    ok: boolean | null;
    error_message: string | null;
    created_at: Date;
  }>(
    `SELECT tc.id, tc.run_id, r.agent_name, tc.tool_name, tc.ok,
            tc.error_message, tc.created_at
       FROM run_tool_call tc
       JOIN run r ON r.id = tc.run_id
      WHERE ${where.join(" AND ")}
      ORDER BY tc.created_at DESC, tc.id DESC
      LIMIT $${params.length}`,
    params,
  );

  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    agentName: r.agent_name,
    toolName: r.tool_name,
    ok: r.ok,
    errorMessage:
      r.error_message && r.error_message.length > 0
        ? r.error_message.slice(0, 240)
        : null,
    createdAt: r.created_at,
  }));
}
