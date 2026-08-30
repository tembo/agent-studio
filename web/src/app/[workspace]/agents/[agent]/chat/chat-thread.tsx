"use client";

// Chat-to-edit thread for an agent.
//
// Two distinct intents share a single composer:
//
//   "Test agent"           → runs the agent with the typed message
//                             so the user can probe its behavior
//                             before deciding what to change.
//                             Cheap, frequent. Creates a Run row.
//
//   "Request change"       → packages the message and ships it to
//                             Tembo as a task → opens a PR for
//                             review. Slow, rare. Creates an
//                             improvement row tied to the agent
//                             (run_id=null).
//
// The thread renders runs (conversation turns) and improvements
// (change requests) interleaved chronologically. Any in-flight run
// (queued / running) triggers an auto-refresh so the agent's reply
// lands without the user reloading.

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { LocalTime } from "@/components/local-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { type ChatRun } from "@/lib/chat-runs-db";
import type { CommitMode } from "@/lib/commit-mode-constants";
import { improvementSubmitterLabel } from "@/lib/improvement-display";
import {
  type Improvement,
  type ImprovementDelivery,
  type ImprovementStatus,
} from "@/lib/improvements-api";
import { cn } from "@/lib/utils";
import { useMountEffect } from "@/lib/use-mount-effect";

import {
  chatSubmitAction,
  sendToAgentAction,
  type ChatSubmitResult,
  type SendToAgentResult,
} from "./actions";

export type ChatTurn =
  | { kind: "run"; createdAt: Date; run: ChatRun }
  | { kind: "improvement"; createdAt: Date; improvement: Improvement };

type ComposerIntent = "test" | "change";

const RECENT_TURN_COUNT = 6;
const COLLAPSE_TEXT_AFTER = 600;

export function ChatThread({
  workspaceSlug,
  agentName,
  turns,
  commitMode,
}: {
  workspaceSlug: string;
  agentName: string;
  turns: ChatTurn[];
  commitMode: CommitMode;
}) {
  const direct = commitMode === "direct";
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [intent, setIntent] = useState<ComposerIntent>("test");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Auto-refresh while any run is in flight so the agent's reply
  // shows up without the user reloading. Cleared as soon as
  // everything has settled.
  const hasInFlight = turns.some(
    (t) => t.kind === "run" && (t.run.status === "queued" || t.run.status === "running"),
  );
  const recentStart = Math.max(0, turns.length - RECENT_TURN_COUNT);
  const earlierTurns = turns.slice(0, recentStart);
  const recentTurns = turns.slice(recentStart);

  const onSendToAgent = () => {
    setError(null);
    startTransition(async () => {
      const r: SendToAgentResult = await sendToAgentAction({
        workspaceSlug,
        agentName,
        message,
      });
      if (r.ok) {
        setMessage("");
        router.refresh();
      } else {
        setError(r.error);
      }
    });
  };

  const onSubmitChange = () => {
    setError(null);
    startTransition(async () => {
      const r: ChatSubmitResult = await chatSubmitAction({
        workspaceSlug,
        agentName,
        message,
      });
      if (r.ok) {
        setMessage("");
        router.refresh();
      } else {
        setError(r.error);
      }
    });
  };

  const submitMessage = () => {
    if (pending || !message.trim()) return;
    if (intent === "change") {
      onSubmitChange();
    } else {
      onSendToAgent();
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {hasInFlight && <RunRefreshPoller />}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submitMessage();
        }}
        className="border-border bg-surface-raised sticky top-4 z-20 flex flex-col gap-3 rounded-lg border p-3 shadow-lg"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div
            className="border-border bg-surface flex items-center gap-1 rounded-lg border p-1"
            role="group"
            aria-label="Message intent"
          >
            <Button
              type="button"
              size="medium"
              variant={intent === "test" ? "secondary" : "ghost"}
              aria-pressed={intent === "test"}
              onClick={() => setIntent("test")}
              disabled={pending}
            >
              Test agent
            </Button>
            <Button
              type="button"
              size="medium"
              variant={intent === "change" ? "secondary" : "ghost"}
              aria-pressed={intent === "change"}
              onClick={() => setIntent("change")}
              disabled={pending}
            >
              Request change
            </Button>
          </div>
          <span className="text-foreground-weak text-sm">
            {intent === "test"
              ? "Runs the current agent without changing it."
              : direct
                ? "Commits this request directly to the default branch."
                : "Sends this request to open a PR for review."}
          </span>
        </div>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={
            intent === "test"
              ? "Message the current agent to test its behavior…"
              : "Describe the change you want the coding agent to make…"
          }
          rows={3}
          disabled={pending}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submitMessage();
            }
          }}
          className="bg-surface border-border text-foreground focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring-color,#009eff)] resize-y rounded-md border px-3 py-2 text-sm leading-6"
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-foreground-weak text-sm">
            Cmd/Ctrl-Enter uses the selected action.
          </span>
          <Button
            type="submit"
            variant="primary"
            disabled={pending || !message.trim()}
          >
            {pending
              ? intent === "test"
                ? "Sending…"
                : "Submitting…"
              : intent === "test"
                ? "Send test message"
                : "Submit change request"}
          </Button>
        </div>
        {error && (
          <div className="border-sentiment-negative bg-[var(--color-input-error)] flex flex-col gap-1 rounded-lg border p-3 text-sm">
            <span className="text-sentiment-negative font-medium">
              Couldn&apos;t send
            </span>
            <span className="text-foreground whitespace-pre-wrap text-sm leading-5">
              {error}
            </span>
          </div>
        )}
      </form>

      {turns.length === 0 ? (
        <EmptyState direct={direct} />
      ) : (
        <div className="flex flex-col gap-4">
          {earlierTurns.length > 0 && (
            <details className="border-border bg-surface-raised rounded-lg border">
              <summary className="text-foreground hover:bg-surface flex cursor-pointer items-center justify-between rounded-lg px-4 py-3 text-sm font-medium">
                Earlier activity
                <span className="text-foreground-muted font-normal">
                  {earlierTurns.length} {earlierTurns.length === 1 ? "turn" : "turns"}
                </span>
              </summary>
              <TurnList
                turns={earlierTurns}
                workspaceSlug={workspaceSlug}
                agentName={agentName}
                className="border-border border-t px-4 py-4"
              />
            </details>
          )}
          <TurnList
            turns={recentTurns}
            workspaceSlug={workspaceSlug}
            agentName={agentName}
          />
        </div>
      )}
    </div>
  );
}

function RunRefreshPoller() {
  const router = useRouter();
  useMountEffect(() => {
    const id = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(id);
  });
  return null;
}

function TurnList({
  turns,
  workspaceSlug,
  agentName,
  className,
}: {
  turns: ChatTurn[];
  workspaceSlug: string;
  agentName: string;
  className?: string;
}) {
  return (
    <ul className={cn("flex flex-col gap-4", className)}>
      {turns.map((turn) =>
        turn.kind === "run" ? (
          <RunBubble key={`r:${turn.run.id}`} run={turn.run} />
        ) : (
          <ImprovementBubble
            key={`i:${turn.improvement.id}`}
            improvement={turn.improvement}
            workspaceSlug={workspaceSlug}
            agentName={agentName}
          />
        ),
      )}
    </ul>
  );
}

function EmptyState({ direct }: { direct: boolean }) {
  return (
    <div className="text-foreground-weak rounded-lg border border-dashed border-[var(--color-border-weak)] bg-surface-raised px-4 py-6 text-center text-sm">
      Talk to the agent, or describe a change you&apos;d like to make. Each
      change request{" "}
      {direct
        ? "is committed directly to the default branch."
        : "opens a pull request for review."}
    </div>
  );
}

function RunBubble({ run }: { run: ChatRun }) {
  return (
    <li className="flex flex-col gap-2">
      {/* User message — right-aligned. */}
      <div className="flex justify-end">
        <div className="bg-interactive text-foreground-on-accent flex max-w-[80%] flex-col gap-1 rounded-lg px-3 py-2">
          <CollapsibleText
            text={run.userMessage}
            className="text-foreground-on-accent"
          />
          <span className="text-foreground-on-accent/70 text-sm">
            <LocalTime iso={run.createdAt.toISOString()} />
          </span>
        </div>
      </div>

      {/* Agent reply — left-aligned. Shows a pending state while
          the run is in flight; renders the output once it lands. */}
      <div className="flex justify-start">
        <div className="border-border bg-surface-raised flex max-w-[80%] flex-col gap-1 rounded-lg border px-3 py-2">
          {run.status === "queued" || run.status === "running" ? (
            <p className="text-foreground-weak text-base italic">
              {run.status === "queued" ? "Queued…" : "Thinking…"}
            </p>
          ) : run.status === "failed" ? (
            <p className="text-sentiment-negative whitespace-pre-wrap text-sm leading-5">
              {run.errorMessage ?? "Run failed."}
            </p>
          ) : (
            <CollapsibleText text={stripStopReason(run.output)} />
          )}
        </div>
      </div>
    </li>
  );
}

function ImprovementBubble({
  improvement,
  workspaceSlug,
  agentName,
}: {
  improvement: Improvement;
  workspaceSlug: string;
  agentName: string;
}) {
  const runHref = improvement.runId
    ? `/${workspaceSlug}/agents/${encodeURIComponent(agentName)}/runs/${improvement.runId}`
    : null;
  return (
    <li className="flex flex-col gap-2">
      {/* User change request — right-aligned, with a label badge so
          it visually reads as different from a normal chat turn. */}
      <div className="flex justify-end">
        <div className="bg-interactive text-foreground-on-accent flex max-w-[80%] flex-col gap-1 rounded-lg px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-foreground-on-accent/80 text-sm uppercase tracking-wide">
              Change request
            </span>
          </div>
          <CollapsibleText
            text={improvement.improvementText}
            className="text-foreground-on-accent"
          />
          <span className="text-foreground-on-accent/70 text-sm">
            {improvementSubmitterLabel(improvement)} ·{" "}
            <LocalTime iso={improvement.createdAt.toISOString()} />
            {runHref && (
              <>
                {" · "}
                <a href={runHref} className="underline">
                  from run
                </a>
              </>
            )}
          </span>
        </div>
      </div>

      {/* PR / Tembo status reply — left-aligned. */}
      <div className="flex justify-start">
        <div
          className={cn(
            "border-border bg-surface-raised flex max-w-[80%] flex-col gap-1.5 rounded-lg border px-3 py-2",
          )}
        >
          <div className="flex items-center gap-2">
            <StatusBadge status={improvement.status} />
            {improvement.prNumber && improvement.prUrl && (
              <a
                href={improvement.prUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-foreground text-sm font-medium hover:underline"
              >
                PR #{improvement.prNumber} ↗
              </a>
            )}
            {improvement.commitUrl && (
              <a
                href={improvement.commitUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-foreground text-sm font-medium hover:underline"
              >
                View commit ↗
              </a>
            )}
            {improvement.temboTaskHtmlUrl && (
              <a
                href={improvement.temboTaskHtmlUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-foreground-weak text-sm hover:underline"
              >
                Tembo Session ↗
              </a>
            )}
          </div>
          <p className="text-foreground-weak text-sm leading-5">
            {statusBlurb(improvement.status, improvement.delivery)}
          </p>
        </div>
      </div>
    </li>
  );
}

function CollapsibleText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  if (text.length <= COLLAPSE_TEXT_AFTER && text.split("\n").length <= 12) {
    return (
      <p className={cn("text-foreground whitespace-pre-wrap text-sm leading-5", className)}>
        {text}
      </p>
    );
  }

  return (
    <details className="group">
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <span
          className={cn(
            "text-foreground whitespace-pre-wrap text-sm leading-5 group-open:hidden",
            className,
          )}
        >
          {previewText(text)}
        </span>
        <span className={cn("mt-1 block text-sm underline underline-offset-2", className)}>
          <span className="group-open:hidden">Show full message</span>
          <span className="hidden group-open:inline">Hide full message</span>
        </span>
      </summary>
      <p className={cn("text-foreground mt-2 whitespace-pre-wrap text-sm leading-5", className)}>
        {text}
      </p>
    </details>
  );
}

function previewText(text: string): string {
  const compact = text.slice(0, 320).trimEnd();
  const lastSpace = compact.lastIndexOf(" ");
  const preview = lastSpace > 240 ? compact.slice(0, lastSpace) : compact;
  return `${preview}…`;
}

function statusBlurb(
  status: ImprovementStatus,
  delivery: ImprovementDelivery,
): string {
  switch (status) {
    case "submitted":
      return delivery === "direct"
        ? "Sent to Tembo. Committing directly to the default branch."
        : "Sent to Tembo. Waiting for the coding agent to open a PR.";
    case "pr_opened":
      return "Pull request is open and ready for review.";
    case "merged":
      return "Pull request was merged — the change is live on the default branch.";
    case "committed":
      return "Committed directly to the default branch.";
    case "closed":
      return "Pull request was closed without merging.";
  }
}

function StatusBadge({ status }: { status: ImprovementStatus }) {
  switch (status) {
    case "submitted":
      return (
        <Badge variant="gray" size="small">
          Submitted
        </Badge>
      );
    case "pr_opened":
      return (
        <Badge variant="blue" size="small">
          PR opened
        </Badge>
      );
    case "merged":
      return (
        <Badge variant="green" size="small">
          Merged
        </Badge>
      );
    case "committed":
      return (
        <Badge variant="green" size="small">
          Committed
        </Badge>
      );
    case "closed":
      return (
        <Badge variant="red" size="small">
          Closed
        </Badge>
      );
  }
}

// Pre-088a1d1 runs were stored with a "[stop_reason=...]" suffix.
// Strip it on read so historical chat turns render cleanly.
function stripStopReason(output: string): string {
  return output.replace(/\n*\[stop_reason=[^\]]*\]\s*$/, "");
}
