import "server-only";

import { ORPHANED_AUTOMATION_ERROR } from "@/lib/automations-api";
import { db } from "@/lib/db";
import { isWorkspaceRole, type WorkspaceRole } from "@/lib/rbac";

export type OffboardMemberResult =
  | {
      ok: true;
      target: { name: string | null; email: string };
      previousRole: WorkspaceRole;
      automationCount: number;
      reassignedAutomationCount: number;
      pausedAutomationCount: number;
      replacementUserId: string | null;
    }
  | {
      ok: false;
      error: "not-found" | "last-admin" | "invalid-replacement";
    };

export async function listAutomationOwnershipCounts(
  workspaceId: string,
): Promise<Record<string, number>> {
  const { rows } = await db.query<{ owner_user_id: string; count: string }>(
    `SELECT owner_user_id, COUNT(*)::text AS count
       FROM automation
      WHERE workspace_id = $1
      GROUP BY owner_user_id`,
    [workspaceId],
  );
  return Object.fromEntries(
    rows.map((row) => [row.owner_user_id, Number(row.count)]),
  );
}

/** Remove a member while resolving every schedule that runs as them. */
export async function offboardWorkspaceMember(
  workspaceId: string,
  targetUserId: string,
  replacementUserId: string | null,
): Promise<OffboardMemberResult> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: existingRows } = await client.query<{
      role: string;
      name: string | null;
      email: string;
    }>(
      `SELECT m.role, u.name, u.email
         FROM workspace_member m
         JOIN "user" u ON u.id = m.user_id
        WHERE m.workspace_id = $1 AND m.user_id = $2
        FOR UPDATE OF m`,
      [workspaceId, targetUserId],
    );
    const existing = existingRows[0];
    if (!existing) {
      await client.query("ROLLBACK");
      return { ok: false, error: "not-found" };
    }

    const previousRole = isWorkspaceRole(existing.role)
      ? existing.role
      : "viewer";
    if (previousRole === "workspace_admin") {
      const { rows: countRows } = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM workspace_member
          WHERE workspace_id = $1 AND role = 'workspace_admin'`,
        [workspaceId],
      );
      if (Number(countRows[0].count) <= 1) {
        await client.query("ROLLBACK");
        return { ok: false, error: "last-admin" };
      }
    }

    if (replacementUserId) {
      if (replacementUserId === targetUserId) {
        await client.query("ROLLBACK");
        return { ok: false, error: "invalid-replacement" };
      }
      const { rows: replacementRows } = await client.query<{ user_id: string }>(
        `SELECT user_id
           FROM workspace_member
          WHERE workspace_id = $1 AND user_id = $2
          FOR KEY SHARE`,
        [workspaceId, replacementUserId],
      );
      if (!replacementRows[0]) {
        await client.query("ROLLBACK");
        return { ok: false, error: "invalid-replacement" };
      }
    }

    const { rows: automationRows } = await client.query<{
      id: string;
      enabled: boolean;
    }>(
      `SELECT id, enabled
         FROM automation
        WHERE workspace_id = $1 AND owner_user_id = $2
        FOR UPDATE`,
      [workspaceId, targetUserId],
    );

    let reassignedAutomationCount = 0;
    let pausedAutomationCount = 0;
    if (replacementUserId && automationRows.length > 0) {
      await client.query(
        `UPDATE automation
            SET owner_user_id = $3, updated_at = NOW()
          WHERE workspace_id = $1 AND owner_user_id = $2`,
        [workspaceId, targetUserId, replacementUserId],
      );
      reassignedAutomationCount = automationRows.length;
    } else {
      pausedAutomationCount = automationRows.filter((row) => row.enabled).length;
      if (pausedAutomationCount > 0) {
        await client.query(
          `UPDATE automation
              SET enabled = FALSE, last_fire_error = $3, updated_at = NOW()
            WHERE workspace_id = $1 AND owner_user_id = $2 AND enabled = TRUE`,
          [workspaceId, targetUserId, ORPHANED_AUTOMATION_ERROR],
        );
      }
    }

    await client.query(
      `DELETE FROM workspace_member
        WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, targetUserId],
    );
    await client.query("COMMIT");
    return {
      ok: true,
      target: { name: existing.name, email: existing.email },
      previousRole,
      automationCount: automationRows.length,
      reassignedAutomationCount,
      pausedAutomationCount,
      replacementUserId,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
