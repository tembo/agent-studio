import "server-only";

import { db } from "@/lib/db";

// CRUD for the `improvement` table. One row per "Improve the Agent"
// submission: we create the row before calling Tembo so the
// improvement id is available to embed in the prompt (and therefore
// in the PR body), then patch the row with Tembo's task id + html
// url once the create-task call returns. PR detection runs later
// (on /improvements visits) and patches pr_url / pr_state / status.

// "committed" is the direct-commit (YOLO) terminal: the change went straight
// to the default branch instead of through a PR. It's a "landed" state, the
// commit analogue of "merged".
export type ImprovementStatus =
  | "submitted"
  | "pr_opened"
  | "merged"
  | "closed"
  | "committed";
export type ImprovementKind = "edit" | "create";

// Where the improvement originated. 'chat' = a person submitted it; 'learning'
// = the batched Tasks Inbox learning pass opened it. Free-form (validated here,
// not a DB CHECK).
export type ImprovementSource = "chat" | "learning";

// How an improvement's change is delivered. Snapshotted at submit time from the
// workspace's commit mode so the reconcile scan + UI stay correct even if the
// workspace later toggles the mode.
import type { CommitMode } from "@/lib/commit-mode-constants";
export type ImprovementDelivery = CommitMode;

export interface Improvement {
  id: string;
  workspaceId: string;
  // Null when the improvement came from a chat-to-edit thread (not
  // anchored to a specific run) or from chat-to-create.
  runId: string | null;
  agentName: string;
  agentPath: string;
  improvementText: string;
  // "edit" = chat-to-edit / run-improve on an existing agent.
  // "create" = chat-to-create — the agent file doesn't exist yet
  // and lands on PR merge.
  kind: ImprovementKind;
  source: ImprovementSource;
  temboTaskId: string | null;
  temboTaskHtmlUrl: string | null;
  prUrl: string | null;
  prNumber: number | null;
  prState: string | null;
  status: ImprovementStatus;
  delivery: ImprovementDelivery;
  commitSha: string | null;
  commitUrl: string | null;
  createdBy: string;
  createdByName: string | null;
  createdByEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
}

type Row = {
  id: string;
  workspace_id: string;
  run_id: string | null;
  agent_name: string;
  agent_path: string;
  improvement_text: string;
  kind: ImprovementKind;
  source: ImprovementSource;
  tembo_task_id: string | null;
  tembo_task_html_url: string | null;
  pr_url: string | null;
  pr_number: number | null;
  pr_state: string | null;
  status: ImprovementStatus;
  delivery: ImprovementDelivery;
  commit_sha: string | null;
  commit_url: string | null;
  created_by: string;
  created_by_name: string | null;
  created_by_email: string | null;
  created_at: Date;
  updated_at: Date;
};

function rowToImprovement(r: Row): Improvement {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    runId: r.run_id,
    agentName: r.agent_name,
    agentPath: r.agent_path,
    improvementText: r.improvement_text,
    kind: r.kind,
    source: r.source,
    temboTaskId: r.tembo_task_id,
    temboTaskHtmlUrl: r.tembo_task_html_url,
    prUrl: r.pr_url,
    prNumber: r.pr_number,
    prState: r.pr_state,
    status: r.status,
    delivery: r.delivery,
    commitSha: r.commit_sha,
    commitUrl: r.commit_url,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    createdByEmail: r.created_by_email,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// SELECT projection with a LEFT JOIN against "user" so the row
// includes the submitter's display name + email. LEFT JOIN keeps
// the row visible if the user has been deleted.
const COLUMNS = `
  i.id, i.workspace_id, i.run_id, i.agent_name, i.agent_path, i.improvement_text,
  i.kind, i.source, i.tembo_task_id, i.tembo_task_html_url, i.pr_url, i.pr_number, i.pr_state,
  i.status, i.delivery, i.commit_sha, i.commit_url, i.created_by,
  u.name AS created_by_name, u.email AS created_by_email,
  i.created_at, i.updated_at
`;
const FROM_JOIN = `FROM improvement i LEFT JOIN "user" u ON u.id = i.created_by`;

export async function createImprovement(input: {
  workspaceId: string;
  runId: string | null;
  agentName: string;
  agentPath: string;
  improvementText: string;
  // Defaults to "edit" so legacy callers (chat-to-edit, run-improve)
  // don't have to pass it explicitly.
  kind?: ImprovementKind;
  // How this change will be delivered. Defaults to PR so callers that
  // predate YOLO keep the prior behavior.
  delivery?: ImprovementDelivery;
  // Where it came from. Defaults to 'chat' (a person) so legacy callers keep
  // their meaning; the learning pass passes 'learning'.
  source?: ImprovementSource;
  userId: string;
}): Promise<Improvement> {
  // INSERT into a CTE so we can re-SELECT with the user join applied,
  // matching the projection used everywhere else that returns Improvement.
  const res = await db.query<Row>(
    `WITH inserted AS (
       INSERT INTO improvement (workspace_id, run_id, agent_name, agent_path, improvement_text, kind, source, delivery, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *
     )
     SELECT ${COLUMNS}
     FROM inserted i
     LEFT JOIN "user" u ON u.id = i.created_by`,
    [
      input.workspaceId,
      input.runId,
      input.agentName,
      input.agentPath,
      input.improvementText,
      input.kind ?? "edit",
      input.source ?? "chat",
      input.delivery ?? "pull_request",
      input.userId,
    ],
  );
  return rowToImprovement(res.rows[0]);
}

// Pending chat-to-create rows for the Agents grid: kind='create' and
// status not yet terminal. Used to render in-flight new-agent
// requests as cards alongside live agents.
export async function listPendingCreatesForWorkspace(
  workspaceId: string,
): Promise<Improvement[]> {
  // A direct-commit create is optimistically 'committed' the moment CAP
  // accepts it, but the agent file isn't on the branch until the commit
  // actually lands. Keep its card until the scan attaches the commit URL, so
  // there's no gap where neither the card nor the real agent shows.
  const res = await db.query<Row>(
    `SELECT ${COLUMNS}
     ${FROM_JOIN}
     WHERE i.workspace_id = $1
       AND i.kind = 'create'
       AND (
         i.status IN ('submitted', 'pr_opened')
         OR (i.delivery = 'direct' AND i.status = 'committed' AND i.commit_url IS NULL)
       )
     ORDER BY i.created_at DESC`,
    [workspaceId],
  );
  return res.rows.map(rowToImprovement);
}

export async function isAgentCreatePending(
  workspaceId: string,
  agentName: string,
): Promise<boolean> {
  const res = await db.query<{ pending: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM improvement
        WHERE workspace_id = $1
          AND agent_name = $2
          AND kind = 'create'
          AND (
            status IN ('submitted', 'pr_opened')
            OR (delivery = 'direct' AND status = 'committed' AND commit_url IS NULL)
          )
     ) AS pending`,
    [workspaceId, agentName],
  );
  return res.rows[0]?.pending ?? false;
}

/**
 * Dismiss a pending agent-create from the inventory: mark the create
 * improvement `closed` so it drops out of listPendingCreatesForWorkspace.
 * Scoped to the workspace and to non-terminal create rows so it can't
 * touch edits or already-resolved rows. Returns whether a row changed.
 * Does NOT touch the GitHub PR (if one is open) — that stays on GitHub
 * for the user to merge or close there.
 */
export async function dismissPendingCreate(
  workspaceId: string,
  improvementId: string,
): Promise<boolean> {
  // Match the SAME predicate listPendingCreatesForWorkspace uses to render a
  // card — including the direct-commit (YOLO) case that's optimistically
  // 'committed' but has no commit_url yet. Otherwise a direct-commit ghost card
  // shows as Pending but Dismiss matches 0 rows and silently does nothing.
  const res = await db.query(
    `UPDATE improvement
        SET status = 'closed', updated_at = now()
      WHERE id = $1
        AND workspace_id = $2
        AND kind = 'create'
        AND (
          status IN ('submitted', 'pr_opened')
          OR (delivery = 'direct' AND status = 'committed' AND commit_url IS NULL)
        )`,
    [improvementId, workspaceId],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Presence-based reconcile: close out pending agent-creates whose agent has
 * already landed in the repo, independent of commit-message markers.
 *
 * The marker-based commit scan (improvement-scan Path 3) can only attach a
 * commit_url when the landed commit's message carries the per-improvement
 * marker — which isn't guaranteed (CAP may reword/squash, or the file was
 * committed outside that flow). When it can't, a direct-commit create sits in
 * 'committed' with a null commit_url forever and shows as a ghost Pending card.
 *
 * This closes that gap by the more reliable signal — the agent file actually
 * exists. A create is "landed" when a live agent now exists at its path
 * (covers files that don't parse / whose name diverged) or under its name.
 * Such rows are marked 'merged' (terminal success), distinct from a user
 * Dismiss ('closed'). Only the workspace's own non-terminal create rows are
 * touched. Returns the ids closed so the caller can drop them from the
 * already-fetched pending list without a re-query.
 *
 * Pass live paths/names only when the repo was actually read — an empty repo
 * listing (e.g. GitHub down) must NOT be read as "nothing landed".
 */
export async function reconcileLandedCreates(
  workspaceId: string,
  livePaths: string[],
  liveNames: string[],
): Promise<string[]> {
  if (livePaths.length === 0 && liveNames.length === 0) return [];
  const res = await db.query<{ id: string }>(
    `UPDATE improvement
        SET status = 'merged', updated_at = now()
      WHERE workspace_id = $1
        AND kind = 'create'
        AND (
          status IN ('submitted', 'pr_opened')
          OR (delivery = 'direct' AND status = 'committed' AND commit_url IS NULL)
        )
        AND (agent_path = ANY($2::text[]) OR agent_name = ANY($3::text[]))
      RETURNING id`,
    [workspaceId, livePaths, liveNames],
  );
  return res.rows.map((r) => r.id);
}

export async function setImprovementTask(input: {
  id: string;
  temboTaskId: string | null;
  temboTaskHtmlUrl: string | null;
}): Promise<void> {
  await db.query(
    `UPDATE improvement
     SET tembo_task_id = $2, tembo_task_html_url = $3, updated_at = NOW()
     WHERE id = $1`,
    [input.id, input.temboTaskId, input.temboTaskHtmlUrl],
  );
}

// Direct-commit (YOLO) success: CAP accepted the task and will commit straight
// to the default branch. We optimistically mark the improvement landed
// ('committed') with the Tembo task link; the reconcile scan later attaches the
// actual commit URL once the marker commit appears on the branch.
export async function setImprovementCommitted(input: {
  id: string;
  temboTaskId: string | null;
  temboTaskHtmlUrl: string | null;
}): Promise<void> {
  await db.query(
    `UPDATE improvement
     SET tembo_task_id = $2, tembo_task_html_url = $3,
         status = 'committed', updated_at = NOW()
     WHERE id = $1`,
    [input.id, input.temboTaskId, input.temboTaskHtmlUrl],
  );
}

// Attach the resolved direct commit (sha + html url) found by the scan. Keeps
// status 'committed' — this only fills in the link.
export async function setImprovementCommit(input: {
  id: string;
  commitSha: string;
  commitUrl: string;
}): Promise<void> {
  await db.query(
    `UPDATE improvement
     SET commit_sha = $2, commit_url = $3, status = 'committed', updated_at = NOW()
     WHERE id = $1`,
    [input.id, input.commitSha, input.commitUrl],
  );
}

export async function setImprovementPr(input: {
  id: string;
  prUrl: string | null;
  prNumber: number | null;
  prState: string | null;
  status: ImprovementStatus;
}): Promise<void> {
  await db.query(
    `UPDATE improvement
     SET pr_url = $2, pr_number = $3, pr_state = $4, status = $5, updated_at = NOW()
     WHERE id = $1`,
    [input.id, input.prUrl, input.prNumber, input.prState, input.status],
  );
}

// All improvements for a workspace whose status is not yet terminal
// (i.e. still 'submitted' or 'pr_opened'). Used to bound the scan
// the dashboard / improvements page run on every visit so a merged-
// but-not-yet-detected PR shows up regardless of how old the
// improvement row is. Terminal rows ('merged' / 'closed') never need
// rechecking.
export async function listOpenImprovements(
  workspaceId: string,
): Promise<Improvement[]> {
  // Plus direct-commit improvements that landed (status 'committed') but whose
  // commit URL we haven't resolved yet — the scan still needs to find their
  // marker commit and attach it.
  const res = await db.query<Row>(
    `SELECT ${COLUMNS}
     ${FROM_JOIN}
     WHERE i.workspace_id = $1
       AND (
         i.status IN ('submitted', 'pr_opened')
         OR (i.delivery = 'direct' AND i.status = 'committed' AND i.commit_url IS NULL)
       )
     ORDER BY i.created_at DESC`,
    [workspaceId],
  );
  return res.rows.map(rowToImprovement);
}

export async function listImprovements(
  workspaceId: string,
  limit = 100,
): Promise<Improvement[]> {
  const res = await db.query<Row>(
    `SELECT ${COLUMNS}
     ${FROM_JOIN}
     WHERE i.workspace_id = $1
     ORDER BY i.created_at DESC
     LIMIT $2`,
    [workspaceId, limit],
  );
  return res.rows.map(rowToImprovement);
}

export async function listImprovementsForAgent(
  workspaceId: string,
  agentName: string,
  limit = 100,
): Promise<Improvement[]> {
  const res = await db.query<Row>(
    `SELECT ${COLUMNS}
     ${FROM_JOIN}
     WHERE i.workspace_id = $1 AND i.agent_name = $2
     ORDER BY i.created_at DESC
     LIMIT $3`,
    [workspaceId, agentName, limit],
  );
  return res.rows.toReversed().map(rowToImprovement);
}

export async function listImprovementsForRun(
  runId: string,
): Promise<Improvement[]> {
  const res = await db.query<Row>(
    `SELECT ${COLUMNS}
     ${FROM_JOIN}
     WHERE i.run_id = $1
     ORDER BY i.created_at DESC`,
    [runId],
  );
  return res.rows.map(rowToImprovement);
}

export async function getImprovement(id: string): Promise<Improvement | null> {
  const res = await db.query<Row>(
    `SELECT ${COLUMNS} ${FROM_JOIN} WHERE i.id = $1`,
    [id],
  );
  return res.rows[0] ? rowToImprovement(res.rows[0]) : null;
}

export interface ImprovementCounts {
  submitted: number;
  pr_opened: number;
  merged: number;
  closed: number;
  committed: number;
  total: number;
}

export async function countImprovementsSince(
  workspaceId: string,
  since: Date,
): Promise<ImprovementCounts> {
  const res = await db.query<{ status: ImprovementStatus; n: string }>(
    `SELECT status, COUNT(*)::text AS n
     FROM improvement
     WHERE workspace_id = $1 AND created_at >= $2
     GROUP BY status`,
    [workspaceId, since],
  );
  const counts: ImprovementCounts = {
    submitted: 0,
    pr_opened: 0,
    merged: 0,
    closed: 0,
    committed: 0,
    total: 0,
  };
  for (const row of res.rows) {
    const n = Number(row.n);
    counts[row.status] = n;
    counts.total += n;
  }
  return counts;
}

// Marker the PR body should contain. Tembo is asked (via the
// prompt) to include this line so we can correlate the merged PR
// back to the improvement row that triggered it. The token is kept
// as TAS-Feedback-ID for backwards compatibility with PRs already
// opened against earlier database rows — the wire format is frozen
// even though the database column was renamed.
export const IMPROVEMENT_MARKER_PREFIX = "TAS-Feedback-ID:";

export function improvementMarker(id: string): string {
  return `${IMPROVEMENT_MARKER_PREFIX} ${id}`;
}
