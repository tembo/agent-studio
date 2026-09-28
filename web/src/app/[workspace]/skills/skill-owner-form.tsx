"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

import { changeSkillOwnerAction } from "./owner-actions";

export function SkillOwnerForm({
  workspaceSlug,
  skillName,
  members,
}: {
  workspaceSlug: string;
  skillName: string;
  members: { userId: string; name: string }[];
}) {
  const [state, action, pending] = useActionState(changeSkillOwnerAction, {});

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="workspace" value={workspaceSlug} />
      <input type="hidden" name="name" value={skillName} />
      <Label htmlFor="skill-owner">Change owner</Label>
      <div className="flex flex-wrap gap-2">
        <select
          id="skill-owner"
          name="ownerUserId"
          defaultValue=""
          required
          disabled={pending || members.length === 0}
          className="border-border bg-surface-raised text-foreground rounded-md border px-3 py-2 text-sm"
        >
          <option value="" disabled>Choose a workspace member</option>
          {members.map((member) => (
            <option key={member.userId} value={member.userId}>{member.name}</option>
          ))}
        </select>
        <Button type="submit" disabled={pending || members.length === 0}>
          {pending ? "Saving…" : "Change owner"}
        </Button>
      </div>
      {members.length === 0 && (
        <p className="text-foreground-weak text-sm">No other workspace members are available.</p>
      )}
      {state.error && <p className="text-sentiment-negative text-sm" role="alert">{state.error}</p>}
      {state.message && <p className="text-sentiment-positive text-sm" role="status">{state.message}</p>}
    </form>
  );
}
