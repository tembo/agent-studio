import Link from "next/link";

import type { WorkspaceRole } from "@/lib/rbac";
import type { RunRecord } from "@/lib/runs-api";

import { CopyOutputButton } from "./copy-output-button";

export function FailedReason({
  run,
  workspaceSlug,
  role,
}: {
  run: RunRecord;
  workspaceSlug: string;
  role: WorkspaceRole;
}) {
  const summary = run.failureSummary ?? "The run ended unexpectedly.";
  const recommendation =
    role === "viewer"
      ? viewerRecommendation(run.failureCode)
      : (run.failureRecommendation ??
        "Try again. If it keeps failing, ask a workspace admin to investigate.");
  const errorSearchTerm = summary.slice(0, 80).trim();
  const similarHref = `/${workspaceSlug}/runs?${new URLSearchParams({
    status: "failed",
    agent: run.agentName,
    q: errorSearchTerm,
  }).toString()}`;
  const failureGroupsHref = `/${workspaceSlug}/agents/${encodeURIComponent(run.agentName)}#failures`;
  const action = recoveryAction(run.failureCode, workspaceSlug, run.agentName, role);

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-lg border border-[var(--color-sentiment-negative)] bg-[var(--color-input-error)] p-4 text-sm">
      <div className="flex flex-col gap-1">
        <span className="text-sentiment-negative font-medium">Run failed</span>
        <p className="text-foreground font-medium">{summary}</p>
        <p className="text-foreground-weak">{recommendation}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {action && (
          <Link
            href={action.href}
            className="bg-interactive text-foreground-on-accent hover:bg-interactive-hover rounded-md px-3 py-1.5 font-medium"
          >
            {action.label}
          </Link>
        )}
        {errorSearchTerm && (
          <Link
            href={similarHref}
            className="text-foreground hover:underline"
          >
            Find similar runs →
          </Link>
        )}
        <Link
          href={failureGroupsHref}
          className="text-foreground-weak hover:text-foreground hover:underline"
        >
          View {run.agentName} failure groups →
        </Link>
      </div>
      {run.errorMessage && (
        <details className="border-border mt-1 border-t pt-3">
          <summary className="text-foreground cursor-pointer font-medium">
            Technical details
          </summary>
          <div className="group relative mt-3 rounded-md bg-surface-raised p-3">
            <div className="absolute right-2 top-2 z-10 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
              <CopyOutputButton
                text={run.errorMessage}
                ariaLabel="Copy technical details to clipboard"
              />
            </div>
            <pre className="text-foreground max-h-96 overflow-auto whitespace-pre-wrap pr-8 font-mono text-sm leading-5">
              {run.errorMessage}
            </pre>
          </div>
        </details>
      )}
    </div>
  );
}

function viewerRecommendation(failureCode: string | null): string {
  switch (failureCode) {
    case "connection_stale":
    case "connection_required":
      return "Ask an operator or workspace admin to reconnect the required service.";
    case "agent_configuration":
      return "Ask an operator or workspace admin to review the agent definition.";
    case "rate_limited":
    case "provider_unavailable":
    case "run_start_failed":
    case "interrupted":
      return "Ask an operator or workspace admin to run the agent again.";
    default:
      return "Ask a workspace admin to investigate.";
  }
}

function recoveryAction(
  failureCode: string | null,
  workspaceSlug: string,
  agentName: string,
  role: WorkspaceRole,
): { label: string; href: string } | null {
  if (role === "viewer") return null;

  switch (failureCode) {
    case "connection_stale":
    case "connection_required":
      return { label: "Open connections", href: `/${workspaceSlug}/connections` };
    case "connection_provider_setup":
      return role === "workspace_admin"
        ? {
            label: "Configure connection provider",
            href: `/${workspaceSlug}/connections/providers`,
          }
        : null;
    case "provider_credentials":
      return role === "workspace_admin"
        ? {
            label: "Open LLM provider settings",
            href: `/${workspaceSlug}/settings/providers`,
          }
        : null;
    case "agent_configuration":
      return {
        label: "Review agent definition",
        href: `/${workspaceSlug}/agents/${encodeURIComponent(agentName)}/definition`,
      };
    default:
      return {
        label: "Open agent to run again",
        href: `/${workspaceSlug}/agents/${encodeURIComponent(agentName)}`,
      };
  }
}

