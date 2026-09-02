import "server-only";

import { writeAuditEvent } from "@/lib/audit-db";
import { emailPasswordEnabled } from "@/lib/auth-providers";
import { db } from "@/lib/db";
import { isWorkspaceRole, type WorkspaceRole } from "@/lib/rbac";

// Workspace invitations. A workspace admin creates a pending invite
// (email + role); the invitee joins on their first sign-in, matched by
// email. The sign-up gate (lib/auth.ts) uses hasPendingInvite so an
// invited email may create an account even when the policy is invite-only.

export type PendingInvitation = {
  id: string;
  email: string;
  role: WorkspaceRole;
  invitedByName: string | null;
  createdAt: Date;
};

export type CreateInvitationError =
  | "bad-email"
  | "bad-role"
  | "already-member"
  | "already-invited";

export type CreateInvitationResult =
  // The invitee already had an account, so they were added to the
  // workspace immediately (no pending invite, nothing to send).
  | { ok: true; joinedDirectly: true }
  // Brand-new email — a pending invite was created; the admin shares
  // the sign-in link and the user joins on first sign-in.
  | { ok: true; joinedDirectly: false; invitation: PendingInvitation }
  | { ok: false; error: CreateInvitationError };

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function createInvitation(
  workspaceId: string,
  emailRaw: string,
  role: string,
  invitedBy: string,
): Promise<CreateInvitationResult> {
  const email = emailRaw.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, error: "bad-email" };
  if (!isWorkspaceRole(role)) return { ok: false, error: "bad-role" };

  // Already a member of this workspace (by email → user → membership)?
  const member = await db.query(
    `SELECT 1 FROM workspace_member m
       JOIN "user" u ON u.id = m.user_id
      WHERE m.workspace_id = $1 AND lower(u.email) = $2 LIMIT 1`,
    [workspaceId, email],
  );
  if ((member.rowCount ?? 0) > 0) return { ok: false, error: "already-member" };

  // Already has a pending invite to this workspace?
  const pending = await db.query(
    `SELECT 1 FROM workspace_invitation
      WHERE workspace_id = $1 AND lower(email) = $2 AND accepted_at IS NULL LIMIT 1`,
    [workspaceId, email],
  );
  if ((pending.rowCount ?? 0) > 0) {
    return { ok: false, error: "already-invited" };
  }

  // If the invitee already has an account, there's no "accept" step in
  // TAS — skip the pending-invite dance and add them to the workspace
  // right now. (The already-member check above means we only land here
  // when they exist but aren't yet in this workspace.)
  const existingUser = await db.query<{ id: string }>(
    `SELECT id FROM "user" WHERE lower(email) = $1 LIMIT 1`,
    [email],
  );
  if ((existingUser.rowCount ?? 0) > 0) {
    await db.query(
      `INSERT INTO workspace_member (workspace_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [workspaceId, existingUser.rows[0].id, role],
    );
    return { ok: true, joinedDirectly: true };
  }

  const { rows } = await db.query<{ id: string; created_at: Date }>(
    `INSERT INTO workspace_invitation (workspace_id, email, role, invited_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, created_at`,
    [workspaceId, email, role, invitedBy],
  );
  return {
    ok: true,
    joinedDirectly: false,
    invitation: {
      id: rows[0].id,
      email,
      role: role as WorkspaceRole,
      invitedByName: null,
      createdAt: rows[0].created_at,
    },
  };
}

export async function listPendingInvitations(
  workspaceId: string,
): Promise<PendingInvitation[]> {
  const { rows } = await db.query<{
    id: string;
    email: string;
    role: string;
    created_at: Date;
    invited_by_name: string | null;
  }>(
    `SELECT i.id, i.email, i.role, i.created_at, u.name AS invited_by_name
       FROM workspace_invitation i
       LEFT JOIN "user" u ON u.id = i.invited_by
      WHERE i.workspace_id = $1 AND i.accepted_at IS NULL
      ORDER BY i.created_at DESC`,
    [workspaceId],
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role as WorkspaceRole,
    invitedByName: r.invited_by_name,
    createdAt: r.created_at,
  }));
}

/** Delete a pending invite. Returns the deleted invite's email + role (for
 *  the caller's audit entry), or null if nothing matched. */
export async function revokeInvitation(
  id: string,
  workspaceId: string,
): Promise<{ email: string; role: WorkspaceRole } | null> {
  const res = await db.query<{ email: string; role: string }>(
    `DELETE FROM workspace_invitation
      WHERE id = $1 AND workspace_id = $2 AND accepted_at IS NULL
      RETURNING email, role`,
    [id, workspaceId],
  );
  const row = res.rows[0];
  return row ? { email: row.email, role: row.role as WorkspaceRole } : null;
}

/** Sign-up gate input: does any pending invite match this email? */
export async function hasPendingInvite(
  email: string | null | undefined,
): Promise<boolean> {
  if (!email) return false;
  const { rowCount } = await db.query(
    `SELECT 1 FROM workspace_invitation
      WHERE lower(email) = lower($1) AND accepted_at IS NULL LIMIT 1`,
    [email],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Should a pending invite resolve into a membership for a user whose email
 * carries this `emailVerified` flag? Honor an invite only when the IdP
 * verified the email (#47) — better-auth stores `emailVerified` from the
 * provider's `email_verified` claim (false when absent); Google/Microsoft
 * verify. Without this, a user who can assert an unverified /
 * attacker-controlled email at a permissive IdP could auto-join the invited
 * workspace at the invited role.
 *
 * On an email/password instance (no OAuth provider configured — see
 * emailPasswordEnabled) there is no IdP and `emailVerified` is always false,
 * so requiring it would strand every invitee: the sign-up gate lets them
 * sign up, but the invite would never become a membership. There the
 * sign-up gate itself is the authorization — so resolve invites regardless.
 * The IdP-permissiveness attack doesn't apply: no third-party assertion is
 * involved, and configuring any OAuth provider turns email/password off and
 * restores the strict check.
 */
export function inviteResolutionAllowed(emailVerified: boolean): boolean {
  return emailVerified || emailPasswordEnabled();
}

/**
 * On first sign-in, turn this user's pending invites into memberships.
 * Idempotent: re-running adds nothing (membership upsert + invite marked
 * accepted). Returns how many workspaces were joined.
 */
export async function resolvePendingInvitesForUser(
  userId: string,
  email: string,
): Promise<number> {
  const e = email.trim().toLowerCase();
  // Central gate (see inviteResolutionAllowed) — both user-driven paths
  // (first-sign-in hook + home-page resolve) funnel here.
  const { rows: verified } = await db.query<{ emailVerified: boolean }>(
    `SELECT "emailVerified" FROM "user" WHERE id = $1`,
    [userId],
  );
  if (!inviteResolutionAllowed(verified[0]?.emailVerified ?? false)) {
    console.warn(
      `[invites] skipping invite resolve for ${userId}: email not verified by the IdP`,
    );
    return 0;
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Join the inviter (invited_by) so the acceptance audit event can record
    // *who* invited this user — otherwise that link is lost once the invite
    // row is marked accepted.
    const { rows } = await client.query<{
      id: string;
      workspace_id: string;
      role: string;
      invited_by: string | null;
      invited_by_name: string | null;
      invited_by_email: string | null;
    }>(
      `SELECT i.id, i.workspace_id, i.role, i.invited_by,
              u.name AS invited_by_name, u.email AS invited_by_email
         FROM workspace_invitation i
         LEFT JOIN "user" u ON u.id = i.invited_by
        WHERE lower(i.email) = $1 AND i.accepted_at IS NULL
        FOR UPDATE OF i`,
      [e],
    );
    let joined = 0;
    // Workspaces where a NEW membership row was actually created (ON CONFLICT
    // skips re-runs) — audited after the commit so we don't log on rollback.
    const added: {
      workspaceId: string;
      role: string;
      invitedBy: string | null;
    }[] = [];
    for (const inv of rows) {
      const ins = await client.query(
        `INSERT INTO workspace_member (workspace_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, user_id) DO NOTHING`,
        [inv.workspace_id, userId, inv.role],
      );
      await client.query(
        `UPDATE workspace_invitation
            SET accepted_at = now(), accepted_by = $2
          WHERE id = $1`,
        [inv.id, userId],
      );
      if ((ins.rowCount ?? 0) > 0) {
        added.push({
          workspaceId: inv.workspace_id,
          role: inv.role,
          invitedBy: inv.invited_by_name ?? inv.invited_by_email ?? null,
        });
      }
      joined += 1;
    }
    await client.query("COMMIT");

    // Best-effort audit (post-commit, off the transaction client). The user
    // accepting their own invite is the actor; the payload records who invited
    // them so the chain (invited by X → accepted) is preserved.
    for (const a of added) {
      try {
        await writeAuditEvent({
          workspaceId: a.workspaceId,
          actorUserId: userId,
          source: "policy_change",
          kind: "member.added",
          targetType: "member",
          targetId: userId,
          agentName: null,
          payload: {
            role: a.role,
            via: "invite_accepted",
            ...(a.invitedBy ? { invitedBy: a.invitedBy } : {}),
          },
        });
      } catch (e) {
        console.error("[audit] member.added write failed:", e);
      }
    }
    return joined;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Resolve pending invites for an existing user by id (looks up their
 * email, then delegates). Safety net for invites that predate the
 * "add existing users directly" path in createInvitation — called when
 * the user lands on `/`, so a stuck pending invite clears on their next
 * visit. Idempotent and a no-op when there's nothing pending.
 */
export async function resolvePendingInvitesForUserId(
  userId: string,
): Promise<number> {
  const { rows } = await db.query<{ email: string }>(
    `SELECT email FROM "user" WHERE id = $1 LIMIT 1`,
    [userId],
  );
  const email = rows[0]?.email;
  if (!email) return 0;
  return resolvePendingInvitesForUser(userId, email);
}
