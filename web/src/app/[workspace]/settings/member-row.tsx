"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { useActionToast } from "@/lib/use-action-toast";

import { LocalTime } from "@/components/local-time";
import { Badge } from "@/components/ui/badge";
import { ROLE_DESCRIPTIONS, type WorkspaceRole } from "@/lib/rbac";
import { type WorkspaceMember } from "@/lib/workspace";

import {
  changeMemberRoleAction,
  removeMemberAction,
  type MemberFormState,
} from "./members-actions";

const INITIAL: MemberFormState = {};

type Props = {
  workspaceSlug: string;
  member: WorkspaceMember;
  canManage: boolean;
  isSelf: boolean;
  ownedAutomationCount: number;
  reassignmentCandidates: Array<{ userId: string; label: string }>;
};

export function MemberRow({
  workspaceSlug,
  member,
  canManage,
  isSelf,
  ownedAutomationCount,
  reassignmentCandidates,
}: Props) {
  const [changeState, changeAction, changePending] = useActionState(
    changeMemberRoleAction,
    INITIAL,
  );
  useActionToast(changeState);
  const [removeState, removeAction, removePending] = useActionState(
    removeMemberAction,
    INITIAL,
  );
  useActionToast(removeState);
  // Track the local select value so the user gets immediate feedback;
  // the role committed at the server might lag if there's an error.
  const [roleDraft, setRoleDraft] = useState<WorkspaceRole>(member.role);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const detailHref = `/${workspaceSlug}/settings/members/${member.userId}`;

  return (
    <li
      className={`relative flex flex-col gap-3 px-3 py-2.5 text-sm ${
        canManage ? "hover:bg-interactive-state-hover transition-colors" : ""
      }`}
    >
      {/* Stretched link: clicking anywhere on the row opens the member
          detail. The right-side controls are raised to z-10 so they
          stay independently clickable. Admin-only (the detail page is
          admin-gated). */}
      {canManage && (
        <Link
          href={detailHref}
          aria-label={`View ${member.name ?? member.email}`}
          className="absolute inset-0"
        />
      )}
      <div className="flex w-full items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="text-foreground truncate font-medium">
              {member.name ?? member.email}
            </span>
            {isSelf && (
              <span className="text-foreground-muted text-sm">(you)</span>
            )}
          </div>
          <div className="text-foreground-weak flex items-center gap-2 text-sm">
            {member.name && <span className="truncate">{member.email}</span>}
            <span className="text-foreground-muted">
              joined <LocalTime iso={member.joinedAt.toISOString()} />
            </span>
          </div>
          {(changeState.error || removeState.error) && (
            <p className="text-sentiment-negative text-sm" role="alert">
              {changeState.error ?? removeState.error}
            </p>
          )}
        </div>

        <div className="relative z-10 flex shrink-0 items-center gap-3">
          {canManage ? (
            <form action={changeAction}>
              <input type="hidden" name="workspace" value={workspaceSlug} />
              <input type="hidden" name="user_id" value={member.userId} />
              <select
                name="role"
                value={roleDraft}
                onChange={(e) => {
                  const next = e.target.value as WorkspaceRole;
                  setRoleDraft(next);
                  // Submit immediately on change — same UX as the
                  // automation toggle.
                  e.currentTarget.form?.requestSubmit();
                }}
                disabled={changePending}
                className="bg-input text-foreground hover:bg-input-hover focus:bg-input-active focus-visible:shadow-focus-ring disabled:bg-input-disabled rounded-lg shadow-[0_0_0_1px_var(--color-border)] py-1 px-2 text-sm focus:outline-none transition-[background-color,box-shadow,color] duration-150"
              >
                {ROLE_DESCRIPTIONS.map((r) => (
                  <option key={r.role} value={r.role}>
                    {r.label}
                  </option>
                ))}
              </select>
            </form>
          ) : (
            <Badge variant={roleVariant(member.role)} size="small">
              {roleLabel(member.role)}
            </Badge>
          )}

          {canManage && !confirmingRemove && (
            <button
              type="button"
              aria-expanded={false}
              onClick={() => setConfirmingRemove(true)}
              className="text-sentiment-negative text-sm hover:underline"
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {canManage && confirmingRemove && (
        <form
          action={removeAction}
          className="border-sentiment-negative/40 bg-surface-raised relative z-10 flex flex-col gap-3 rounded-lg border p-3"
        >
          <input type="hidden" name="workspace" value={workspaceSlug} />
          <input type="hidden" name="user_id" value={member.userId} />
          <p className="text-foreground text-sm">
            {ownedAutomationCount > 0 ? (
              <>
                <strong>
                  {ownedAutomationCount}{" "}
                  {ownedAutomationCount === 1 ? "automation runs" : "automations run"}{" "}
                  as this member.
                </strong>{" "}
                Reassign {ownedAutomationCount === 1 ? "it" : "them"} now,
                or pause enabled schedules when removing the member.
              </>
            ) : (
              <>Remove {member.name ?? member.email} from this workspace?</>
            )}
          </p>

          {ownedAutomationCount > 0 && (
            <label className="flex max-w-md flex-col gap-1">
              <span className="text-foreground text-sm font-medium">
                Automation owner after removal
              </span>
              <select
                name="reassign_user_id"
                defaultValue=""
                disabled={removePending}
                className="bg-input text-foreground hover:bg-input-hover focus:bg-input-active focus-visible:shadow-focus-ring disabled:bg-input-disabled rounded-lg border-0 px-3 py-2 text-sm shadow-[0_0_0_1px_var(--color-border)] focus:outline-none"
              >
                <option value="">Pause enabled schedules</option>
                {reassignmentCandidates.map((candidate) => (
                  <option key={candidate.userId} value={candidate.userId}>
                    Reassign to {candidate.label}
                  </option>
                ))}
              </select>
              <span className="text-foreground-weak text-sm">
                Paused schedules keep their current owner until an admin edits
                and reassigns them.
              </span>
            </label>
          )}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={removePending}
              className="text-sentiment-negative text-sm font-medium hover:underline disabled:opacity-60"
            >
              {removePending ? "Removing…" : "Remove member"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingRemove(false)}
              disabled={removePending}
              className="text-foreground-weak hover:text-foreground text-sm disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </li>
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

function roleLabel(role: WorkspaceRole): string {
  return ROLE_DESCRIPTIONS.find((r) => r.role === role)?.label ?? role;
}
