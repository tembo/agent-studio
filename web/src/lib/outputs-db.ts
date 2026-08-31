import "server-only";

import type { AgentDelivery } from "@/lib/agent-format";
import { db } from "@/lib/db";

export const DELIVERY_STATUSES = [
  "confirmed",
  "partial",
  "failed",
  "unobserved",
  "undeclared",
] as const;

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export type DestinationStatus = "confirmed" | "failed" | "unobserved";

export type DeliveryEvidenceSnapshot = {
  destinations: { key: string; status: DestinationStatus }[];
};

export type OutputListFilters = {
  search?: string;
  agentName?: string;
  orchestratorName?: string;
  createdBy?: string;
  completedFrom?: Date;
  completedBefore?: Date;
  deliveryStatus?: DeliveryStatus;
  cursor?: string;
};

export type OutputListItem = {
  runId: string;
  agentName: string;
  orchestratorRunId: string;
  orchestratorName: string;
  createdBy: string;
  createdByName: string | null;
  createdByEmail: string | null;
  completedAt: Date;
  outputPreview: string;
  agentVersionLabel: string | null;
  delivery: AgentDelivery | null;
  deliveryStatus: DeliveryStatus;
};

export type OutputPage = {
  items: OutputListItem[];
  nextCursor: string | null;
};

export type OutputDetail = OutputListItem & {
  workspaceId: string;
  agentPath: string;
  model: string;
  trigger: "manual" | "schedule" | "event";
  output: string;
  agentVersionId: string | null;
  createdAt: Date;
  startedAt: Date | null;
  deliveryEvidence: DeliveryEvidenceSnapshot | null;
};

export type OutputFacets = {
  agents: string[];
  orchestrators: string[];
  users: { id: string; name: string | null; email: string }[];
};

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const UUID_RE =
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

type Cursor = { completedAt: Date; id: string };

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(
    JSON.stringify({ completedAt: cursor.completedAt.toISOString(), id: cursor.id }),
  ).toString("base64url");
}

export function decodeOutputCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      completedAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.completedAt !== "string" || typeof parsed.id !== "string") {
      return null;
    }
    const completedAt = new Date(parsed.completedAt);
    const id = parsed.id.trim();
    if (!UUID_RE.test(id) || Number.isNaN(completedAt.getTime())) return null;
    return { completedAt, id };
  } catch {
    return null;
  }
}

type OutputRow = {
  id: string;
  workspace_id: string;
  agent_name: string;
  agent_path: string;
  model: string;
  trigger: OutputDetail["trigger"];
  output: string;
  output_preview: string;
  created_by: string;
  created_by_name: string | null;
  created_by_email: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date;
  agent_version_id: string | null;
  agent_version_label: string | null;
  orchestrator_run_id: string;
  orchestrator_name: string;
  output_delivery: AgentDelivery | null;
  delivery_evidence: DeliveryEvidenceSnapshot | null;
  delivery_status: DeliveryStatus;
};

const OUTPUT_ORCHESTRATION_CTE = `WITH RECURSIVE candidates AS (
  SELECT r.*
    FROM run r
   WHERE __CANDIDATE_WHERE__
), run_chain AS (
  SELECT c.id AS leaf_id, c.id AS run_id, c.orchestrator_run_id,
         c.agent_name AS orchestrator_name, 0 AS depth, ARRAY[c.id] AS path
    FROM candidates c
  UNION ALL
  SELECT chain.leaf_id, orchestrator.id, orchestrator.orchestrator_run_id,
         orchestrator.agent_name, chain.depth + 1,
         chain.path || orchestrator.id
    FROM run_chain chain
    JOIN run orchestrator
      ON orchestrator.id = chain.orchestrator_run_id
     AND orchestrator.workspace_id = __WORKSPACE_PARAM__
   WHERE chain.depth < 50 AND NOT orchestrator.id = ANY(chain.path)
), orchestrators AS (
  SELECT DISTINCT ON (leaf_id)
         leaf_id, run_id AS orchestrator_run_id, orchestrator_name
    FROM run_chain
   ORDER BY leaf_id, depth DESC
)`;

function mapListRow(row: OutputRow): OutputListItem {
  return {
    runId: row.id,
    agentName: row.agent_name,
    orchestratorRunId: row.orchestrator_run_id,
    orchestratorName: row.orchestrator_name,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdByEmail: row.created_by_email,
    completedAt: row.completed_at,
    outputPreview: outputExcerpt(row.output_preview),
    agentVersionLabel: row.agent_version_label,
    delivery: row.output_delivery,
    deliveryStatus: row.delivery_status,
  };
}

export function outputExcerpt(markdown: string): string {
  return markdown
    .replace(/^\s*```[^\n]*$/gm, "")
    .replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(`+|\*\*|__|~~)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

export async function listOutputsForWorkspace(
  workspaceId: string,
  filters: OutputListFilters = {},
  limit: number = DEFAULT_LIMIT,
): Promise<OutputPage> {
  const cappedLimit = Math.min(Math.max(1, limit), MAX_LIMIT);
  const params: unknown[] = [workspaceId];
  const candidateWhere = [
    "r.workspace_id = $1",
    "r.status = 'succeeded'",
    "BTRIM(r.output) <> ''",
    "r.completed_at IS NOT NULL",
  ];

  if (filters.search) {
    params.push(filters.search);
    candidateWhere.push(
      `r.output_search @@ websearch_to_tsquery('english'::regconfig, $${params.length})`,
    );
  }
  if (filters.agentName) {
    params.push(filters.agentName);
    candidateWhere.push(`r.agent_name = $${params.length}`);
  }
  if (filters.createdBy) {
    params.push(filters.createdBy);
    candidateWhere.push(`r.created_by = $${params.length}`);
  }
  if (filters.completedFrom) {
    params.push(filters.completedFrom);
    candidateWhere.push(`r.completed_at >= $${params.length}`);
  }
  if (filters.completedBefore) {
    params.push(filters.completedBefore);
    candidateWhere.push(`r.completed_at < $${params.length}`);
  }
  if (filters.deliveryStatus) {
    params.push(filters.deliveryStatus);
    candidateWhere.push(`r.delivery_status = $${params.length}`);
  }
  const cursor = decodeOutputCursor(filters.cursor);
  if (cursor) {
    params.push(cursor.completedAt, cursor.id);
    candidateWhere.push(
      `(r.completed_at, r.id) < ($${params.length - 1}, $${params.length}::uuid)`,
    );
  }

  const finalWhere: string[] = [];
  if (filters.orchestratorName) {
    params.push(filters.orchestratorName);
    finalWhere.push(`orchestrators.orchestrator_name = $${params.length}`);
  }
  params.push(cappedLimit + 1);

  const cte = OUTPUT_ORCHESTRATION_CTE.replace(
    "__CANDIDATE_WHERE__",
    candidateWhere.join(" AND "),
  ).replace("__WORKSPACE_PARAM__", "$1");
  const { rows } = await db.query<OutputRow>(
    `${cte}
     SELECT c.id, c.workspace_id, c.agent_name, c.agent_path, c.model,
            c.trigger, c.output, LEFT(c.output, 1200) AS output_preview,
            c.created_by, actor.name AS created_by_name,
            actor.email AS created_by_email, c.created_at, c.started_at,
            c.completed_at, c.agent_version_id, c.agent_version_label,
            orchestrators.orchestrator_run_id,
            orchestrators.orchestrator_name, c.output_delivery,
            c.delivery_evidence, c.delivery_status
       FROM candidates c
       JOIN orchestrators ON orchestrators.leaf_id = c.id
       LEFT JOIN "user" actor ON actor.id = c.created_by
      ${finalWhere.length ? `WHERE ${finalWhere.join(" AND ")}` : ""}
      ORDER BY c.completed_at DESC, c.id DESC
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > cappedLimit;
  const visible = hasMore ? rows.slice(0, cappedLimit) : rows;
  const last = visible.at(-1);
  return {
    items: visible.map(mapListRow),
    nextCursor:
      hasMore && last
        ? encodeCursor({ completedAt: last.completed_at, id: last.id })
        : null,
  };
}

export async function getOutputForWorkspace(
  workspaceId: string,
  runId: string,
): Promise<OutputDetail | null> {
  const candidateWhere = [
    "r.workspace_id = $1",
    "r.id = $2",
    "r.status = 'succeeded'",
    "BTRIM(r.output) <> ''",
    "r.completed_at IS NOT NULL",
  ].join(" AND ");
  const cte = OUTPUT_ORCHESTRATION_CTE.replace(
    "__CANDIDATE_WHERE__",
    candidateWhere,
  ).replace("__WORKSPACE_PARAM__", "$1");
  const { rows } = await db.query<OutputRow>(
    `${cte}
     SELECT c.id, c.workspace_id, c.agent_name, c.agent_path, c.model,
            c.trigger, c.output, LEFT(c.output, 1200) AS output_preview,
            c.created_by, actor.name AS created_by_name,
            actor.email AS created_by_email, c.created_at, c.started_at,
            c.completed_at, c.agent_version_id, c.agent_version_label,
            orchestrators.orchestrator_run_id,
            orchestrators.orchestrator_name, c.output_delivery,
            c.delivery_evidence, c.delivery_status
       FROM candidates c
       JOIN orchestrators ON orchestrators.leaf_id = c.id
       LEFT JOIN "user" actor ON actor.id = c.created_by`,
    [workspaceId, runId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    ...mapListRow(row),
    workspaceId: row.workspace_id,
    agentPath: row.agent_path,
    model: row.model,
    trigger: row.trigger,
    output: row.output,
    agentVersionId: row.agent_version_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    deliveryEvidence: row.delivery_evidence,
  };
}

export async function listOutputFacets(workspaceId: string): Promise<OutputFacets> {
  const eligible = "workspace_id = $1 AND status = 'succeeded' AND BTRIM(output) <> ''";
  const [agents, users, orchestrators] = await Promise.all([
    db.query<{ agent_name: string }>(
      `SELECT DISTINCT agent_name FROM run WHERE ${eligible} ORDER BY agent_name`,
      [workspaceId],
    ),
    db.query<{ id: string; name: string | null; email: string }>(
      `SELECT DISTINCT actor.id, actor.name, actor.email
         FROM run r
         JOIN "user" actor ON actor.id = r.created_by
        WHERE r.workspace_id = $1
          AND r.status = 'succeeded'
          AND BTRIM(r.output) <> ''
        ORDER BY actor.name NULLS LAST, actor.email`,
      [workspaceId],
    ),
    db.query<{ orchestrator_name: string }>(
      `WITH RECURSIVE output_runs AS (
         SELECT id, orchestrator_run_id, agent_name
           FROM run
          WHERE ${eligible}
       ), run_chain AS (
         SELECT id AS leaf_id, id, orchestrator_run_id, agent_name, 0 AS depth,
                ARRAY[id] AS path
           FROM output_runs
         UNION ALL
         SELECT chain.leaf_id, orchestrator.id,
                orchestrator.orchestrator_run_id, orchestrator.agent_name,
                chain.depth + 1, chain.path || orchestrator.id
           FROM run_chain chain
           JOIN run orchestrator
             ON orchestrator.id = chain.orchestrator_run_id
            AND orchestrator.workspace_id = $1
          WHERE chain.depth < 50 AND NOT orchestrator.id = ANY(chain.path)
       ), orchestrators AS (
         SELECT DISTINCT ON (leaf_id)
                leaf_id, agent_name AS orchestrator_name
           FROM run_chain
          ORDER BY leaf_id, depth DESC
       )
       SELECT DISTINCT orchestrator_name
         FROM orchestrators
        ORDER BY orchestrator_name`,
      [workspaceId],
    ),
  ]);
  return {
    agents: agents.rows.map((row) => row.agent_name),
    orchestrators: orchestrators.rows.map((row) => row.orchestrator_name),
    users: users.rows,
  };
}
