import "server-only";

import { db } from "@/lib/db";
import { memberChoice, type MemberChoice } from "@/lib/member-choice";

type Row = { id: string; name: string | null; email: string };

export async function getWorkspaceMemberChoice(workspaceId: string, userId: string): Promise<MemberChoice | null> {
  const { rows } = await db.query<Row>(
    `SELECT u.id, u.name, u.email FROM workspace_member m
       JOIN "user" u ON u.id = m.user_id
      WHERE m.workspace_id = $1 AND m.user_id = $2`,
    [workspaceId, userId],
  );
  const row = rows[0];
  return row ? memberChoice(row.id, row.name, row.email) : null;
}

export async function searchWorkspaceMembers(workspaceId: string, search: string) {
  const pattern = `%${search.trim().replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const { rows } = await db.query<Row>(
    `SELECT u.id, u.name, u.email FROM workspace_member m
       JOIN "user" u ON u.id = m.user_id
      WHERE m.workspace_id = $1
        AND (u.name ILIKE $2 ESCAPE '\\' OR u.email ILIKE $2 ESCAPE '\\' OR u.id = $3)
      ORDER BY u.email, u.id
      LIMIT 26`,
    [workspaceId, pattern, search.trim()],
  );
  return {
    members: rows.slice(0, 25).map((row) => memberChoice(row.id, row.name, row.email)),
    hasMore: rows.length > 25,
  };
}
