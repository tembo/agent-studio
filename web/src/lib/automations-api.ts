import "server-only";

import { db } from "@/lib/db";

// CRUD for the `automation` table. An automation is a saved
// (agent, cron) pairing that fires runs on its own — see migration
// 0015 for the table contract. v0.2 ships schedule triggers only;
// event triggers (US-0.2-08) land later.
//
// The scheduler module (./scheduler.ts) reads from this same table
// on its tick. Writes go through here so all the cron validation
// lives in one place; the scheduler can trust whatever's in the row.

export interface Automation {
  id: string;
  workspaceId: string;
  name: string;
  agentName: string;
  cron: string;
  inputMessage: string;
  enabled: boolean;
  lastFiredAt: Date | null;
  lastFireError: string | null;
  createdBy: string;
  createdByName: string | null;
  createdByEmail: string | null;
  /**
   * User whose credentials a scheduled run uses. Defaults to
   * createdBy when an automation is created; owner can be reassigned
   * via the form. Connections are per-user (migration 0022) so
   * scheduled runs need an explicit "as whom" answer.
   */
  ownerUserId: string;
  ownerUserName: string | null;
  ownerUserEmail: string | null;
  /** Run the live draft instead of the agent's stable version. */
  useDraft: boolean;
  createdAt: Date;
  updatedAt: Date;
}

type Row = {
  id: string;
  workspace_id: string;
  name: string;
  agent_name: string;
  cron: string;
  input_message: string;
  enabled: boolean;
  last_fired_at: Date | null;
  last_fire_error: string | null;
  created_by: string;
  created_by_name: string | null;
  created_by_email: string | null;
  owner_user_id: string;
  owner_user_name: string | null;
  owner_user_email: string | null;
  use_draft: boolean;
  created_at: Date;
  updated_at: Date;
};

function rowToAutomation(r: Row): Automation {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    agentName: r.agent_name,
    cron: r.cron,
    inputMessage: r.input_message,
    enabled: r.enabled,
    lastFiredAt: r.last_fired_at,
    lastFireError: r.last_fire_error,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    createdByEmail: r.created_by_email,
    ownerUserId: r.owner_user_id,
    ownerUserName: r.owner_user_name,
    ownerUserEmail: r.owner_user_email,
    useDraft: r.use_draft,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLUMNS = `
  a.id, a.workspace_id, a.name, a.agent_name, a.cron, a.input_message,
  a.enabled, a.last_fired_at, a.last_fire_error, a.created_by,
  u.name AS created_by_name, u.email AS created_by_email,
  a.owner_user_id,
  o.name AS owner_user_name, o.email AS owner_user_email,
  a.use_draft,
  a.created_at, a.updated_at
`;
const FROM_JOIN = `FROM automation a
  LEFT JOIN "user" u ON u.id = a.created_by
  LEFT JOIN "user" o ON o.id = a.owner_user_id`;

export async function createAutomation(input: {
  workspaceId: string;
  name: string;
  agentName: string;
  cron: string;
  inputMessage: string;
  enabled: boolean;
  userId: string;
  /** Owner whose credentials each scheduled run uses. Defaults to userId. */
  ownerUserId?: string;
  /** Run the live draft instead of the stable version. Defaults to false. */
  useDraft?: boolean;
}): Promise<Automation> {
  const res = await db.query<Row>(
    `WITH inserted AS (
       INSERT INTO automation
         (workspace_id, name, agent_name, cron, input_message, enabled, created_by, owner_user_id, use_draft)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *
     )
     SELECT ${COLUMNS}
     FROM inserted a
     LEFT JOIN "user" u ON u.id = a.created_by
     LEFT JOIN "user" o ON o.id = a.owner_user_id`,
    [
      input.workspaceId,
      input.name,
      input.agentName,
      input.cron,
      input.inputMessage,
      input.enabled,
      input.userId,
      input.ownerUserId ?? input.userId,
      input.useDraft ?? false,
    ],
  );
  return rowToAutomation(res.rows[0]);
}

export async function updateAutomation(input: {
  id: string;
  name: string;
  agentName: string;
  cron: string;
  inputMessage: string;
  enabled: boolean;
  ownerUserId: string;
  useDraft?: boolean;
}): Promise<Automation> {
  // Reset last_fire_error on edit so a fix to a broken cron doesn't
  // leave a stale red badge on the row. last_fired_at is intentionally
  // preserved so renaming an automation doesn't refire its window.
  const res = await db.query<Row>(
    `WITH updated AS (
       UPDATE automation
       SET name = $2, agent_name = $3, cron = $4, input_message = $5,
           enabled = $6, owner_user_id = $7, use_draft = $8,
           last_fire_error = NULL, updated_at = NOW()
       WHERE id = $1
       RETURNING *
     )
     SELECT ${COLUMNS}
     FROM updated a
     LEFT JOIN "user" u ON u.id = a.created_by
     LEFT JOIN "user" o ON o.id = a.owner_user_id`,
    [
      input.id,
      input.name,
      input.agentName,
      input.cron,
      input.inputMessage,
      input.enabled,
      input.ownerUserId,
      input.useDraft ?? false,
    ],
  );
  return rowToAutomation(res.rows[0]);
}

export async function deleteAutomation(id: string): Promise<void> {
  await db.query(`DELETE FROM automation WHERE id = $1`, [id]);
}

export async function setAutomationFired(input: {
  id: string;
  firedAt: Date;
}): Promise<void> {
  await db.query(
    `UPDATE automation
     SET last_fired_at = $2, last_fire_error = NULL, updated_at = NOW()
     WHERE id = $1`,
    [input.id, input.firedAt],
  );
}

// Skip path: the scheduler decided not to fire this window (bad
// cron, missing agent, etc). We advance last_fired_at so we don't
// churn the DB every tick, AND record the error so the UI can show
// it. Distinct from setAutomationFired, which intentionally clears
// the error column on a successful fire.
export async function setAutomationSkipped(input: {
  id: string;
  firedAt: Date;
  error: string;
}): Promise<void> {
  await db.query(
    `UPDATE automation
     SET last_fired_at = $2, last_fire_error = $3, updated_at = NOW()
     WHERE id = $1`,
    [input.id, input.firedAt, input.error.slice(0, 1000)],
  );
}

// Transient source failures stay due so the scheduler can catch up after its
// bounded backoff. Persist the error for operators without moving the firing
// floor; a successful retry clears it through setAutomationFired.
export async function setAutomationRetrying(input: {
  id: string;
  error: string;
}): Promise<void> {
  await db.query(
    `UPDATE automation
     SET last_fire_error = $2, updated_at = NOW()
     WHERE id = $1`,
    [input.id, input.error.slice(0, 1000)],
  );
}

export async function getAutomation(id: string): Promise<Automation | null> {
  const res = await db.query<Row>(
    `SELECT ${COLUMNS} ${FROM_JOIN} WHERE a.id = $1`,
    [id],
  );
  return res.rows[0] ? rowToAutomation(res.rows[0]) : null;
}

export async function listAutomations(
  workspaceId: string,
): Promise<Automation[]> {
  const res = await db.query<Row>(
    `SELECT ${COLUMNS}
     ${FROM_JOIN}
     WHERE a.workspace_id = $1
     ORDER BY a.created_at DESC`,
    [workspaceId],
  );
  return res.rows.map(rowToAutomation);
}

export async function listAutomationsForAgent(
  workspaceId: string,
  agentName: string,
): Promise<Automation[]> {
  const res = await db.query<Row>(
    `SELECT ${COLUMNS}
     ${FROM_JOIN}
     WHERE a.workspace_id = $1 AND a.agent_name = $2
     ORDER BY a.created_at DESC`,
    [workspaceId, agentName],
  );
  return res.rows.map(rowToAutomation);
}

export async function listErroredEnabledAutomations(
  workspaceId: string,
  limit = 5,
): Promise<Automation[]> {
  const res = await db.query<Row>(
    `SELECT ${COLUMNS}
     ${FROM_JOIN}
     WHERE a.workspace_id = $1
       AND a.enabled = TRUE
       AND a.last_fire_error IS NOT NULL
     ORDER BY a.updated_at DESC
     LIMIT $2`,
    [workspaceId, limit],
  );
  return res.rows.map(rowToAutomation);
}

// All enabled automations across all workspaces. The scheduler tick
// walks this once per cycle. Cheap given automations are scoped per
// workspace and the table is small; if it ever grows we'd shard by
// next-fire timestamp instead.
export async function listEnabledAutomations(): Promise<Automation[]> {
  const res = await db.query<Row>(
    `SELECT ${COLUMNS}
     ${FROM_JOIN}
     WHERE a.enabled = TRUE
     ORDER BY a.created_at ASC`,
  );
  return res.rows.map(rowToAutomation);
}
