import "server-only";

import { db } from "@/lib/db";
import type { ResolveDispatchError } from "@/lib/workspace-agents";

export type AutomationKind = "schedule" | "trigger" | "webhook";
export type AutomationDispatchOutcome = "failed" | "resolved";

export type AutomationDispatchFailure = {
  code: string;
  summary: string;
  recommendation: string;
  diagnosticDetail?: string;
};

export type AutomationDispatchEvent = {
  id: string;
  workspaceId: string;
  automationKind: AutomationKind;
  automationId: string;
  automationName: string;
  agentName: string;
  outcome: AutomationDispatchOutcome;
  attempt: number;
  failureCode: string | null;
  failureSummary: string | null;
  failureRecommendation: string | null;
  diagnosticDetail: string | null;
  runId: string | null;
  occurredAt: Date;
  resolvedAt: Date | null;
};

type EventRow = {
  id: string;
  workspace_id: string;
  automation_kind: AutomationKind;
  automation_id: string;
  automation_name: string;
  agent_name: string;
  outcome: AutomationDispatchOutcome;
  attempt: number;
  failure_code: string | null;
  failure_summary: string | null;
  failure_recommendation: string | null;
  diagnostic_detail: string | null;
  run_id: string | null;
  occurred_at: Date;
  resolved_at: Date | null;
};

function eventColumns(diagnosticExpression: string): string {
  return `
    id, workspace_id, automation_kind, automation_id, automation_name,
    agent_name, outcome, attempt, failure_code, failure_summary,
    failure_recommendation, ${diagnosticExpression} AS diagnostic_detail,
    run_id, occurred_at, resolved_at
  `;
}

const SOURCE = {
  schedule: { table: "automation", nameColumn: "name" },
  trigger: { table: "workspace_trigger", nameColumn: "trigger_type" },
  webhook: { table: "workspace_webhook", nameColumn: "name" },
} as const satisfies Record<
  AutomationKind,
  { table: string; nameColumn: string }
>;

function rowToEvent(row: EventRow): AutomationDispatchEvent {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    automationKind: row.automation_kind,
    automationId: row.automation_id,
    automationName: row.automation_name,
    agentName: row.agent_name,
    outcome: row.outcome,
    attempt: row.attempt,
    failureCode: row.failure_code,
    failureSummary: row.failure_summary,
    failureRecommendation: row.failure_recommendation,
    diagnosticDetail: row.diagnostic_detail,
    runId: row.run_id,
    occurredAt: row.occurred_at,
    resolvedAt: row.resolved_at,
  };
}

function boundedFailure(
  failure: AutomationDispatchFailure,
): AutomationDispatchFailure {
  return {
    code: failure.code.slice(0, 100),
    summary: failure.summary.slice(0, 500),
    recommendation: failure.recommendation.slice(0, 1000),
    diagnosticDetail: failure.diagnosticDetail?.slice(0, 4000),
  };
}

export function agentResolutionFailure(
  error: ResolveDispatchError,
): AutomationDispatchFailure {
  switch (error.kind) {
    case "not-found":
      return {
        code: "agent_not_found",
        summary: error.message,
        recommendation:
          "Restore the agent or update this automation to use an available agent.",
        diagnosticDetail: "Agent dispatch resolution returned not-found.",
      };
    case "invalid":
      return {
        code: "agent_invalid",
        summary: "The agent definition could not be loaded.",
        recommendation:
          "Review the agent definition, fix its validation errors, and try again.",
        diagnosticDetail: "Agent dispatch resolution returned invalid.",
      };
    case "no-model":
      return {
        code: "agent_no_model",
        summary: error.message,
        recommendation:
          "Add a model to the agent definition, promote it if needed, and try again.",
        diagnosticDetail: "Agent dispatch resolution returned no-model.",
      };
    case "source-unavailable":
      return {
        code: "agent_source_unavailable",
        summary: error.message,
        recommendation: error.retryable
          ? "The automation will retry automatically. Check the repository connection if the error continues."
          : "Check the workspace repository connection and try again.",
        diagnosticDetail: `Agent source error: ${error.sourceError}; retryable=${String(error.retryable)}.`,
      };
  }
}

export function runApiFailure(status: number): AutomationDispatchFailure {
  return {
    code: "run_api_error",
    summary: "The run could not be queued.",
    recommendation:
      "Try again. If the error continues, ask a workspace admin to investigate.",
    diagnosticDetail: `Run API returned HTTP ${status}.`,
  };
}

export function runApiRequestFailure(error: unknown): AutomationDispatchFailure {
  const name = error instanceof Error ? error.name : "UnknownError";
  return {
    code: "run_api_unavailable",
    summary: "The run service could not be reached.",
    recommendation:
      "The automation will try again at its next firing. Ask a workspace admin to investigate if the error continues.",
    diagnosticDetail: `Run API request failed with ${name}.`,
  };
}

export function automationServiceConfigurationFailure(): AutomationDispatchFailure {
  return {
    code: "automation_service_configuration",
    summary: "The automation service is not configured.",
    recommendation: "Ask a workspace admin to check the deployment configuration.",
    diagnosticDetail: "INTERNAL_API_TOKEN is not configured for the web service.",
  };
}

export function unexpectedDispatchFailure(error: unknown): AutomationDispatchFailure {
  const name = error instanceof Error ? error.name : "UnknownError";
  return {
    code: "automation_dispatch_error",
    summary: "The automation failed before a run could be queued.",
    recommendation:
      "Try again. If the error continues, ask a workspace admin to investigate.",
    diagnosticDetail: `Unexpected scheduler failure: ${name}.`,
  };
}

export const ORPHANED_AUTOMATION_FAILURE: AutomationDispatchFailure = {
  code: "automation_owner_removed",
  summary: "Paused because the Run as owner is no longer a workspace member.",
  recommendation: "Assign a current workspace member as the Run as owner.",
};

export async function recordAutomationFailure(input: {
  kind: AutomationKind;
  id: string;
  failure: AutomationDispatchFailure;
  occurredAt?: Date;
  advanceFiringFloor?: boolean;
}): Promise<void> {
  const source = SOURCE[input.kind];
  const occurredAt = input.occurredAt ?? new Date();
  const failure = boundedFailure(input.failure);
  await db.query(
    `WITH source AS (
       SELECT id, workspace_id, ${source.nameColumn}::text AS automation_name,
              agent_name
         FROM ${source.table}
        WHERE id = $1
        FOR UPDATE
     ), previous AS (
       SELECT e.outcome, e.attempt
         FROM automation_dispatch_event e
         JOIN source s
           ON e.workspace_id = s.workspace_id
          AND e.automation_kind = $2
          AND e.automation_id = s.id
        ORDER BY e.occurred_at DESC, e.id DESC
        LIMIT 1
     ), inserted AS (
       INSERT INTO automation_dispatch_event
         (workspace_id, automation_kind, automation_id, automation_name,
          agent_name, outcome, attempt, failure_code, failure_summary,
          failure_recommendation, diagnostic_detail, occurred_at)
       SELECT s.workspace_id, $2, s.id, s.automation_name, s.agent_name,
              'failed',
              CASE WHEN p.outcome = 'failed' THEN p.attempt + 1 ELSE 1 END,
              $4, $5, $6, $7, $3
         FROM source s
         LEFT JOIN previous p ON TRUE
       RETURNING id
     )
     UPDATE ${source.table} target
        SET last_fired_at = CASE WHEN $8 THEN $3 ELSE target.last_fired_at END,
            last_fire_error = $5,
            last_fire_event_id = inserted.id,
            updated_at = NOW()
       FROM inserted
      WHERE target.id = $1`,
    [
      input.id,
      input.kind,
      occurredAt,
      failure.code,
      failure.summary,
      failure.recommendation,
      failure.diagnosticDetail ?? null,
      input.advanceFiringFloor ?? true,
    ],
  );
}

export async function recordAutomationSuccess(input: {
  kind: AutomationKind;
  id: string;
  runId: string | null;
  occurredAt?: Date;
}): Promise<void> {
  const source = SOURCE[input.kind];
  const occurredAt = input.occurredAt ?? new Date();
  await db.query(
    `WITH source AS (
       SELECT id, workspace_id, ${source.nameColumn}::text AS automation_name,
              agent_name, last_fire_error
         FROM ${source.table}
        WHERE id = $1
        FOR UPDATE
     ), previous AS (
       SELECT e.outcome, e.attempt
         FROM automation_dispatch_event e
         JOIN source s
           ON e.workspace_id = s.workspace_id
          AND e.automation_kind = $2
          AND e.automation_id = s.id
        ORDER BY e.occurred_at DESC, e.id DESC
        LIMIT 1
     ), resolved_failures AS (
       UPDATE automation_dispatch_event e
          SET resolved_at = $3
         FROM source s
        WHERE e.workspace_id = s.workspace_id
          AND e.automation_kind = $2
          AND e.automation_id = s.id
          AND e.outcome = 'failed'
          AND e.resolved_at IS NULL
     ), recovery AS (
       INSERT INTO automation_dispatch_event
         (workspace_id, automation_kind, automation_id, automation_name,
          agent_name, outcome, attempt, run_id, occurred_at)
       SELECT s.workspace_id, $2, s.id, s.automation_name, s.agent_name,
              'resolved',
              CASE WHEN p.outcome = 'failed' THEN p.attempt + 1 ELSE 1 END,
              $4, $3
         FROM source s
         LEFT JOIN previous p ON TRUE
        WHERE s.last_fire_error IS NOT NULL
       RETURNING id
     )
     UPDATE ${source.table} target
        SET last_fired_at = $3,
            last_fire_error = NULL,
            last_fire_event_id = NULL,
            updated_at = NOW()
       FROM source
      WHERE target.id = source.id`,
    [input.id, input.kind, occurredAt, input.runId],
  );
}

export async function pauseAutomationsWithMissingOwners(): Promise<number> {
  const failure = boundedFailure(ORPHANED_AUTOMATION_FAILURE);
  const result = await db.query<{ id: string }>(
    `WITH orphaned AS (
       SELECT a.id, a.workspace_id, a.name, a.agent_name
         FROM automation a
        WHERE a.enabled = TRUE
          AND NOT EXISTS (
            SELECT 1
              FROM workspace_member m
             WHERE m.workspace_id = a.workspace_id
               AND m.user_id = a.owner_user_id
          )
        FOR UPDATE
     ), inserted AS (
       INSERT INTO automation_dispatch_event
         (workspace_id, automation_kind, automation_id, automation_name,
          agent_name, outcome, attempt, failure_code, failure_summary,
          failure_recommendation, diagnostic_detail)
       SELECT o.workspace_id, 'schedule', o.id, o.name, o.agent_name,
              'failed',
              COALESCE((
                SELECT CASE WHEN e.outcome = 'failed' THEN e.attempt + 1 ELSE 1 END
                  FROM automation_dispatch_event e
                 WHERE e.workspace_id = o.workspace_id
                   AND e.automation_kind = 'schedule'
                   AND e.automation_id = o.id
                 ORDER BY e.occurred_at DESC, e.id DESC
                 LIMIT 1
              ), 1),
              $1, $2, $3, $4
         FROM orphaned o
       RETURNING id, automation_id
     )
     UPDATE automation a
        SET enabled = FALSE,
            last_fire_error = $2,
            last_fire_event_id = inserted.id,
            updated_at = NOW()
       FROM inserted
      WHERE a.id = inserted.automation_id
     RETURNING a.id`,
    [
      failure.code,
      failure.summary,
      failure.recommendation,
      failure.diagnosticDetail ?? null,
    ],
  );
  return result.rows.length;
}

export async function listAutomationDispatchEvents(
  workspaceId: string,
  limit = 100,
): Promise<AutomationDispatchEvent[]> {
  const result = await db.query<EventRow>(
    `SELECT ${eventColumns("NULL::text")}
       FROM automation_dispatch_event
      WHERE workspace_id = $1
      ORDER BY occurred_at DESC, id DESC
      LIMIT $2`,
    [workspaceId, Math.min(Math.max(limit, 1), 200)],
  );
  return result.rows.map(rowToEvent);
}

export async function getAutomationDispatchEvent(
  workspaceId: string,
  eventId: string,
  includeDiagnostics = false,
): Promise<AutomationDispatchEvent | null> {
  const result = await db.query<EventRow>(
    `SELECT ${eventColumns("CASE WHEN $3 THEN diagnostic_detail ELSE NULL END")}
       FROM automation_dispatch_event
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, eventId, includeDiagnostics],
  );
  return result.rows[0] ? rowToEvent(result.rows[0]) : null;
}
