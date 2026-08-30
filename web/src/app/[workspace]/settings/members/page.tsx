import { notFound } from "next/navigation";

import { listPendingInvitations } from "@/lib/invitations";
import { listAutomationOwnershipCounts } from "@/lib/member-offboarding";
import { getServerSession } from "@/lib/session";
import {
  getWorkspaceBySlug,
  getWorkspaceRole,
  listWorkspaceMembers,
} from "@/lib/workspace";

import { MembersSection } from "../members-section";

export const dynamic = "force-dynamic";

// Members: role assignments, add-by-email, removal. Workspace-admin
// gating happens inside the server actions; viewers/operators see
// the read-only list. Surfaces the audit-trail spirit of v0.4-05
// by routing every change through writeAuditEvent at the action
// layer.

export default async function MembersPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const session = await getServerSession();
  if (!session) notFound();

  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();

  const [
    members,
    currentUserRole,
    pendingInvitations,
    automationOwnershipCounts,
  ] = await Promise.all([
    listWorkspaceMembers(workspace.id),
    getWorkspaceRole(workspace.id, session.user.id),
    listPendingInvitations(workspace.id),
    listAutomationOwnershipCounts(workspace.id),
  ]);
  if (!currentUserRole) notFound();

  return (
    <MembersSection
      workspaceSlug={workspace.slug}
      members={members}
      pendingInvitations={pendingInvitations}
      currentUserRole={currentUserRole}
      currentUserId={session.user.id}
      automationOwnershipCounts={automationOwnershipCounts}
    />
  );
}
