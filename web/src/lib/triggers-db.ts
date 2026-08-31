import "server-only";

import { db } from "@/lib/db";

// DB layer for workspace_trigger — the local registry of event-driven
// "fire this agent when Composio reports this event" bindings.
//
// Each row holds the Composio trigger_id (which is what the inbound
// webhook payload carries back to us), the agent to fire, the owning
// user (whose credentials the run executes under, mirroring
// automation.owner_user_id), and the connection slot the trigger was
// bound to (so disconnecting a credential RESTRICTs cleanly instead
// of silently breaking).

export type WorkspaceTrigger = {
  id: string;
  workspaceId: string;
  userId: string;
  agentName: string;
  composioTriggerId: string;
  toolkitSlug: string;
  triggerType: string;
  connectionId: string;
  triggerConfig: Record<string, unknown>;
  enabled: boolean;
  lastFiredAt: Date | null;
  lastFireError: string | null;
  lastFireEventId: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

type Row = {
  id: string;
  workspace_id: string;
  user_id: string;
  agent_name: string;
  composio_trigger_id: string;
  toolkit_slug: string;
  trigger_type: string;
  connection_id: string;
  trigger_config: Record<string, unknown> | null;
  enabled: boolean;
  last_fired_at: Date | null;
  last_fire_error: string | null;
  last_fire_event_id: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
};

const COLUMNS =
  "id, workspace_id, user_id, agent_name, composio_trigger_id, toolkit_slug, trigger_type, connection_id, trigger_config, enabled, last_fired_at, last_fire_error, last_fire_event_id, created_by, created_at, updated_at";

function rowToTrigger(r: Row): WorkspaceTrigger {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    userId: r.user_id,
    agentName: r.agent_name,
    composioTriggerId: r.composio_trigger_id,
    toolkitSlug: r.toolkit_slug,
    triggerType: r.trigger_type,
    connectionId: r.connection_id,
    triggerConfig: r.trigger_config ?? {},
    enabled: r.enabled,
    lastFiredAt: r.last_fired_at,
    lastFireError: r.last_fire_error,
    lastFireEventId: r.last_fire_event_id,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listTriggersForAgent(
  workspaceId: string,
  agentName: string,
): Promise<WorkspaceTrigger[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS}
       FROM workspace_trigger
      WHERE workspace_id = $1 AND agent_name = $2
      ORDER BY created_at ASC`,
    [workspaceId, agentName],
  );
  return rows.map(rowToTrigger);
}

export async function listTriggersForWorkspace(
  workspaceId: string,
): Promise<WorkspaceTrigger[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS}
       FROM workspace_trigger
      WHERE workspace_id = $1
      ORDER BY agent_name ASC, created_at ASC`,
    [workspaceId],
  );
  return rows.map(rowToTrigger);
}

export async function getTriggerById(
  workspaceId: string,
  id: string,
): Promise<WorkspaceTrigger | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS}
       FROM workspace_trigger
      WHERE workspace_id = $1 AND id = $2
      LIMIT 1`,
    [workspaceId, id],
  );
  return rows[0] ? rowToTrigger(rows[0]) : null;
}

/**
 * Webhook lookup: inbound payload carries composio_trigger_id, we
 * resolve it to "which workspace, which agent, which owner."
 */
export async function getTriggerByComposioId(
  composioTriggerId: string,
): Promise<WorkspaceTrigger | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS}
       FROM workspace_trigger
      WHERE composio_trigger_id = $1
      LIMIT 1`,
    [composioTriggerId],
  );
  return rows[0] ? rowToTrigger(rows[0]) : null;
}

export async function saveTrigger(args: {
  workspaceId: string;
  userId: string;
  agentName: string;
  composioTriggerId: string;
  toolkitSlug: string;
  triggerType: string;
  connectionId: string;
  triggerConfig: Record<string, unknown>;
  createdBy: string;
}): Promise<WorkspaceTrigger> {
  const { rows } = await db.query<Row>(
    `INSERT INTO workspace_trigger
       (workspace_id, user_id, agent_name, composio_trigger_id, toolkit_slug, trigger_type,
        connection_id, trigger_config, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${COLUMNS}`,
    [
      args.workspaceId,
      args.userId,
      args.agentName,
      args.composioTriggerId,
      args.toolkitSlug,
      args.triggerType,
      args.connectionId,
      JSON.stringify(args.triggerConfig),
      args.createdBy,
    ],
  );
  return rowToTrigger(rows[0]);
}

export async function setTriggerEnabled(
  workspaceId: string,
  id: string,
  enabled: boolean,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE workspace_trigger
        SET enabled = $3, updated_at = NOW()
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id, enabled],
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteTriggerLocal(
  workspaceId: string,
  id: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `DELETE FROM workspace_trigger WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id],
  );
  return (rowCount ?? 0) > 0;
}
