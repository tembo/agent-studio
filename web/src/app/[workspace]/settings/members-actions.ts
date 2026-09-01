"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";

import { writeAuditEvent } from "@/lib/audit-db";
import { emailPasswordEnabled } from "@/lib/auth-providers";
import {
  authorizeWorkspace as authorizeWorkspaceShared,
  DENIED_MESSAGE,
} from "@/lib/auth-server";
import { getPublicOrigin } from "@/lib/config";
import { getInstanceName } from "@/lib/instance-settings";
import { createInvitation, revokeInvitation } from "@/lib/invitations";
import {
  createPasswordResetToken,
  resetPasswordPath,
} from "@/lib/password-reset";
import { isWorkspaceRole, type WorkspaceRole } from "@/lib/rbac";
import { offboardWorkspaceMember } from "@/lib/member-offboarding";
import {
  changeMemberRole,
  listWorkspaceMembers,
} from "@/lib/workspace";

// Member management actions, extracted from the settings grab-bag
// actions.ts (boy-scout rule — see AGENTS.md). Same authorization
// pattern: workspace-admin only, 404 on missing session/workspace,
// DENIED_MESSAGE in form state on role denial.

async function authorizeWorkspace(
  slug: string,
  minRole: WorkspaceRole = "workspace_admin",
) {
  const auth = await authorizeWorkspaceShared(slug, minRole);
  if (!auth.ok) {
    if (auth.reason === "denied") return { denied: true as const };
    notFound();
  }
  return {
    denied: false as const,
    workspace: auth.workspace,
    userId: auth.userId,
    role: auth.role,
  };
}

export type MemberFormState = {
  message?: string;
  error?: string;
  /** Copy-paste invite text, set after a successful invitation. */
  template?: string;
  invitedEmail?: string;
};

const MEMBER_EMPTY: MemberFormState = {};

/**
 * Add a workspace member by email. Workspace-admin only. The
 * invitee must have signed in to TAS at least once so a user row
 * exists; we don't email invitations from TAS itself today.
 */
export async function inviteMemberAction(
  _prev: MemberFormState,
  formData: FormData,
): Promise<MemberFormState> {
  const slug = String(formData.get("workspace") ?? "");
  const email = String(formData.get("email") ?? "").trim();
  const roleRaw = String(formData.get("role") ?? "").trim();

  if (!email) return { error: "Enter an email address." };
  if (!isWorkspaceRole(roleRaw)) return { error: "Pick a role." };
  const role: WorkspaceRole = roleRaw;

  const auth = await authorizeWorkspace(slug, "workspace_admin");
  if (auth.denied) return { error: DENIED_MESSAGE };
  const { workspace, userId } = auth;

  const result = await createInvitation(workspace.id, email, role, userId);
  if (!result.ok) {
    switch (result.error) {
      case "bad-email":
        return { error: "That doesn't look like a valid email address." };
      case "bad-role":
        return { error: "Pick a role." };
      case "already-member":
        return {
          error:
            "That person is already a member. Change their role on the member row instead.",
        };
      case "already-invited":
        return { error: "That email already has a pending invitation." };
    }
  }

  // Existing account → added straight to the workspace, no invite to send.
  if (result.joinedDirectly) {
    await writeAuditEvent({
      workspaceId: workspace.id,
      actorUserId: userId,
      source: "policy_change",
      kind: "member.added",
      targetType: "member",
      targetId: null,
      agentName: null,
      payload: { email, role, via: "admin_added_existing" },
    });
    revalidatePath(`/${slug}/settings`);
    return {
      message: `Added ${email}. TAS did not email them, so let them know they were added.`,
      invitedEmail: email,
    };
  }

  await writeAuditEvent({
    workspaceId: workspace.id,
    actorUserId: userId,
    source: "policy_change",
    kind: "member.invited",
    targetType: "member",
    targetId: result.invitation.id,
    agentName: null,
    payload: { email, role },
  });

  // Build the copy-paste invite (no email infra yet — the admin sends it).
  const [instanceName] = await Promise.all([getInstanceName()]);
  const origin = getPublicOrigin();
  const template = [
    `You've been invited to the "${workspace.name}" workspace on ${instanceName}.`,
    ``,
    `To join, sign in with this email (${email}) at:`,
    origin,
    ``,
    `You'll be added automatically on your first sign-in.`,
  ].join("\n");

  revalidatePath(`/${slug}/settings`);
  return {
    message: `Invitation created for ${email}. TAS did not email them, so send the message below.`,
    template,
    invitedEmail: email,
  };
}

// Plain form action (fire-and-forget) so it can be used directly in a
// server-rendered <form action={...}> on each pending-invite row.
export async function revokeInvitationAction(formData: FormData): Promise<void> {
  const slug = String(formData.get("workspace") ?? "");
  const invitationId = String(formData.get("invitationId") ?? "");

  const auth = await authorizeWorkspace(slug, "workspace_admin");
  if (auth.denied) return;

  const revoked = await revokeInvitation(invitationId, auth.workspace.id);
  if (revoked) {
    await writeAuditEvent({
      workspaceId: auth.workspace.id,
      actorUserId: auth.userId,
      source: "policy_change",
      kind: "member.invite_revoked",
      targetType: "member",
      targetId: invitationId,
      agentName: null,
      payload: { email: revoked.email, role: revoked.role },
    });
  }
  revalidatePath(`/${slug}/settings`);
}

/**
 * Change an existing member's role. Workspace-admin only. Blocks
 * demoting the last admin — the lib helper enforces this.
 */
export async function changeMemberRoleAction(
  _prev: MemberFormState,
  formData: FormData,
): Promise<MemberFormState> {
  const slug = String(formData.get("workspace") ?? "");
  const targetUserId = String(formData.get("user_id") ?? "").trim();
  const newRoleRaw = String(formData.get("role") ?? "").trim();
  if (!targetUserId) return { error: "Missing user id." };
  if (!isWorkspaceRole(newRoleRaw)) return { error: "Pick a role." };
  const newRole: WorkspaceRole = newRoleRaw;

  const auth = await authorizeWorkspace(slug, "workspace_admin");
  if (auth.denied) return { error: DENIED_MESSAGE };
  const { workspace, userId } = auth;

  const result = await changeMemberRole(workspace.id, targetUserId, newRole);
  if (!result.ok) {
    switch (result.error) {
      case "not-found":
        return { error: "Member no longer exists in this workspace." };
      case "last-admin":
        return {
          error:
            "Can't demote the last workspace admin. Promote someone else first.",
        };
    }
  }

  if (result.previousRole !== result.newRole) {
    await writeAuditEvent({
      workspaceId: workspace.id,
      actorUserId: userId,
      source: "policy_change",
      kind: "member.role_changed",
      targetType: "member",
      targetId: targetUserId,
      agentName: null,
      payload: {
        target: result.target,
        previousRole: result.previousRole,
        newRole: result.newRole,
      },
    });
  }

  revalidatePath(`/${slug}/settings`);
  return MEMBER_EMPTY;
}

/**
 * Remove a member from a workspace. Workspace-admin only. Blocks
 * removing the last admin.
 */
export async function removeMemberAction(
  _prev: MemberFormState,
  formData: FormData,
): Promise<MemberFormState> {
  const slug = String(formData.get("workspace") ?? "");
  const targetUserId = String(formData.get("user_id") ?? "").trim();
  const replacementUserId =
    String(formData.get("reassign_user_id") ?? "").trim() || null;
  if (!targetUserId) return { error: "Missing user id." };

  const auth = await authorizeWorkspace(slug, "workspace_admin");
  if (auth.denied) return { error: DENIED_MESSAGE };
  const { workspace, userId } = auth;

  const result = await offboardWorkspaceMember(
    workspace.id,
    targetUserId,
    replacementUserId,
  );
  if (!result.ok) {
    switch (result.error) {
      case "not-found":
        return { error: "Member no longer exists in this workspace." };
      case "last-admin":
        return {
          error:
            "Can't remove the last workspace admin. Promote someone else first.",
        };
      case "invalid-replacement":
        return {
          error:
            "Choose another current workspace member to own these automations.",
        };
    }
  }

  await writeAuditEvent({
    workspaceId: workspace.id,
    actorUserId: userId,
    source: "policy_change",
    kind: "member.removed",
    targetType: "member",
    targetId: targetUserId,
    agentName: null,
    payload: {
      target: result.target,
      previousRole: result.previousRole,
      automationCount: result.automationCount,
      reassignedAutomationCount: result.reassignedAutomationCount,
      pausedAutomationCount: result.pausedAutomationCount,
      replacementUserId: result.replacementUserId,
    },
  });

  revalidatePath(`/${slug}/settings`);
  return MEMBER_EMPTY;
}

// ─────────────────────────────────────────────────────────────────────
// Password reset links (email/password instances)

export type ResetLinkState = {
  message?: string;
  error?: string;
  /** One-time reset URL to hand to the member out-of-band. */
  url?: string;
  /** ISO expiry of the link. */
  expiresAt?: string;
};

/**
 * Mint a one-time password reset link for a member. Workspace-admin
 * only, and only on email/password instances — OAuth instances reset
 * passwords at the identity provider, and the stock reset endpoint
 * being able to CREATE a credential account for an OAuth-only user
 * would amount to a second sign-in method the instance didn't enable.
 * The admin shares the link out-of-band; it expires in an hour and is
 * consumed on use.
 */
export async function createResetLinkAction(
  _prev: ResetLinkState,
  formData: FormData,
): Promise<ResetLinkState> {
  const slug = String(formData.get("workspace") ?? "");
  const targetUserId = String(formData.get("user_id") ?? "").trim();
  if (!targetUserId) return { error: "Missing user id." };

  if (!emailPasswordEnabled()) {
    return {
      error:
        "Password reset links only apply to email/password instances. This instance signs in through an identity provider.",
    };
  }

  const auth = await authorizeWorkspace(slug, "workspace_admin");
  if (auth.denied) return { error: DENIED_MESSAGE };
  const { workspace, userId } = auth;

  // Scope check: the admin may only reset members of their own workspace.
  const members = await listWorkspaceMembers(workspace.id);
  const target = members.find((m) => m.userId === targetUserId);
  if (!target) return { error: "Member no longer exists in this workspace." };

  const { token, expiresAt } = await createPasswordResetToken(targetUserId);

  await writeAuditEvent({
    workspaceId: workspace.id,
    actorUserId: userId,
    source: "policy_change",
    kind: "member.password_reset_link_created",
    targetType: "member",
    targetId: targetUserId,
    agentName: null,
    // Never the token itself — the audit log records that a link was
    // minted and for whom, not a credential equivalent.
    payload: { email: target.email, expiresAt: expiresAt.toISOString() },
  });

  return {
    message: `Reset link created for ${target.email}.`,
    url: `${getPublicOrigin()}${resetPasswordPath(token)}`,
    expiresAt: expiresAt.toISOString(),
  };
}
