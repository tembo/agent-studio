import "server-only";

import { db } from "@/lib/db";

// Read-only DB views of the run table. The Rust API owns writes (creating
// runs, marking them succeeded/failed); the web layer reads for list +
// detail pages. Both surfaces hit the same Postgres so this is safe.

export type RunTrigger = "manual" | "schedule" | "event";

// A run spawned by another run via the tembo-agent-studio MCP `trigger_run`
// tool. Shown on the parent run's page so an orchestrator's true cost (its own
// + every sub-run) is visible in one place.
export type ChildRun = {
  id: string;
  agentName: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  costUsd: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  createdAt: Date;
};

// Distinct tool names invoked across every sub-run a given run spawned via
// trigger_run. The caller maps these to provider slugs (via the workspace
// tool→provider table) to show which MCPs the sub-agents actually used —
// the orchestrator's own connection row only lists its top-level MCPs.
export async function listChildRunToolNames(
  workspaceId: string,
  parentRunId: string,
): Promise<string[]> {
  const { rows } = await db.query<{ tool_name: string }>(
    `SELECT DISTINCT tc.tool_name
       FROM run_tool_call tc
       JOIN run r ON r.id = tc.run_id
      WHERE r.workspace_id = $1 AND r.parent_run_id = $2`,
    [workspaceId, parentRunId],
  );
  return rows.map((r) => r.tool_name);
}

// Distinct orchestrator → sub-agent edges across the workspace, derived from
// the parent_run_id graph: an edge means some run of `parentAgentName` spawned
// (via trigger_run) a run of `childAgentName`. The agents list uses these to
// show, per orchestrator, which MCPs its sub-agents bring in. Self-edges
// (an agent triggering itself) are excluded.
export async function listAgentSubAgentEdges(
  workspaceId: string,
): Promise<{ parentAgentName: string; childAgentName: string }[]> {
  const { rows } = await db.query<{
    parent_agent: string;
    child_agent: string;
  }>(
    `SELECT DISTINCT parent.agent_name AS parent_agent,
            child.agent_name AS child_agent
       FROM run child
       JOIN run parent ON parent.id = child.parent_run_id
      WHERE child.workspace_id = $1
        AND parent.agent_name <> child.agent_name`,
    [workspaceId],
  );
  return rows.map((r) => ({
    parentAgentName: r.parent_agent,
    childAgentName: r.child_agent,
  }));
}

export async function listChildRuns(
  workspaceId: string,
  parentRunId: string,
): Promise<ChildRun[]> {
  const { rows } = await db.query<{
    id: string;
    agent_name: string;
    status: ChildRun["status"];
    cost_usd: string | null;
    tokens_input: number | null;
    tokens_output: number | null;
    created_at: Date;
  }>(
    `SELECT id, agent_name, status, cost_usd, tokens_input, tokens_output, created_at
       FROM run
      WHERE workspace_id = $1 AND parent_run_id = $2
      ORDER BY created_at ASC`,
    [workspaceId, parentRunId],
  );
  return rows.map((r) => ({
    id: r.id,
    agentName: r.agent_name,
    status: r.status,
    // cost_usd is NUMERIC — pg returns it as a string.
    costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
    tokensInput: r.tokens_input,
    tokensOutput: r.tokens_output,
    createdAt: r.created_at,
  }));
}

export type RunSummary = {
  id: string;
  agentName: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  createdAt: Date;
  completedAt: Date | null;
  trigger: RunTrigger;
  automationId: string | null;
};

export type AgentSummary = {
  agentName: string;
  /** Last 30 days. Both ok/failed live here, used for the success rate. */
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
         GROUP BY agent_name
     ),
     latest AS (
        SELECT DISTINCT ON (agent_name) agent_name, status, created_at
          FROM run
         WHERE workspace_id = $1 AND agent_name = ANY($2::text[])
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

// Runs that originated from the /chat composer (non-empty
// user_message). "Run now" runs come through with an empty
// user_message — they're not part of the conversation thread, so
// we skip them here. Returns the user message + agent output so
// the chat UI can render both halves of each turn.
export interface ChatRun {
  id: string;
  agentName: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  userMessage: string;
  output: string;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export async function listChatRunsForAgent(
  workspaceId: string,
  agentName: string,
  limit = 50,
): Promise<ChatRun[]> {
  const { rows } = await db.query<{
    id: string;
    agent_name: string;
    status: ChatRun["status"];
    user_message: string;
    output: string;
    failure_summary: string | null;
    created_at: Date;
    completed_at: Date | null;
  }>(
    `SELECT id, agent_name, status, user_message, output, failure_summary, created_at, completed_at
       FROM run
      WHERE workspace_id = $1 AND agent_name = $2
        AND user_message IS NOT NULL AND user_message <> ''
      ORDER BY created_at ASC
      LIMIT $3`,
    [workspaceId, agentName, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    agentName: r.agent_name,
    status: r.status,
    userMessage: r.user_message,
    output: r.output,
    errorMessage: r.failure_summary ?? "The run ended unexpectedly.",
    createdAt: r.created_at,
    completedAt: r.completed_at,
  }));
}

// Workspace-wide run list with optional filters. Status / trigger
// arrays use ANY() so an empty array means "no filter" via NULL
// coalescing on the parameter; agentName is a scalar; search runs an
// ILIKE on user_message + output + safe failure summary + privileged
// diagnostics. Pagination is
// cursor-by-created_at (descending), passing the last seen createdAt
// as `before` for the next page. limit is enforced server-side to
// keep queries cheap.

export type RunListFilters = {
  statuses?: RunSummary["status"][];
  agentName?: string;
  triggers?: RunTrigger[];
  search?: string;
  /** Acting user (run.created_by) — used by the member-detail view. */
  createdBy?: string;
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
  // First slice of the user_message so the list row can preview the
  // input without round-tripping to the run detail page. Empty when
  // the run had no input (the manual "Run now" path).
  userMessagePreview: string;
  // Safe failure summary for failed runs — lets the table
  // surface why a run failed without clicking through. Null on rows
  // that didn't fail or didn't carry an error string.
  errorMessagePreview: string | null;
  // Estimated USD cost — computed + persisted by the Rust runner at
  // mark_succeeded time so the UI doesn't recompute every render.
  // Null for: runs that pre-date the column, frameworks that don't
  // report token usage (cargo-ai today), or models not in the
  // pricing table.
  costUsd: number | null;
  // Who the run acted as (run.created_by), resolved for display. Null
  // when the user row was deleted.
  createdByName: string | null;
  createdByEmail: string | null;
  // Present when the run was instigated from a Slack bot (a slack_delivery
  // row exists). Lets the runs UI show "Slack · <bot>" and deep-link back
  // to the originating conversation.
  slack: {
    appName: string;
    slackUserId: string | null;
    permalink: string | null;
    channel: string;
  } | null;
  // Which agent version ran ("v3" | "draft"), or null for pre-feature runs.
  agentVersionLabel: string | null;
};

const LIST_RUNS_MAX_PAGE = 50;

export async function listRunsForWorkspace(
  workspaceId: string,
  filters: RunListFilters,
  options: { limit?: number; before?: Date } = {},
): Promise<RunListItem[]> {
  const limit = Math.min(Math.max(1, options.limit ?? LIST_RUNS_MAX_PAGE), LIST_RUNS_MAX_PAGE);
  const params: unknown[] = [workspaceId];
  // Track each filter as a SQL fragment that references positional
  // placeholders we push into `params`. We build the WHERE in order
  // so the query is deterministic + readable in pg logs.
  // Columns are qualified with the `run` alias `r` because the query now
  // LEFT JOINs slack_delivery / user / workspace_slack_app, several of
  // which carry same-named columns (created_at, channel, name).
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
  }
  if (filters.createdBy && filters.createdBy.trim()) {
    params.push(filters.createdBy.trim());
    where.push(`r.created_by = $${params.length}`);
  }
  if (filters.search && filters.search.trim()) {
    // Single placeholder reused across the OR; ILIKE on user_message,
    // output, safe failure summary, and diagnostics so an admin can grep
    // across input, success output, and failure text in one shot. Only the
    // safe summary is returned to the caller. Caller is
    // expected to keep the search term short (~200 chars) — the UI
    // input enforces that.
    params.push(`%${filters.search.trim()}%`);
    where.push(
      `(r.user_message ILIKE $${params.length} OR r.output ILIKE $${params.length} OR r.failure_summary ILIKE $${params.length} OR r.error_message ILIKE $${params.length})`,
    );
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
    // pg returns NUMERIC as a string by default to preserve precision.
    // Parse on the way out.
    cost_usd: string | null;
    created_by_name: string | null;
    created_by_email: string | null;
    slack_app_name: string | null;
    slack_user_id: string | null;
    slack_permalink: string | null;
    slack_channel: string | null;
    agent_version_label: string | null;
  }>(
    `SELECT r.id, r.agent_name, r.status, r.trigger, r.automation_id,
            r.created_at, r.started_at, r.completed_at, r.user_message,
            r.failure_summary, r.cost_usd, r.agent_version_label,
            u.name AS created_by_name, u.email AS created_by_email,
            sa.name AS slack_app_name, sd.slack_user_id,
            sd.permalink AS slack_permalink, sd.channel AS slack_channel
       FROM run r
       LEFT JOIN "user" u ON u.id = r.created_by
       LEFT JOIN slack_delivery sd ON sd.run_id = r.id
       LEFT JOIN workspace_slack_app sa ON sa.id = sd.slack_app_id
      WHERE ${where.join(" AND ")}
      ORDER BY r.created_at DESC
      LIMIT $${params.length}`,
    params,
  );

  return rows.map((r) => ({
    id: r.id,
    agentName: r.agent_name,
    status: r.status,
    trigger: r.trigger,
    automationId: r.automation_id,
    createdAt: r.created_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    userMessagePreview: (r.user_message ?? "").slice(0, 200),
    errorMessagePreview:
      r.status === "failed"
        ? (r.failure_summary ?? "The run ended unexpectedly.")
        : null,
    costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
    createdByName: r.created_by_name,
    createdByEmail: r.created_by_email,
    slack: r.slack_channel
      ? {
          appName: r.slack_app_name ?? "Slack",
          slackUserId: r.slack_user_id,
          permalink: r.slack_permalink,
          channel: r.slack_channel,
        }
      : null,
    agentVersionLabel: r.agent_version_label,
  }));
}

// Distinct agent names that have ever produced a run, scoped to a
// workspace. Powers the agent picker on /runs so users only see
// agents with history (not the full repo list, which can include
// recently-created agents that haven't run).
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
  return rows.map((r) => r.agent_name);
}

// ── Operational dashboard aggregations ──────────────────────────────
//
// These feed the per-agent dashboard at /<workspace>/agents/<name>.
// All scoped to (workspace_id, agent_name) and the last 30 days so
// queries stay cheap and stats reflect "recent" behavior rather
// than lifetime totals (which would mask new failures behind old
// successes once an agent has been around for a while).

export type AgentStats30d = {
  totalRuns: number;
  succeeded: number;
  failed: number;
  /** Sum of cost_usd over the window, in USD. Null tokens count as 0. */
  totalCostUsd: number;
  /** Mean (completed_at - started_at), in ms, for runs that completed. */
  avgDurationMs: number | null;
};

export async function getAgentStats30d(
  workspaceId: string,
  agentName: string,
): Promise<AgentStats30d> {
  const { rows } = await db.query<{
    total_runs: string;
    succeeded: string;
    failed: string;
    total_cost_usd: string | null;
    avg_duration_ms: string | null;
  }>(
    `SELECT
        COUNT(*)::TEXT                                            AS total_runs,
        COUNT(*) FILTER (WHERE status = 'succeeded')::TEXT        AS succeeded,
        COUNT(*) FILTER (WHERE status = 'failed')::TEXT           AS failed,
        COALESCE(SUM(cost_usd), 0)::TEXT                          AS total_cost_usd,
        ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - started_at))
                    * 1000) FILTER (WHERE completed_at IS NOT NULL
                                      AND started_at IS NOT NULL))::TEXT
                                                                  AS avg_duration_ms
       FROM run
      WHERE workspace_id = $1 AND agent_name = $2
        AND created_at >= NOW() - INTERVAL '30 days'`,
    [workspaceId, agentName],
  );
  const r = rows[0];
  return {
    totalRuns: Number(r.total_runs ?? "0"),
    succeeded: Number(r.succeeded ?? "0"),
    failed: Number(r.failed ?? "0"),
    totalCostUsd: Number(r.total_cost_usd ?? "0"),
    avgDurationMs: r.avg_duration_ms ? Number(r.avg_duration_ms) : null,
  };
}

export type DailyRunBand = {
  status: "success" | "failed" | "other";
  /** How many consecutive runs of this status lit up in this band. */
  count: number;
};

export type AgentDailyRunBands = {
  /** Calendar date in UTC, YYYY-MM-DD. */
  day: string;
  /** Run-length-encoded sequence of statuses, time-ordered earliest
   *  → latest. A day with `4 failed → 3 succeeded → 3 failed` lands
   *  here as three bands so the dashboard can render it as three
   *  stacked color stripes. */
  bands: DailyRunBand[];
  /** Convenience: sum of band counts. The trend chart uses this to
   *  size each band's flex-basis within the day's box. */
  total: number;
};

type RunStatusRow = { day: Date; status: string; created_at: Date };

function rowsToBands(rows: RunStatusRow[]): AgentDailyRunBands[] {
  // SQL returns one row per run, sorted by created_at. We bucket by
  // day and RLE within each day. Status normalisation collapses
  // anything that isn't "succeeded" or "failed" into "other" so the
  // rendering layer doesn't have to deal with queued/running/cancelled
  // bands separately.
  const out = new Map<string, AgentDailyRunBands>();
  for (const r of rows) {
    const day = r.day.toISOString().slice(0, 10);
    const status: DailyRunBand["status"] =
      r.status === "succeeded"
        ? "success"
        : r.status === "failed"
          ? "failed"
          : "other";
    let entry = out.get(day);
    if (!entry) {
      entry = { day, bands: [], total: 0 };
      out.set(day, entry);
    }
    const last = entry.bands[entry.bands.length - 1];
    if (last && last.status === status) last.count += 1;
    else entry.bands.push({ status, count: 1 });
    entry.total += 1;
  }
  return Array.from(out.values());
}

/**
 * Per-day, time-ordered run-status bands for the last 30 days.
 * Sparse — days with zero runs aren't returned; the dashboard fills
 * the gaps when rendering so the chart is always 30 boxes wide.
 *
 * One row per run with day + status + created_at, RLE'd in JS into
 * consecutive same-status bands. The window function alternative
 * (precomputing RLE in SQL with `LAG`) would be cleaner but the
 * 30-day per-agent volume is bounded at low thousands, so the
 * client-side roll-up stays cheap and easy to reason about.
 */
export async function getAgentDailyRunBands30d(
  workspaceId: string,
  agentName: string,
): Promise<AgentDailyRunBands[]> {
  const { rows } = await db.query<RunStatusRow>(
    `SELECT date_trunc('day', created_at) AS day,
            status,
            created_at
       FROM run
      WHERE workspace_id = $1 AND agent_name = $2
        AND created_at >= NOW() - INTERVAL '30 days'
      ORDER BY created_at ASC`,
    [workspaceId, agentName],
  );
  return rowsToBands(rows);
}

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

export type WorkspaceTopFailingAgent = {
  agentName: string;
  failures: number;
  /** Total runs in the window — denominator for the failure rate. */
  totalRuns: number;
  lastSeen: Date;
  exampleRunId: string;
};

/**
 * Top-K agents by 30-day failure count. Workspace-wide equivalent
 * of the per-agent failure-prefix grouping — at the workspace level
 * "which agent is failing" is the useful pivot, since the same
 * error string can come from very different agents.
 */
export async function listWorkspaceTopFailingAgents30d(
  workspaceId: string,
  limit = 5,
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
        AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY agent_name
     HAVING COUNT(*) FILTER (WHERE status = 'failed') > 0
      ORDER BY failures DESC, last_seen DESC
      LIMIT $2`,
    [workspaceId, limit],
  );
  return rows.map((r) => ({
    agentName: r.agent_name,
    failures: Number(r.failures),
    totalRuns: Number(r.total_runs),
    lastSeen: r.last_seen,
    exampleRunId: r.example_run_id,
  }));
}

export async function getWorkspaceStats30d(
  workspaceId: string,
): Promise<AgentStats30d> {
  const { rows } = await db.query<{
    total_runs: string;
    succeeded: string;
    failed: string;
    total_cost_usd: string | null;
    avg_duration_ms: string | null;
  }>(
    `SELECT
        COUNT(*)::TEXT                                            AS total_runs,
        COUNT(*) FILTER (WHERE status = 'succeeded')::TEXT        AS succeeded,
        COUNT(*) FILTER (WHERE status = 'failed')::TEXT           AS failed,
        COALESCE(SUM(cost_usd), 0)::TEXT                          AS total_cost_usd,
        ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - started_at))
                    * 1000) FILTER (WHERE completed_at IS NOT NULL
                                      AND started_at IS NOT NULL))::TEXT
                                                                  AS avg_duration_ms
       FROM run
      WHERE workspace_id = $1
        AND created_at >= NOW() - INTERVAL '30 days'`,
    [workspaceId],
  );
  const r = rows[0];
  return {
    totalRuns: Number(r.total_runs ?? "0"),
    succeeded: Number(r.succeeded ?? "0"),
    failed: Number(r.failed ?? "0"),
    totalCostUsd: Number(r.total_cost_usd ?? "0"),
    avgDurationMs: r.avg_duration_ms ? Number(r.avg_duration_ms) : null,
  };
}

/**
 * Workspace-scope sibling of {@link getAgentDailyRunBands30d}.
 *
 * This one spans every agent in the workspace, so the "bounded at low
 * thousands" assumption that makes the per-agent JS roll-up cheap doesn't
 * hold — a busy workspace shipped one row per run to Node on every dashboard
 * render. The run-length encoding happens in SQL here instead, so the result
 * set is one row per *band* (what the chart actually draws) rather than one
 * row per run.
 */
export async function getWorkspaceDailyRunBands30d(
  workspaceId: string,
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
          AND created_at >= NOW() - INTERVAL '30 days'
     ),
     -- Flag each run whose status differs from the previous run that day.
     -- A running sum of those flags numbers the consecutive same-status
     -- groups, which is exactly the run-length encoding the chart wants.
     marked AS (
       SELECT day, status, created_at,
              CASE
                WHEN LAG(status) OVER (PARTITION BY day ORDER BY created_at)
                     IS DISTINCT FROM status
                THEN 1 ELSE 0
              END AS starts_band
         FROM normalised
     ),
     banded AS (
       SELECT day, status, created_at,
              SUM(starts_band) OVER (
                PARTITION BY day ORDER BY created_at
                ROWS UNBOUNDED PRECEDING
              ) AS band
         FROM marked
     )
     SELECT day, status, COUNT(*)::TEXT AS count
       FROM banded
      GROUP BY day, band, status
      ORDER BY day ASC, MIN(created_at) ASC`,
    [workspaceId],
  );

  const out = new Map<string, AgentDailyRunBands>();
  for (const r of rows) {
    const day = r.day.toISOString().slice(0, 10);
    let entry = out.get(day);
    if (!entry) {
      entry = { day, bands: [], total: 0 };
      out.set(day, entry);
    }
    const count = Number(r.count);
    entry.bands.push({ status: r.status, count });
    entry.total += count;
  }
  return Array.from(out.values());
}

export async function listAgentFailureGroups30d(
  workspaceId: string,
  agentName: string,
  limit = 5,
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
        AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY error_prefix
      ORDER BY occurrences DESC, last_seen DESC
      LIMIT $3`,
    [workspaceId, agentName, limit],
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
        AND r.created_at >= NOW() - INTERVAL '30 days'
      GROUP BY tc.tool_name
      ORDER BY calls DESC, tc.tool_name ASC
      LIMIT $3`,
    [workspaceId, agentName, limit],
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

export async function listRecentRunsForAgent(
  workspaceId: string,
  agentName: string,
  limit = 10,
): Promise<RunSummary[]> {
  const { rows } = await db.query<{
    id: string;
    agent_name: string;
    status: RunSummary["status"];
    created_at: Date;
    completed_at: Date | null;
    trigger: RunTrigger;
    automation_id: string | null;
  }>(
    `SELECT id, agent_name, status, created_at, completed_at, trigger, automation_id
       FROM run
      WHERE workspace_id = $1 AND agent_name = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [workspaceId, agentName, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    agentName: r.agent_name,
    status: r.status,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    trigger: r.trigger,
    automationId: r.automation_id,
  }));
}
