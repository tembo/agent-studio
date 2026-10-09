"use client";

import { useActionState, useState } from "react";

import { MemberPicker } from "@/components/member-picker";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { MemberChoice } from "@/lib/member-choice";
import { useActionToast } from "@/lib/use-action-toast";

import {
  runAgentEvalsAction,
  type RunEvalsFormState,
} from "./evals-actions";

const INITIAL: RunEvalsFormState = {};

export function RunEvalsButton({
  workspaceSlug,
  agentName,
  version,
  canRunAsOthers,
  currentMember,
  disabled,
  disabledReason,
}: {
  workspaceSlug: string;
  agentName: string;
  version: "draft" | "stable";
  canRunAsOthers: boolean;
  currentMember: MemberChoice;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const [runAs, setRunAs] = useState(currentMember);
  const [state, formAction, pending] = useActionState(
    async (previous: RunEvalsFormState, formData: FormData) => {
      const result = await runAgentEvalsAction(previous, formData);
      if (result.message) {
        setOpen(false);
        setRunAs(currentMember);
      }
      return result;
    },
    INITIAL,
  );
  useActionToast(state);

  const label = version === "draft" ? "Run evals on draft" : "Run evals on stable";

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setRunAs(currentMember);
      }}
    >
      <AlertDialogTrigger asChild>
        <Button
          variant="secondary"
          disabled={disabled || pending}
          title={disabled ? disabledReason : undefined}
        >
          {pending ? "Starting…" : label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{label}</AlertDialogTitle>
          <AlertDialogDescription>
            Run the eval file against the {version} of {agentName}.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <form action={formAction} className="flex flex-col gap-3">
          <input type="hidden" name="workspace" value={workspaceSlug} />
          <input type="hidden" name="agent" value={agentName} />
          <input type="hidden" name="version" value={version} />
          {canRunAsOthers && (
            <div className="flex flex-col gap-1.5">
              <MemberPicker
                workspaceSlug={workspaceSlug}
                name="run_as"
                value={runAs}
                onChange={setRunAs}
                disabled={pending}
              />
              <p className="text-foreground-muted text-sm">
                Every eval case uses this member&apos;s connections.
              </p>
            </div>
          )}
          {state.error && (
            <p className="text-sentiment-negative text-sm" role="alert">
              {state.error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="ghost" size="big" disabled={pending}>
                Cancel
              </Button>
            </AlertDialogCancel>
            <Button type="submit" variant="primary" size="big" disabled={disabled || pending}>
              {pending ? "Starting…" : "Run evals"}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
