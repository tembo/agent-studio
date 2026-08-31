import "server-only";

import { db } from "@/lib/db";
import {
  normalizeAgentInventoryFilters,
  type AgentInventoryFilters,
  type AgentInventoryView,
  type AgentInventoryViewVisibility,
} from "@/lib/agent-inventory-view-types";

type ViewRow = {
  id: string;
  name: string;
  visibility: AgentInventoryViewVisibility;
  created_by: string;
  filters: unknown;
};

export type StoredAgentInventoryView = AgentInventoryView & {
  filters: AgentInventoryFilters;
};

function mapView(row: ViewRow): StoredAgentInventoryView {
  return {
    id: row.id,
    name: row.name,
    visibility: row.visibility,
    createdBy: row.created_by,
    filters: normalizeAgentInventoryFilters(row.filters),
  };
}

export async function listAgentInventoryViews(
  workspaceId: string,
  userId: string,
): Promise<StoredAgentInventoryView[]> {
  const { rows } = await db.query<ViewRow>(
    `SELECT id, name, visibility, created_by, filters
       FROM agent_inventory_view
      WHERE workspace_id = $1
        AND (visibility = 'shared' OR created_by = $2)
      ORDER BY CASE visibility WHEN 'personal' THEN 0 ELSE 1 END,
               lower(name), id`,
    [workspaceId, userId],
  );
  return rows.map(mapView);
}

export async function createAgentInventoryView(args: {
  workspaceId: string;
  userId: string;
  name: string;
  visibility: AgentInventoryViewVisibility;
  filters: AgentInventoryFilters;
}): Promise<StoredAgentInventoryView> {
  const { rows } = await db.query<ViewRow>(
    `INSERT INTO agent_inventory_view
       (workspace_id, created_by, name, visibility, filters)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING id, name, visibility, created_by, filters`,
    [
      args.workspaceId,
      args.userId,
      args.name,
      args.visibility,
      JSON.stringify(args.filters),
    ],
  );
  return mapView(rows[0]);
}

export async function deleteAgentInventoryView(args: {
  workspaceId: string;
  userId: string;
  viewId: string;
  canManageShared: boolean;
}): Promise<boolean> {
  const { rowCount } = await db.query(
    `DELETE FROM agent_inventory_view
      WHERE id = $1 AND workspace_id = $2
        AND (created_by = $3 OR ($4 AND visibility = 'shared'))`,
    [args.viewId, args.workspaceId, args.userId, args.canManageShared],
  );
  return (rowCount ?? 0) > 0;
}
