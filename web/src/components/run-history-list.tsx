import Link from "next/link";
import type { ReactNode } from "react";

import { LocalTime } from "@/components/local-time";
import { Badge } from "@/components/ui/badge";
import { runIdentityLabel } from "@/lib/run-identity";
import { type RunSummary } from "@/lib/runs-db";

const STATUS_LABELS: Record<RunSummary["status"], string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STATUS_TONE: Record<
  RunSummary["status"],
  { variant: "blue" | "yellow" | "green" | "red" | "gray" }
> = {
  queued: { variant: "yellow" },
  running: { variant: "blue" },
  succeeded: { variant: "green" },
  failed: { variant: "red" },
  cancelled: { variant: "gray" },
};

export function RunHistoryList({
  runs,
  workspaceSlug,
  emptyMessage,
}: {
  runs: RunSummary[];
  workspaceSlug: string;
  emptyMessage: ReactNode;
}) {
  if (runs.length === 0) {
    return (
      <p className="text-foreground-weak rounded-lg border border-dashed border-[var(--color-border)] px-4 py-6 text-center text-sm">
        {emptyMessage}
      </p>
    );
  }

  return (
    <ul className="divide-border flex flex-col divide-y border-y border-[var(--color-border)]">
      {runs.map((run) => {
        const tone = STATUS_TONE[run.status];
        const identity = runIdentityLabel(
          run.createdByName,
          run.createdByEmail,
        );
        const href = `/${workspaceSlug}/agents/${encodeURIComponent(run.agentName)}/runs/${run.id}`;
        return (
          <li key={run.id}>
            <Link
              href={href}
              className="hover:bg-background-weak flex items-center justify-between gap-3 px-1 py-2"
            >
              <span className="flex min-w-0 items-center gap-3">
                <Badge variant={tone.variant} size="small">
                  {STATUS_LABELS[run.status]}
                </Badge>
                <Badge
                  variant={
                    run.runEnvironment === "production" ? "gray" : "yellow"
                  }
                  size="small"
                >
                  {run.runEnvironment === "production" ? "Production" : "Development"}
                </Badge>
                {run.trigger === "schedule" && (
                  <Badge variant="blue" size="small">
                    Scheduled
                  </Badge>
                )}
                {run.trigger === "event" && (
                  <Badge variant="purple" size="small">
                    Event
                  </Badge>
                )}
                {run.isDryRun && (
                  <Badge variant="orange" size="small">
                    Dry run
                  </Badge>
                )}
                <span className="flex min-w-0 flex-col">
                  <LocalTime
                    iso={run.createdAt.toISOString()}
                    className="text-foreground-muted text-sm"
                  />
                  <span
                    className="text-foreground-muted truncate text-xs"
                    title={identity}
                  >
                    Run as {identity}
                  </span>
                </span>
              </span>
              <span className="text-foreground-weak hover:text-foreground shrink-0 text-sm">
                Open →
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
