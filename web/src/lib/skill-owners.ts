import "server-only";

import { db } from "@/lib/db";

export type SkillOwner = {
  userId: string;
  name: string;
};

export async function listSkillOwners(
  workspaceId: string,
): Promise<Map<string, SkillOwner>> {
  const { rows } = await db.query<{
    skill_name: string;
    user_id: string;
    name: string;
  }>(
    `SELECT so.skill_name, u.id AS user_id,
            COALESCE(NULLIF(u.name, ''), u.email) AS name
       FROM skill_owner so
       JOIN "user" u ON u.id = so.owner_user_id
      WHERE so.workspace_id = $1`,
    [workspaceId],
  );
  return new Map(rows.map((row) => [
    row.skill_name, { userId: row.user_id, name: row.name },
  ]));
}

export async function recordSkillOwner(
  workspaceId: string,
  skillName: string,
  userId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO skill_owner (workspace_id, skill_name, owner_user_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, skill_name) DO UPDATE
       SET owner_user_id = EXCLUDED.owner_user_id
       WHERE skill_owner.owner_user_id IS NULL`,
    [workspaceId, skillName, userId],
  );
}

export async function removeSkillOwner(
  workspaceId: string,
  skillName: string,
): Promise<void> {
  await db.query(
    `DELETE FROM skill_owner WHERE workspace_id = $1 AND skill_name = $2`,
    [workspaceId, skillName],
  );
}

export async function changeSkillOwner(args: {
  workspaceId: string;
  skillName: string;
  actorUserId: string;
  isAdmin: boolean;
  ownerUserId: string;
}): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO skill_owner (workspace_id, skill_name, owner_user_id)
     SELECT $1, $2, $3
      WHERE EXISTS (
        SELECT 1 FROM workspace_member WHERE workspace_id = $1 AND user_id = $3
      ) AND ($4 OR ($3 <> $5 AND EXISTS (
        SELECT 1 FROM skill_owner
         WHERE workspace_id = $1 AND skill_name = $2 AND owner_user_id = $5
      )))
     ON CONFLICT (workspace_id, skill_name) DO UPDATE
       SET owner_user_id = EXCLUDED.owner_user_id
       WHERE $4 OR (skill_owner.owner_user_id = $5 AND $3 <> $5)
     RETURNING owner_user_id`,
    [args.workspaceId, args.skillName, args.ownerUserId, args.isAdmin, args.actorUserId],
  );
  return rowCount === 1;
}
