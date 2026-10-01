"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { saveFeaturesAction, type FeaturesState } from "./actions";

const INITIAL: FeaturesState = {};

export function FeaturesForm({ workspaceSlug, enabled, canEdit }: {
  workspaceSlug: string;
  enabled: boolean;
  canEdit: boolean;
}) {
  const [state, formAction, pending] = useActionState(saveFeaturesAction, INITIAL);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="workspace" value={workspaceSlug} />
      <label className="flex items-center gap-3 text-sm font-medium">
        <input
          key={String(enabled)}
          type="checkbox"
          name="text_messages_enabled"
          defaultChecked={enabled}
          disabled={!canEdit || pending}
          aria-describedby="text-messages-description"
          className="size-4 accent-primary"
        />
        Enable Text Messages
      </label>
      <p id="text-messages-description" className="text-foreground-weak text-sm">
        Show Text messages in the navigation for everyone in this workspace.
        Hiding it does not pause existing text numbers or incoming messages.
      </p>
      {canEdit ? (
        <Button type="submit" disabled={pending} className="w-fit">
          {pending ? "Saving…" : "Save"}
        </Button>
      ) : (
        <p className="text-foreground-weak text-sm">Only workspace admins can change features.</p>
      )}
      {state.error && <p role="alert" className="text-sentiment-negative text-sm">{state.error}</p>}
      {state.message && <p role="status" className="text-sentiment-positive text-sm">{state.message}</p>}
    </form>
  );
}
