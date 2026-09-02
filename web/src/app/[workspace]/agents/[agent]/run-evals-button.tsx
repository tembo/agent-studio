"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
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
  disabled,
  disabledReason,
}: {
  workspaceSlug: string;
  agentName: string;
  version: "draft" | "stable";
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [state, formAction, pending] = useActionState(
    runAgentEvalsAction,
    INITIAL,
  );
  useActionToast(state);

  const label = version === "draft" ? "Run evals on draft" : "Run evals on stable";

  return (
    <form action={formAction}>
      <input type="hidden" name="workspace" value={workspaceSlug} />
      <input type="hidden" name="agent" value={agentName} />
      <input type="hidden" name="version" value={version} />
      <Button
        type="submit"
        variant="secondary"
        disabled={disabled || pending}
        title={disabled ? disabledReason : undefined}
      >
        {pending ? "Starting…" : label}
      </Button>
    </form>
  );
}
