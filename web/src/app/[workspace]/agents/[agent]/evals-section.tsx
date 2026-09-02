import Link from "next/link";

import { LocalTime } from "@/components/local-time";
import { Section } from "@/components/section";
import { Badge } from "@/components/ui/badge";
import type { AgentEvalRun } from "@/lib/agent-evals-db";

import { EvalPoller } from "./eval-poller";
import { RunEvalsButton } from "./run-evals-button";

export function EvalsSection({
  latest,
  hasEvalFile,
  evalPath,
  parseError,
  canRun,
  hasStable,
  workspaceSlug,
  agentName,
}: {
  latest: AgentEvalRun | null;
  hasEvalFile: boolean;
  evalPath: string | null;
  parseError: string | null;
  canRun: boolean;
  hasStable: boolean;
  workspaceSlug: string;
  agentName: string;
}) {
  const inFlight =
    latest && (latest.status === "queued" || latest.status === "running");

  return (
    <Section
      title="Evals"
      description="Regression checks from a colocated eval file. CI runs them on authoring PRs; you can also run the draft or current stable here."
      actions={
        canRun && hasEvalFile ? (
          <div className="flex flex-wrap gap-2">
            <RunEvalsButton
              workspaceSlug={workspaceSlug}
              agentName={agentName}
              version="draft"
              disabled={Boolean(inFlight)}
              disabledReason="An eval is already running."
            />
            <RunEvalsButton
              workspaceSlug={workspaceSlug}
              agentName={agentName}
              version="stable"
              disabled={Boolean(inFlight) || !hasStable}
              disabledReason={
                !hasStable
                  ? "Promote a stable version first."
                  : "An eval is already running."
              }
            />
          </div>
        ) : undefined
      }
    >
      {inFlight && latest ? <EvalPoller status={latest.status} /> : null}
      {!hasEvalFile ? (
        <p className="text-foreground-weak rounded-lg border border-dashed border-[var(--color-border)] px-4 py-6 text-center text-sm">
          No eval file yet. Add a sidecar next to the spec (for example{" "}
          <code className="text-foreground-muted">
            {evalPath ?? "<name>.eval.yaml"}
          </code>
          ) to gate authoring PRs.
        </p>
      ) : parseError ? (
        <p className="text-sentiment-negative text-sm" role="alert">
          Eval file is invalid: {parseError}
        </p>
      ) : !latest ? (
        <p className="text-foreground-weak rounded-lg border border-dashed border-[var(--color-border)] px-4 py-6 text-center text-sm">
          Eval file found
          {evalPath ? (
            <>
              {" "}
              at <code className="text-foreground-muted">{evalPath}</code>
            </>
          ) : null}
          . Run it against the draft or wait for CI on the next authoring PR.
        </p>
      ) : (
        <EvalResult latest={latest} workspaceSlug={workspaceSlug} agentName={agentName} />
      )}
    </Section>
  );
}

function EvalResult({
  latest,
  workspaceSlug,
  agentName,
}: {
  latest: AgentEvalRun;
  workspaceSlug: string;
  agentName: string;
}) {
  const badge = statusBadge(latest.status);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={badge.variant} size="small">
          {badge.label}
        </Badge>
        <span className="text-foreground-muted text-sm">
          {latest.agentVersionLabel}
          {latest.source === "ci" ? " · CI" : latest.source === "manual" ? " · manual" : " · API"}
          {" · "}
          <LocalTime iso={latest.createdAt.toISOString()} style="relative" />
        </span>
        {latest.status === "passed" || latest.status === "failed" ? (
          <span className="text-foreground-muted text-sm">
            {latest.passedCount} passed · {latest.failedCount} failed
          </span>
        ) : null}
      </div>
      {latest.errorMessage && (
        <p className="text-sentiment-negative text-sm">{latest.errorMessage}</p>
      )}
      {latest.caseResults.length > 0 && (
        <ul className="divide-border flex flex-col divide-y border-y border-[var(--color-border)]">
          {latest.caseResults.map((c) => (
            <li key={c.name} className="flex items-start justify-between gap-3 py-2.5">
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-foreground font-medium">{c.name}</span>
                  <Badge variant={c.passed ? "green" : "red"} size="small">
                    {c.passed ? "Pass" : "Fail"}
                  </Badge>
                </div>
                <p className="text-foreground-weak line-clamp-2 text-sm">{c.reason}</p>
              </div>
              {c.runId ? (
                <Link
                  href={`/${workspaceSlug}/agents/${encodeURIComponent(agentName)}/runs/${c.runId}`}
                  className="text-foreground-weak hover:text-foreground shrink-0 text-sm"
                >
                  Run →
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function statusBadge(status: AgentEvalRun["status"]): {
  variant: "green" | "red" | "yellow" | "gray";
  label: string;
} {
  switch (status) {
    case "passed":
      return { variant: "green", label: "Passed" };
    case "failed":
      return { variant: "red", label: "Failed" };
    case "error":
      return { variant: "red", label: "Error" };
    case "running":
      return { variant: "yellow", label: "Running" };
    default:
      return { variant: "gray", label: "Queued" };
  }
}
