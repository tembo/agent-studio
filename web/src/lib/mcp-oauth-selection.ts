import "server-only";

import { db } from "@/lib/db";

type SelectionRow = { workspace_id: string };

export async function selectMcpOAuthWorkspace(args: {
  sessionId: string;
  userId: string;
  workspaceId: string;
}): Promise<boolean> {
  const { rows } = await db.query<SelectionRow>(
    `INSERT INTO mcp_oauth_workspace_selection
       (session_id, user_id, workspace_id, selected_at)
     SELECT $1, $2, m.workspace_id, NOW()
       FROM workspace_member m
      WHERE m.workspace_id = $3 AND m.user_id = $2
     ON CONFLICT (session_id) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           workspace_id = EXCLUDED.workspace_id,
           selected_at = NOW()
     RETURNING workspace_id`,
    [args.sessionId, args.userId, args.workspaceId],
  );
  return rows.length === 1;
}

export async function getMcpOAuthWorkspaceSelection(
  sessionId: string,
  userId: string,
): Promise<string | null> {
  const { rows } = await db.query<SelectionRow>(
    `SELECT s.workspace_id
       FROM mcp_oauth_workspace_selection s
       JOIN workspace_member m
         ON m.workspace_id = s.workspace_id AND m.user_id = s.user_id
      WHERE s.session_id = $1 AND s.user_id = $2
      LIMIT 1`,
    [sessionId, userId],
  );
  return rows[0]?.workspace_id ?? null;
}

