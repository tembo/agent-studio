import { LocalTime } from "@/components/local-time";
import { Section } from "@/components/section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { type PendingInvitation } from "@/lib/invitations";
import { ROLE_DESCRIPTIONS, type WorkspaceRole } from "@/lib/rbac";
import { type WorkspaceMember } from "@/lib/workspace";

import { revokeInvitationAction } from "./members-actions";
import { AddMemberForm } from "./add-member-form";
import { MemberRow } from "./member-row";

// Settings → Members (US-0.4-02). Lists every workspace member with
// their role. workspace_admin sees an inline role picker per row
// and an "Add member" form below. Operator and viewer see the list
// without the controls — the page renders for everyone so members
// can see "who's in this workspace" even if they can't change it.

type Props = {
  workspaceSlug: string;
  members: WorkspaceMember[];
  /** Pending (unaccepted) invitations; admin-only. */
  pendingInvitations: PendingInvitation[];
  /** Current viewer's role; gates the admin-only controls. */
  currentUserRole: WorkspaceRole;
  /** Current viewer's user id; used to mark the "(you)" row. */
  currentUserId: string;
  /** Number of schedules each member owns through automation.owner_user_id. */
  automationOwnershipCounts: Record<string, number>;
};

export function MembersSection({
  workspaceSlug,
  members,
  pendingInvitations,
  currentUserRole,
  currentUserId,
  automationOwnershipCounts,
}: Props) {
  const canManage = currentUserRole === "workspace_admin";
  return (
    <Section
      title="Members"
      description={
        canManage
          ? "Add a member by email or change their role. TAS does not email new members, so you must notify them yourself. Invitees join on their first sign-in."
          : "Workspace members and their roles. Ask a workspace admin to change yours."
      }
    >
      <div className="flex flex-col gap-4">
        <ul className="border-border bg-surface divide-border-weak divide-y overflow-hidden rounded-lg border">
          {members.map((m) => (
            <MemberRow
              key={m.userId}
              workspaceSlug={workspaceSlug}
              member={m}
              canManage={canManage}
              isSelf={m.userId === currentUserId}
              ownedAutomationCount={automationOwnershipCounts[m.userId] ?? 0}
              reassignmentCandidates={members
                .filter((candidate) => candidate.userId !== m.userId)
                .map((candidate) => ({
                  userId: candidate.userId,
                  label: candidate.name ?? candidate.email,
                }))}
            />
          ))}
        </ul>

        {canManage && pendingInvitations.length > 0 && (
          <div className="flex flex-col gap-2">
            <h3 className="text-foreground text-sm font-medium">
              Pending invitations
            </h3>
            <ul className="border-border bg-surface divide-border-weak divide-y overflow-hidden rounded-lg border">
              {pendingInvitations.map((inv) => {
                const label =
                  ROLE_DESCRIPTIONS.find((r) => r.role === inv.role)?.label ??
                  inv.role;
                return (
                  <li
                    key={inv.id}
                    className="flex items-center justify-between gap-3 px-3 py-2"
                  >
                    <div className="flex min-w-0 flex-col">
                      <span className="text-foreground truncate text-sm">
                        {inv.email}
                      </span>
                      <span className="text-foreground-weak text-sm">
                        Invited{" "}
                        <LocalTime iso={inv.createdAt.toISOString()} /> · not
                        yet signed in
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={roleVariant(inv.role)} size="small">
                        {label}
                      </Badge>
                      <form action={revokeInvitationAction}>
                        <input
                          type="hidden"
                          name="workspace"
                          value={workspaceSlug}
                        />
                        <input
                          type="hidden"
                          name="invitationId"
                          value={inv.id}
                        />
                        <Button type="submit" variant="ghost" size="small">
                          Revoke
                        </Button>
                      </form>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {canManage && (
          <details className="bg-surface border-border rounded-lg border p-3">
            <summary className="text-foreground cursor-pointer text-sm font-medium">
              Add a member
            </summary>
            <div className="mt-3">
              <AddMemberForm workspaceSlug={workspaceSlug} />
            </div>
          </details>
        )}

        <details>
          <summary className="text-foreground-weak hover:text-foreground cursor-pointer text-sm">
            Role reference
          </summary>
          <dl className="mt-2 flex flex-col gap-1.5 text-sm">
            {ROLE_DESCRIPTIONS.map((r) => (
              <div key={r.role} className="flex items-baseline gap-2">
                <Badge variant={roleVariant(r.role)} size="small">
                  {r.label}
                </Badge>
                <span className="text-foreground-weak">{r.description}</span>
              </div>
            ))}
          </dl>
        </details>
      </div>
    </Section>
  );
}

function roleVariant(role: WorkspaceRole): "blue" | "green" | "gray" {
  switch (role) {
    case "workspace_admin":
      return "blue";
    case "operator":
      return "green";
    case "viewer":
      return "gray";
  }
}
