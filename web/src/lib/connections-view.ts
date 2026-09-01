import "server-only";

import { getWorkspaceRole, listWorkspaceMembers } from "@/lib/workspace";

// Resolves whose connections the Connections page should show. Members
// only ever see their own. A workspace admin may view another member's
// (via a ?user=<id> param + the "Viewing" dropdown) — they can rename and
// refresh those, but not connect/disconnect (OAuth Connect must be done
// by the member themselves; see the section components' viewingOther
// gating).

export type ConnectionMember = {
  userId: string;
  name: string | null;
  email: string;
};

export type ConnectionsView = {
  /** Whose connections to load + display. */
  userId: string;
  /** Admin is viewing a member other than themselves. */
  viewingOther: boolean;
  isAdmin: boolean;
  role: Awaited<ReturnType<typeof getWorkspaceRole>>;
  /** Member who's being viewed (for the header), when viewingOther. */
  viewedMember: ConnectionMember | null;
};

export async function resolveConnectionsView(
  workspaceId: string,
  sessionUserId: string,
  requestedUserId: string | undefined,
): Promise<ConnectionsView> {
  const role = await getWorkspaceRole(workspaceId, sessionUserId);
  const isAdmin = role === "workspace_admin";
  if (!isAdmin || !requestedUserId || requestedUserId === sessionUserId) {
    return {
      userId: sessionUserId,
      viewingOther: false,
      isAdmin,
      role,
      viewedMember: null,
    };
  }
  const members = await listWorkspaceMembers(workspaceId);
  const target = members.find((m) => m.userId === requestedUserId);
  if (!target) {
    return {
      userId: sessionUserId,
      viewingOther: false,
      isAdmin,
      role,
      viewedMember: null,
    };
  }
  return {
    userId: target.userId,
    viewingOther: true,
    isAdmin,
    role,
    viewedMember: {
      userId: target.userId,
      name: target.name,
      email: target.email,
    },
  };
}
