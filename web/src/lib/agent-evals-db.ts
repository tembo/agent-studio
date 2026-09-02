import "server-only";

import { db } from "@/lib/db";

export type EvalRunStatus =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "error";
export type EvalRunSource = "ci" | "manual" | "api";

export type EvalCaseResult = {
  name: string;
  input: string;
  passed: boolean;
  reason: string;
  output: string | null;
  runId: string | null;
};

export type AgentEvalRun = {
  id: string;
  workspaceId: string;
  agentName: string;
  agentVersionId: string | null;
  agentVersionLabel: string;
  source: EvalRunSource;
  commitSha: string | null;
  status: EvalRunStatus;
  passedCount: number;
  failedCount: number;
  errorMessage: string | null;
  caseResults: EvalCaseResult[];
  createdBy: string;
  createdAt: Date;
  finishedAt: Date | null;
};

type Row = {
  id: string;
  workspace_id: string;
  agent_name: string;
  agent_version_id: string | null;
  agent_version_label: string;
  source: EvalRunSource;
  commit_sha: string | null;
  status: EvalRunStatus;
  passed_count: number;
  failed_count: number;
  error_message: string | null;
  case_results: EvalCaseResult[] | string;
  created_by: string;
  created_at: Date;
  finished_at: Date | null;
};

const COLUMNS = [
  "id",
  "workspace_id",
  "agent_name",
  "agent_version_id",
  "agent_version_label",
  "source",
  "commit_sha",
  "status",
  "passed_count",
  "failed_count",
  "error_message",
  "case_results",
  "created_by",
  "created_at",
  "finished_at",
] as const;
const SELECT = COLUMNS.join(", ");

function rowToEvalRun(r: Row): AgentEvalRun {
  const cases =
    typeof r.case_results === "string"
      ? (JSON.parse(r.case_results) as EvalCaseResult[])
      : r.case_results;
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    agentName: r.agent_name,
    agentVersionId: r.agent_version_id,
    agentVersionLabel: r.agent_version_label,
    source: r.source,
    commitSha: r.commit_sha,
    status: r.status,
    passedCount: r.passed_count,
    failedCount: r.failed_count,
    errorMessage: r.error_message,
    caseResults: Array.isArray(cases) ? cases : [],
    createdBy: r.created_by,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

export async function insertEvalRun(input: {
  workspaceId: string;
  agentName: string;
  agentVersionId: string | null;
  agentVersionLabel: string;
  source: EvalRunSource;
  commitSha: string | null;
  createdBy: string;
}): Promise<AgentEvalRun> {
  const { rows } = await db.query<Row>(
    `INSERT INTO agent_eval_run (
       workspace_id, agent_name, agent_version_id, agent_version_label,
       source, commit_sha, created_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${SELECT}`,
    [
      input.workspaceId,
      input.agentName,
      input.agentVersionId,
      input.agentVersionLabel,
      input.source,
      input.commitSha,
      input.createdBy,
    ],
  );
  return rowToEvalRun(rows[0]);
}

export async function getEvalRun(
  workspaceId: string,
  id: string,
): Promise<AgentEvalRun | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${SELECT} FROM agent_eval_run
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id],
  );
  return rows[0] ? rowToEvalRun(rows[0]) : null;
}

export async function listEvalRuns(
  workspaceId: string,
  agentName: string,
  limit = 20,
): Promise<AgentEvalRun[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${SELECT} FROM agent_eval_run
      WHERE workspace_id = $1 AND agent_name = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [workspaceId, agentName, Math.min(Math.max(1, limit), 50)],
  );
  return rows.map(rowToEvalRun);
}

export async function getLatestEvalRun(
  workspaceId: string,
  agentName: string,
): Promise<AgentEvalRun | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${SELECT} FROM agent_eval_run
      WHERE workspace_id = $1 AND agent_name = $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [workspaceId, agentName],
  );
  return rows[0] ? rowToEvalRun(rows[0]) : null;
}

export async function markEvalRunning(id: string): Promise<void> {
  await db.query(
    `UPDATE agent_eval_run SET status = 'running' WHERE id = $1 AND status = 'queued'`,
    [id],
  );
}

export async function finishEvalRun(input: {
  id: string;
  status: "passed" | "failed" | "error";
  passedCount: number;
  failedCount: number;
  errorMessage?: string | null;
  caseResults: EvalCaseResult[];
}): Promise<void> {
  await db.query(
    `UPDATE agent_eval_run
        SET status = $2,
            passed_count = $3,
            failed_count = $4,
            error_message = $5,
            case_results = $6::jsonb,
            finished_at = now()
      WHERE id = $1`,
    [
      input.id,
      input.status,
      input.passedCount,
      input.failedCount,
      input.errorMessage ?? null,
      JSON.stringify(input.caseResults),
    ],
  );
}
