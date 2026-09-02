import "server-only";

import { db } from "@/lib/db";
import {
  ALL_AUDIT_SOURCES,
  type AuditEntry,
  type AuditSource,
} from "@/lib/audit";

export { ALL_AUDIT_SOURCES, type AuditEntry, type AuditSource };

// Audit timeline data layer (US-0.4-01).
//
// Two responsibilities:
//
//   1. writeAuditEvent — append a row to audit_event for the event
//      types that don't already live in another table (RBAC changes,
//      policy overrides, secret rotations, member changes, connection
//      authorizations, repo connect/disconnect, automation/trigger
//      lifecycle).
//
//   2. listAuditTimeline — unified read across audit_event + derived
//      projections of run + improvement. Returns AuditEntry[] sorted
//      by `at` descending. Existing v0.3 emitters (run lifecycle,
//      improvement lifecycle) project naturally because their tables
//      are already event-shaped (each row is one execution with
//      immutable lifecycle timestamps). Mutable tables (automation,
//      connection, trigger, secret) are NOT projected — they only
//      capture current state, so audit history comes from the
//      explicit writes added at each mutation point.
//
// Pagination is cursor-by-`at` (descending). Caller passes the last
// seen `at` as `before` for the next page. Shared types live in
// @/lib/audit so this module can stay server-only.

export type AuditTimelineFilters = {
  agentName?: string;
  actorUserId?: string;
  sources?: AuditSource[];
  /** Inclusive lower bound. */
  since?: Date;
  /** Exclusive upper bound — pass the last seen `at` for the next page. */
  before?: Date;
};

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

/**
 * Append-only write into audit_event. Returns the inserted entry so
 * callers can include the new id in their action response (e.g.,
 * the run-detail page's "corrected by" backlink).
 */
export async function writeAuditEvent(args: {
  workspaceId: string;
  actorUserId: string | null;
  source: AuditSource;
  kind: string;
  targetType: string;
  targetId: string | null;
  agentName: string | null;
  payload?: Record<string, unknown>;
  referencesEventId?: string | null;
}): Promise<AuditEntry> {
  const { rows } = await db.query<{
    id: string;
    workspace_id: string;
    actor_user_id: string | null;
    at: Date;
    source: AuditSource;
    kind: string;
    target_type: string;
    target_id: string | null;
    agent_name: string | null;
    payload: Record<string, unknown> | null;
    references_event_id: string | null;
  }>(
    `INSERT INTO audit_event
       (workspace_id, actor_user_id, source, kind, target_type, target_id,
        agent_name, payload, references_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, workspace_id, actor_user_id, at, source, kind,
                 target_type, target_id, agent_name, payload,
                 references_event_id`,
    [
      args.workspaceId,
      args.actorUserId,
      args.source,
      args.kind,
      args.targetType,
      args.targetId,
      args.agentName,
      JSON.stringify(args.payload ?? {}),
      args.referencesEventId ?? null,
    ],
  );
  const r = rows[0];
  return {
    id: r.id,
    origin: "audit_event",
    workspaceId: r.workspace_id,
    actorUserId: r.actor_user_id,
    actorDisplayName: null,
    at: r.at,
    source: r.source,
    kind: r.kind,
    targetType: r.target_type,
    targetId: r.target_id,
    agentName: r.agent_name,
    payload: r.payload ?? {},
    referencesEventId: r.references_event_id,
  };
}

/**
 * Unified read across audit_event + derived run/improvement events.
 *
 * Three parallel queries (one per source), then JS merge + sort +
 * limit. The cost is a few extra rows fetched per query that get
 * dropped at merge time; that's acceptable until workspaces exceed
 * tens of thousands of events, at which point we'd switch to a
 * single SQL UNION with pushed-down LIMIT.
 */
export async function listAuditTimeline(
  workspaceId: string,
  filters: AuditTimelineFilters = {},
  limit: number = DEFAULT_LIMIT,
): Promise<AuditEntry[]> {
  const cappedLimit = Math.min(Math.max(1, limit), MAX_LIMIT);

  // Each source pulls cappedLimit rows independently — after merging
  // we trim to cappedLimit again. Worst case we fetched 3x what we
  // need, which is fine at the scales this UI sees.
  const [explicit, runEvents, improvementEvents] = await Promise.all([
    fetchExplicitEvents(workspaceId, filters, cappedLimit),
    fetchRunEvents(workspaceId, filters, cappedLimit),
    fetchImprovementEvents(workspaceId, filters, cappedLimit),
  ]);

  const merged = [...explicit, ...runEvents, ...improvementEvents];
  // Stable sort: newest first, ties broken by id so paging through
  // a busy stretch doesn't skip events with identical timestamps.
  merged.sort((a, b) => {
    const d = b.at.getTime() - a.at.getTime();
    if (d !== 0) return d;
    return b.id.localeCompare(a.id);
  });
  return merged.slice(0, cappedLimit);
}

/**
 * Distinct actor user ids that appear in this workspace's timeline.
 * Used by the filter UI to populate the actor dropdown. Walks
 * audit_event + run.created_by + improvement.created_by; the result
 * is the set's union.
 */
export async function listAuditActors(
  workspaceId: string,
): Promise<{ userId: string; displayName: string | null; email: string }[]> {
  const { rows } = await db.query<{
    user_id: string;
    name: string | null;
    email: string;
  }>(
    `SELECT DISTINCT u.id AS user_id, u.name, u.email
       FROM "user" u
      WHERE u.id IN (
        SELECT DISTINCT actor_user_id FROM audit_event
          WHERE workspace_id = $1 AND actor_user_id IS NOT NULL
        UNION
        SELECT DISTINCT created_by FROM run WHERE workspace_id = $1
        UNION
        SELECT DISTINCT created_by FROM improvement WHERE workspace_id = $1
      )
      ORDER BY u.name NULLS LAST, u.email`,
    [workspaceId],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    displayName: r.name,
    email: r.email,
  }));
}

// ────────────────────────────────────────────────────────────────────
// Internal: per-source fetchers

async function fetchExplicitEvents(
  workspaceId: string,
  filters: AuditTimelineFilters,
  limit: number,
): Promise<AuditEntry[]> {
  const params: unknown[] = [workspaceId];
  const where: string[] = [`a.workspace_id = $1`];

  if (filters.agentName) {
    params.push(`%${filters.agentName}%`);
    where.push(`a.agent_name ILIKE $${params.length}`);
  }
  if (filters.actorUserId) {
    params.push(filters.actorUserId);
    where.push(`a.actor_user_id = $${params.length}`);
  }
  if (filters.sources && filters.sources.length > 0) {
    params.push(filters.sources);
    where.push(`a.source = ANY($${params.length}::text[])`);
  }
  if (filters.since) {
    params.push(filters.since);
    where.push(`a.at >= $${params.length}`);
  }
  if (filters.before) {
    params.push(filters.before);
    where.push(`a.at < $${params.length}`);
  }
  params.push(limit);

  const { rows } = await db.query<{
    id: string;
    workspace_id: string;
    actor_user_id: string | null;
    actor_name: string | null;
    actor_email: string | null;
    at: Date;
    source: AuditSource;
    kind: string;
    target_type: string;
    target_id: string | null;
    agent_name: string | null;
    payload: Record<string, unknown> | null;
    references_event_id: string | null;
  }>(
    `SELECT a.id, a.workspace_id, a.actor_user_id,
            u.name AS actor_name, u.email AS actor_email,
            a.at, a.source, a.kind, a.target_type, a.target_id,
            a.agent_name, a.payload, a.references_event_id
       FROM audit_event a
       LEFT JOIN "user" u ON u.id = a.actor_user_id
      WHERE ${where.join(" AND ")}
      ORDER BY a.at DESC, a.id DESC
      LIMIT $${params.length}`,
    params,
  );

  return rows.map((r) => ({
    id: r.id,
    origin: "audit_event" as const,
    workspaceId: r.workspace_id,
    actorUserId: r.actor_user_id,
    actorDisplayName: r.actor_name ?? r.actor_email,
    at: r.at,
    source: r.source,
    kind: r.kind,
    targetType: r.target_type,
    targetId: r.target_id,
    agentName: r.agent_name,
    payload: r.payload ?? {},
    referencesEventId: r.references_event_id,
  }));
}

async function fetchRunEvents(
  workspaceId: string,
  filters: AuditTimelineFilters,
  limit: number,
): Promise<AuditEntry[]> {
  // Source mapping: manual runs are user-driven (human_action);
  // scheduled and event-triggered runs are system. Sources filter
  // is applied in SQL so we don't fetch+discard.
  const sourcesFilter = filters.sources;
  const includesHumanAction = !sourcesFilter || sourcesFilter.includes("human_action");
  const includesSystem = !sourcesFilter || sourcesFilter.includes("system");
  if (!includesHumanAction && !includesSystem) return [];

  const triggerWhere: string[] = [];
  if (!includesHumanAction) triggerWhere.push(`trigger <> 'manual'`);
  if (!includesSystem)
    triggerWhere.push(`trigger NOT IN ('schedule', 'event')`);

  const params: unknown[] = [workspaceId];
  const where: string[] = [`workspace_id = $1`, `trigger <> 'eval'`];
  if (filters.agentName) {
    params.push(`%${filters.agentName}%`);
    where.push(`agent_name ILIKE $${params.length}`);
  }
  if (filters.actorUserId) {
    params.push(filters.actorUserId);
    where.push(`created_by = $${params.length}`);
  }
  if (filters.since) {
    params.push(filters.since);
    where.push(`COALESCE(completed_at, started_at, created_at) >= $${params.length}`);
  }
  if (filters.before) {
    params.push(filters.before);
    where.push(`COALESCE(completed_at, started_at, created_at) < $${params.length}`);
  }
  if (triggerWhere.length > 0) {
    where.push(`(${triggerWhere.join(" AND ")})`);
  }
  params.push(limit);

  const { rows } = await db.query<{
    id: string;
    workspace_id: string;
    created_by: string;
    actor_name: string | null;
    actor_email: string | null;
    at: Date;
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    trigger: "manual" | "schedule" | "event";
    run_environment: "production" | "development";
    agent_name: string;
    duration_ms: string | null;
    cost_usd: string | null;
    failure_summary: string | null;
  }>(
    `SELECT r.id, r.workspace_id, r.created_by,
            u.name AS actor_name, u.email AS actor_email,
            COALESCE(r.completed_at, r.started_at, r.created_at) AS at,
            r.status, r.trigger, r.run_environment, r.agent_name,
            (EXTRACT(EPOCH FROM (r.completed_at - r.started_at)) * 1000)::TEXT AS duration_ms,
            r.cost_usd::TEXT AS cost_usd,
            r.failure_summary
       FROM run r
       LEFT JOIN "user" u ON u.id = r.created_by
      WHERE ${where.join(" AND ")}
      ORDER BY at DESC, r.id DESC
      LIMIT $${params.length}`,
    params,
  );

  return rows.map((r) => ({
    id: r.id,
    origin: "run" as const,
    workspaceId: r.workspace_id,
    actorUserId: r.created_by,
    actorDisplayName: r.actor_name ?? r.actor_email,
    at: r.at,
    source: r.trigger === "manual" ? "human_action" : "system",
    kind: `run.${r.status}`,
    targetType: "run",
    targetId: r.id,
    agentName: r.agent_name,
    payload: {
      status: r.status,
      trigger: r.trigger,
      environment: r.run_environment,
      durationMs: r.duration_ms ? Number(r.duration_ms) : null,
      costUsd: r.cost_usd ? Number(r.cost_usd) : null,
      errorMessage:
        r.status === "failed"
          ? (r.failure_summary ?? "The run ended unexpectedly.")
          : null,
    },
    referencesEventId: null,
  }));
}

async function fetchImprovementEvents(
  workspaceId: string,
  filters: AuditTimelineFilters,
  limit: number,
): Promise<AuditEntry[]> {
  // Improvements are chat-originated by definition (the source bucket
  // the audit UI groups them under). If the caller filtered chat out
  // of the source set, skip the table.
  if (filters.sources && !filters.sources.includes("chat")) return [];

  const params: unknown[] = [workspaceId];
  const where: string[] = [`i.workspace_id = $1`];
  if (filters.agentName) {
    params.push(`%${filters.agentName}%`);
    where.push(`i.agent_name ILIKE $${params.length}`);
  }
  if (filters.actorUserId) {
    params.push(filters.actorUserId);
    where.push(`i.created_by = $${params.length}`);
  }
  if (filters.since) {
    params.push(filters.since);
    where.push(`i.created_at >= $${params.length}`);
  }
  if (filters.before) {
    params.push(filters.before);
    where.push(`i.created_at < $${params.length}`);
  }
  params.push(limit);

  const { rows } = await db.query<{
    id: string;
    workspace_id: string;
    created_by: string;
    actor_name: string | null;
    actor_email: string | null;
    at: Date;
    agent_name: string;
    status: "submitted" | "pr_opened" | "merged" | "closed";
    improvement_text: string;
    pr_url: string | null;
    pr_number: number | null;
  }>(
    `SELECT i.id, i.workspace_id, i.created_by,
            u.name AS actor_name, u.email AS actor_email,
            i.created_at AS at,
            i.agent_name, i.status, i.improvement_text,
            i.pr_url, i.pr_number
       FROM improvement i
       LEFT JOIN "user" u ON u.id = i.created_by
      WHERE ${where.join(" AND ")}
      ORDER BY at DESC, i.id DESC
      LIMIT $${params.length}`,
    params,
  );

  return rows.map((r) => ({
    id: r.id,
    origin: "improvement" as const,
    workspaceId: r.workspace_id,
    actorUserId: r.created_by,
    actorDisplayName: r.actor_name ?? r.actor_email,
    at: r.at,
    source: "chat" as const,
    kind: `improvement.${r.status}`,
    targetType: "improvement",
    targetId: r.id,
    agentName: r.agent_name,
    payload: {
      status: r.status,
      improvementText: r.improvement_text.slice(0, 200),
      prUrl: r.pr_url,
      prNumber: r.pr_number,
    },
    referencesEventId: null,
  }));
}
