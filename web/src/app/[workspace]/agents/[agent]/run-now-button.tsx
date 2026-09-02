"use client";

// "Run now" used to fire immediately with no input. Most agents
// benefit from a user message, so the button now opens a small
// dialog with a textarea before queueing the run. Empty input is
// still allowed — preserves the prior "exercise the agent's
// instructions only" behavior.

import { useActionState, useState } from "react";
import { useActionToast } from "@/lib/use-action-toast";

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

import { runNowAction, type RunNowFormState } from "./actions";
import { runNowVersionChoice } from "./run-now-version";

const INITIAL: RunNowFormState = {};

type Props = {
  workspaceSlug: string;
  agentName: string;
  /** Provided for workspace admins → a "Run as" picker. Members run as
   *  themselves and don't get this. */
  members?: { userId: string; name: string | null; email: string }[];
  currentUserId: string;
  /** When the agent has a stable version, offer it when a pending draft exists. */
  stableVersion?: number;
  /** True when the live file differs from the current stable snapshot. */
  hasDraft: boolean;
  /** Null when dry run is available; otherwise the reason the checkbox is disabled. */
  dryRunUnavailableReason?: string | null;
};

export function RunNowButton({
  workspaceSlug,
  agentName,
  members,
  currentUserId,
  stableVersion,
  hasDraft,
  dryRunUnavailableReason = null,
}: Props) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(runNowAction, INITIAL);
  useActionToast(state);
  // Controlled — React 19's useActionState resets uncontrolled fields
  // after each submission, including the returned-error path. Reset
  // when the dialog closes so reopening starts fresh.
  const versionChoice = runNowVersionChoice({ stableVersion, hasDraft });
  const defaultRunVersion =
    versionChoice === "stable-only" ? "stable" : "draft";
  const [userMessage, setUserMessage] = useState("");
  const [runAs, setRunAs] = useState(currentUserId);
  const [runVersion, setRunVersion] =
    useState<"stable" | "draft">(defaultRunVersion);
  const [dryRun, setDryRun] = useState(false);
  const showRunAs = members !== undefined && members.length > 1;
  const dryRunAvailable = !dryRunUnavailableReason;

  return (
    <div className="flex flex-col items-end gap-1">
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setUserMessage("");
            setRunAs(currentUserId);
            setRunVersion(defaultRunVersion);
            setDryRun(false);
          }
        }}
      >
        <AlertDialogTrigger asChild>
          <Button variant="primary" disabled={pending}>
            {pending ? "Queueing…" : "Run now"}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run {agentName}</AlertDialogTitle>
            <AlertDialogDescription>
              Optional message to pass to the agent as the user input. Leave
              blank to run the agent on its instructions alone.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <form action={formAction} className="flex flex-col gap-3">
            <input type="hidden" name="workspace" value={workspaceSlug} />
            <input type="hidden" name="agent" value={agentName} />
            <input type="hidden" name="run_version" value={runVersion} />
            <input type="hidden" name="dry_run" value={dryRun ? "1" : "0"} />
            {versionChoice === "draft-only" ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-foreground-weak text-sm">Version</span>
                <p className="text-foreground text-sm font-medium">
                  Draft (current file)
                </p>
                <p className="text-foreground-muted text-sm">
                  No stable version has been promoted yet.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <span className="text-foreground-weak text-sm">Version</span>
                <div className="flex gap-2">
                  {versionChoice === "choose" && (
                    <button
                      type="button"
                      onClick={() => setRunVersion("draft")}
                      disabled={pending}
                      aria-pressed={runVersion === "draft"}
                      className={
                        runVersion === "draft"
                          ? "bg-interactive text-foreground-on-accent border-interactive rounded-md border px-3 py-1 text-sm font-medium"
                          : "text-foreground hover:bg-surface-raised border-border rounded-md border px-3 py-1 text-sm font-medium"
                      }
                    >
                      Draft (current file)
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setRunVersion("stable")}
                    disabled={pending}
                    aria-pressed={runVersion === "stable"}
                    className={
                      runVersion === "stable"
                        ? "bg-interactive text-foreground-on-accent border-interactive rounded-md border px-3 py-1 text-sm font-medium"
                        : "text-foreground hover:bg-surface-raised border-border rounded-md border px-3 py-1 text-sm font-medium"
                    }
                  >
                    Stable v{stableVersion}
                  </button>
                </div>
                <p className="text-foreground-muted text-sm">
                  {runVersion === "stable"
                    ? `Runs the promoted stable v${stableVersion} snapshot.`
                    : "Runs the live draft from the repository's default branch."}
                </p>
              </div>
            )}
            <label className="flex flex-col gap-1.5">
              <span className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={dryRun}
                  disabled={pending || !dryRunAvailable}
                  onChange={(e) => setDryRun(e.target.checked)}
                  className="border-border size-4 rounded"
                />
                <span className="text-foreground-weak text-sm">Dry run</span>
              </span>
              <p className="text-foreground-muted text-sm">
                {dryRunUnavailableReason ??
                  "Blocks this agent's declared delivery (email, Slack, inbox, …). Other tools may still make changes. Recorded on this agent with a Dry run badge and excluded from success-rate metrics."}
              </p>
            </label>
            {showRunAs && (
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="run-as"
                  className="text-foreground-weak text-sm"
                >
                  Run as
                </label>
                <select
                  id="run-as"
                  name="run_as"
                  value={runAs}
                  onChange={(e) => setRunAs(e.target.value)}
                  disabled={pending}
                  className="bg-input text-foreground hover:bg-input-hover focus:bg-input-active focus-visible:shadow-focus-ring disabled:bg-input-disabled rounded-lg px-3 py-2 text-sm leading-6 shadow-[0_0_0_1px_var(--color-border)] transition-[background-color,box-shadow,color] duration-150 focus:outline-none"
                >
                  {members!.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {(m.name ?? m.email) +
                        (m.userId === currentUserId ? " (you)" : "")}
                    </option>
                  ))}
                </select>
                <p className="text-foreground-muted text-sm">
                  The run uses this member&apos;s connections.
                </p>
              </div>
            )}
            <textarea
              name="user_message"
              rows={5}
              disabled={pending}
              autoFocus
              placeholder="What should the agent do for this run?"
              value={userMessage}
              onChange={(e) => setUserMessage(e.target.value)}
              className="bg-input text-foreground-strong placeholder:text-foreground-weak hover:bg-input-hover focus:bg-input-active focus-visible:shadow-focus-ring disabled:bg-input-disabled flex w-full min-w-0 rounded-lg shadow-[0_0_0_1px_var(--color-border)] py-2 px-3 text-sm leading-6 focus:outline-none transition-[background-color,box-shadow,color] duration-150 resize-y"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
                }
              }}
            />
            <p className="text-foreground-weak text-sm">
              Cmd/Ctrl-Enter submits.
            </p>
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
              {/* Plain submit — deliberately NOT AlertDialogAction. Radix's
                  Action dismisses (unmounts) the dialog the instant it's
                  clicked, which raced the form submission and dropped the
                  textarea's user_message (the agent then saw an empty input).
                  runNowAction redirects on success (dialog unmounts via nav)
                  and returns an error on failure (dialog stays open). */}
              <Button
                type="submit"
                variant="primary"
                size="big"
                disabled={pending}
              >
                {pending ? "Queueing…" : "Run"}
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
      {state.error && (
        <p className="text-sentiment-negative max-w-xs text-right text-sm">
          {state.error}
        </p>
      )}
    </div>
  );
}
