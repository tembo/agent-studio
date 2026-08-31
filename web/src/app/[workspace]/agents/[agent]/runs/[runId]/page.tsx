import Link from "next/link";
import { notFound } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { LocalTime } from "@/components/local-time";
import { Section } from "@/components/section";
import { isAgentLocked } from "@/lib/agent-lock";
import { scanImprovementsForPRs } from "@/lib/improvement-scan";
import { listImprovementsForRun } from "@/lib/improvements-api";
import { estimateRunCost, formatCurrency, formatTokens } from "@/lib/pricing";
import { getRunExecutionIdentity } from "@/lib/run-history-db";
import { runIdentityLabel } from "@/lib/run-identity";
import {
  listSubAgentRuns,
  listSubAgentRunToolNames,
} from "@/lib/run-orchestration-db";
import { toolkitLabel } from "@/lib/composio-label";
import { getMcpProvider } from "@/lib/mcp-providers";
import { listWorkspaceToolProviders } from "@/lib/mcp-tools";
import { getRun, type RunRecord } from "@/lib/runs-api";
import type { WorkspaceRole } from "@/lib/rbac";
import {
  listStepsForRun,
  listToolCallsForRun,
} from "@/lib/runs-db";
import { getServerSession } from "@/lib/session";
import { isTemboConfiguredForUser } from "@/lib/tembo-credentials";
import { getWorkspaceBySlug, getWorkspaceRole } from "@/lib/workspace";

import { CancelRunButton } from "./cancel-run-button";
import { CopyOutputButton } from "./copy-output-button";
import { ImproveForm } from "./improve-form";
import { RunPoller } from "./run-poller";
import { RunSteps } from "./run-steps";
import { ToolProviderLogo } from "./tool-provider-logo";

export const dynamic = "force-dynamic";

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; agent: string; runId: string }>;
}) {
  const { workspace: slug, runId } = await params;

  const session = await getServerSession();
  if (!session) notFound();

  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();

  const role = await getWorkspaceRole(workspace.id, session.user.id);
  if (!role) notFound();

  const run = await getRun(runId, workspace.id);
  if (!run) notFound();
  // Defense against URL guessing for other workspaces' runs.
  if (run.workspaceId !== workspace.id) notFound();

  // Inline improvement history. Scan refreshes pr_state for the few
  // open rows tied to this run — cheap because it's at most a
  // handful of improvements per run, not the whole workspace.
  const storedImprovements = await listImprovementsForRun(run.id);
  const improvements = await scanImprovementsForPRs(
    workspace.id,
    storedImprovements,
  );

  // Tools the agent called during this run (pydantic only; empty otherwise),
  // plus the per-step token usage so we can attribute tokens to the model step
  // that fired each call.
  const [
    toolCalls,
    steps,
    toolProviderRows,
    subAgentRuns,
    subAgentToolNames,
    runIdentity,
  ] =
    await Promise.all([
      listToolCallsForRun(workspace.id, run.id),
      listStepsForRun(workspace.id, run.id),
      listWorkspaceToolProviders(workspace.id),
      listSubAgentRuns(workspace.id, run.id),
      listSubAgentRunToolNames(workspace.id, run.id),
      getRunExecutionIdentity(workspace.id, run.id),
    ]);

  // tool_name → provider (slug for the logo + label for the tooltip). First
  // row wins on the rare slug collision across providers.
  const toolProviders: Record<string, { slug: string; label: string }> = {};
  for (const t of toolProviderRows) {
    if (toolProviders[t.slug]) continue;
    const label =
      t.source === "native-mcp"
        ? (getMcpProvider(t.provider)?.displayName ?? toolkitLabel(t.provider))
        : toolkitLabel(t.provider);
    toolProviders[t.slug] = { slug: t.provider, label };
  }

  // Which MCPs the sub-agents used: map each tool name their runs invoked
  // to its provider, deduped by provider slug. The orchestrator's own "Uses"
  // row (in the agent layout) only lists its top-level connections, so this
  // surfaces the providers reached one level down.
  const subAgentProviders: { slug: string; label: string }[] = [];
  {
    const seen = new Set<string>();
    for (const name of subAgentToolNames) {
      const p = toolProviders[name];
      if (!p || seen.has(p.slug)) continue;
      seen.add(p.slug);
      subAgentProviders.push(p);
    }
  }

  // Plain-text transcript for the copy button: each step's narration (and the
  // final answer) plus the tool calls it made, in order. `isLive` drives the
  // word-by-word reveal in RunSteps.
  const callsByStepForCopy = new Map<number, typeof toolCalls>();
  for (const c of toolCalls) {
    if (c.stepOrdinal === null) continue;
    const arr = callsByStepForCopy.get(c.stepOrdinal) ?? [];
    arr.push(c);
    callsByStepForCopy.set(c.stepOrdinal, arr);
  }
  const stepText = steps
    .map((s) => {
      const lines: string[] = [];
      if (s.summary) lines.push(s.summary);
      for (const c of callsByStepForCopy.get(s.ordinal) ?? []) {
        const status =
          c.ok === true ? "ok" : c.ok === false ? "failed" : "running";
        const err = c.ok === false && c.errorMessage ? `: ${c.errorMessage}` : "";
        lines.push(`  → ${c.toolName} (${status})${err}`);
      }
      return lines.join("\n");
    })
    .filter((s) => s.length > 0)
    .join("\n\n");
  const isLive = run.status === "running" || run.status === "queued";

  // "Improve the Agent" opens a Tembo CAP task — hide it when no Tembo
  // API key is set (the run + its output still render), or when the agent is
  // locked (#12: no user-driven edits — changes go through repo PRs).
  const temboConfigured = await isTemboConfiguredForUser(
    workspace.id,
    session.user.id,
  );
  const locked = await isAgentLocked(workspace.id, run.agentName);

  const agentHref = `/${workspace.slug}/agents/${encodeURIComponent(run.agentName)}`;
  // Prompt-cache breakdown lives per-step; sum it for the run header so the
  // cache hit (read 0.1x) vs. write (1.25x) is visible without scanning steps.
  // Also needed before cost so the header estimate prices cache halves instead
  // of defaulting them to 0 (which undercounted when prompt caching engaged).
  const cacheReadTokens = steps.reduce(
    (sum, s) => sum + (s.cacheReadTokens ?? 0),
    0,
  );
  const cacheWriteTokens = steps.reduce(
    (sum, s) => sum + (s.cacheWriteTokens ?? 0),
    0,
  );
  const hasCache = cacheReadTokens > 0 || cacheWriteTokens > 0;
  // Token total = uncached input + cache halves + output (same shape as the
  // step footer). tokensInput is already uncached; cache is stored per-step.
  const totalTokens =
    run.tokensInput !== null && run.tokensOutput !== null
      ? run.tokensInput + run.tokensOutput + cacheReadTokens + cacheWriteTokens
      : null;
  // Cache-aware recompute: uncached input @ 1x + cache read @ 0.1x + write @
  // 1.25x. Passing only in/out (defaulting cache to 0) undercounted the header
  // whenever prompt caching engaged — the step footer was already correct.
  const estimatedCost =
    run.tokensInput !== null && run.tokensOutput !== null
      ? estimateRunCost(
          run.model,
          run.tokensInput,
          run.tokensOutput,
          cacheReadTokens,
          cacheWriteTokens,
        )
      : null;
  // ScaleDown prompt compression, if this run used it. original/compressed are
  // the source-block token counts before/after compression.
  const scaledownOrig = run.scaledownOriginalTokens;
  const scaledownComp = run.scaledownCompressedTokens;
  const hasScaledown =
    scaledownOrig !== null &&
    scaledownComp !== null &&
    scaledownOrig > 0 &&
    scaledownComp <= scaledownOrig;
  const scaledownPct = hasScaledown
    ? Math.round((100 * (scaledownOrig - scaledownComp)) / scaledownOrig)
    : 0;
  // Sub-runs this run spawned via trigger_run. Roll their tokens + cost up so
  // an orchestrator's page shows its true total, not just its own (small) cost.
  const subRunsCost = subAgentRuns.reduce(
    (sum, run) => sum + (run.costUsd ?? 0),
    0,
  );
  const subRunsTokens = subAgentRuns.reduce(
    (sum, run) => sum + (run.tokensInput ?? 0) + (run.tokensOutput ?? 0),
    0,
  );
  const grandTotalCost =
    subAgentRuns.length > 0 ? (estimatedCost ?? 0) + subRunsCost : null;
  const grandTotalTokens =
    subAgentRuns.length > 0 ? (totalTokens ?? 0) + subRunsTokens : null;

  return (
    <div className="flex flex-col gap-6">
      <RunPoller status={run.status} />
      <div className="flex flex-col gap-3">
        <BackLink href={agentHref} label={run.agentName} />
        <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
          Run
        </h1>
        <dl className="flex flex-col gap-2 text-sm">
          <div className="flex gap-3">
            <dt className="text-foreground-weak w-24 shrink-0 font-medium">
              Status
            </dt>
            <dd className="flex items-center gap-3">
              <span className={`${STATUS_TEXT_TONE[run.status]} font-medium`}>
                {STATUS_LABELS[run.status]}
              </span>
              {run.resumeCount > 0 && (
                <span className="text-foreground-weak text-xs font-medium">
                  Resumed{run.resumeCount > 1 ? ` ${run.resumeCount}×` : ""}
                </span>
              )}
              {isLive && (
                <CancelRunButton
                  workspaceSlug={workspace.slug}
                  agentName={run.agentName}
                  runId={run.id}
                />
              )}
            </dd>
          </div>
          <div className="flex gap-3">
            <dt className="text-foreground-weak w-24 shrink-0 font-medium">
              Model
            </dt>
            <dd className="text-foreground">{run.model}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="text-foreground-weak w-24 shrink-0 font-medium">
              Trigger
            </dt>
            <dd className="text-foreground">
              {run.trigger === "schedule" && run.automationId ? (
                <>
                  Scheduled —{" "}
                  <Link
                    href={`/${workspace.slug}/automations/${run.automationId}`}
                    className="hover:underline"
                  >
                    view automation
                  </Link>
                </>
              ) : run.trigger === "schedule" ? (
                "Scheduled (automation deleted)"
              ) : run.trigger === "event" ? (
                "Event (Composio webhook)"
              ) : (
                "Manual"
              )}
            </dd>
          </div>
          <div className="flex gap-3">
            <dt className="text-foreground-weak w-24 shrink-0 font-medium">
              Run as
            </dt>
            <dd className="text-foreground">
              {runIdentityLabel(runIdentity.name, runIdentity.email)}
            </dd>
          </div>
          {run.userMessage.trim() && (
            <div className="flex gap-3">
              <dt className="text-foreground-weak w-24 shrink-0 font-medium">
                Input
              </dt>
              <dd className="text-foreground whitespace-pre-wrap">
                {run.userMessage}
              </dd>
            </div>
          )}
          <div className="flex gap-3">
            <dt className="text-foreground-weak w-24 shrink-0 font-medium">
              Queued
            </dt>
            <dd className="text-foreground">
              <LocalTime iso={run.createdAt} />
            </dd>
          </div>
          {run.startedAt && (
            <div className="flex gap-3">
              <dt className="text-foreground-weak w-24 shrink-0 font-medium">
                Started
              </dt>
              <dd className="text-foreground">
                {formatRelative(run.createdAt, run.startedAt)}
              </dd>
            </div>
          )}
          {run.completedAt && run.startedAt && (
            <div className="flex gap-3">
              <dt className="text-foreground-weak w-24 shrink-0 font-medium">
                Ran for
              </dt>
              <dd className="text-foreground">
                {formatDuration(run.startedAt, run.completedAt)}
              </dd>
            </div>
          )}
          {totalTokens !== null && (
            <div className="flex gap-3">
              <dt className="text-foreground-weak w-24 shrink-0 font-medium">
                Consumed
              </dt>
              <dd className="text-foreground">
                {formatTokens(totalTokens)} tokens
                {estimatedCost !== null && (
                  <span className="text-foreground-weak">
                    {" "}
                    (~{formatCurrency(estimatedCost)})
                  </span>
                )}
              </dd>
            </div>
          )}
          {hasCache && (
            <div className="flex gap-3">
              <dt className="text-foreground-weak w-24 shrink-0 font-medium">
                Prompt cache
              </dt>
              <dd className="text-foreground">
                {formatTokens(cacheReadTokens)} read
                <span className="text-foreground-weak">
                  {" "}
                  (0.1×)
                </span>{" "}
                · {formatTokens(cacheWriteTokens)} write
                <span className="text-foreground-weak">
                  {" "}
                  (1.25×)
                </span>
              </dd>
            </div>
          )}
          {hasScaledown && (
            <div className="flex gap-3">
              <dt className="text-foreground-weak w-24 shrink-0 font-medium">
                ScaleDown
              </dt>
              <dd className="text-foreground">
                {formatTokens(scaledownOrig)} → {formatTokens(scaledownComp)} tokens
                <span className="text-foreground-weak">
                  {" "}
                  ({scaledownPct}% off compressed context)
                </span>
              </dd>
            </div>
          )}
          {grandTotalTokens !== null && (
            <div className="flex gap-3">
              <dt className="text-foreground-weak w-24 shrink-0 font-medium">
                Combined
              </dt>
              <dd className="text-foreground">
                {formatTokens(grandTotalTokens)} tokens
                {grandTotalCost !== null && (
                  <span className="text-foreground-weak">
                    {" "}
                    (~{formatCurrency(grandTotalCost)})
                  </span>
                )}
                <span className="text-foreground-weak">
                  {" "}
                  · this run + {subAgentRuns.length} sub-run
                  {subAgentRuns.length === 1 ? "" : "s"}
                </span>
              </dd>
            </div>
          )}
          {subAgentProviders.length > 0 && (
            <div className="flex gap-3">
              <dt className="text-foreground-weak w-24 shrink-0 font-medium">
                Sub-agents use
              </dt>
              <dd className="flex flex-wrap items-center gap-1.5">
                {subAgentProviders.map((p) => (
                  <span
                    key={p.slug}
                    className="bg-surface-raised border-border inline-flex shrink-0 items-center gap-1.5 rounded-md border py-0.5 pl-1 pr-2"
                  >
                    <ToolProviderLogo providerSlug={p.slug} title={p.label} />
                    <span className="text-foreground-weak text-xs">
                      {p.label}
                    </span>
                  </span>
                ))}
              </dd>
            </div>
          )}
        </dl>
      </div>

      <hr className="border-[var(--color-border-weak)]" />

      {/* The step timeline is both the live and the final view — the final
          answer is the last step's text, so there's no separate Output box.
          The copy button grabs just the text parts for pasting elsewhere. */}
      {steps.length > 0 && (
        <Section
          title="Run Steps"
          actions={
            stepText ? <CopyOutputButton text={stepText} /> : undefined
          }
        >
          <RunSteps
            model={run.model}
            steps={steps}
            calls={toolCalls}
            toolProviders={toolProviders}
            live={isLive}
          />
        </Section>
      )}

      {/* Runs this one spawned via trigger_run (an orchestrator fanning work
          out to per-source sub-agents). Each links to its own run page; the Total
          footer rolls this run + every sub-run into one tokens + cost figure. */}
      {subAgentRuns.length > 0 && (
        <Section title={`Sub-runs (${subAgentRuns.length})`}>
          <ul className="divide-y divide-[var(--color-border-weak)]">
            {subAgentRuns.map((subAgentRun) => {
              const subAgentTokens =
                subAgentRun.tokensInput !== null &&
                subAgentRun.tokensOutput !== null
                  ? subAgentRun.tokensInput + subAgentRun.tokensOutput
                  : null;
              return (
                <li key={subAgentRun.id}>
                  <Link
                    href={`/${workspace.slug}/agents/${encodeURIComponent(
                      subAgentRun.agentName,
                    )}/runs/${subAgentRun.id}`}
                    className="hover:bg-background-weak flex items-center justify-between gap-3 px-1 py-2"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="flex items-center gap-2 truncate">
                        <span className="text-foreground truncate font-medium">
                          {subAgentRun.agentName}
                        </span>
                        <span
                          className={`${STATUS_TEXT_TONE[subAgentRun.status]} text-sm`}
                        >
                          {STATUS_LABELS[subAgentRun.status]}
                        </span>
                      </span>
                      <span className="text-foreground-muted truncate text-xs">
                        Run as{" "}
                        {runIdentityLabel(
                          subAgentRun.createdByName,
                          subAgentRun.createdByEmail,
                        )}
                      </span>
                    </span>
                    <span className="text-foreground-weak shrink-0 text-sm">
                      {subAgentTokens !== null && (
                        <>{formatTokens(subAgentTokens)} tokens</>
                      )}
                      {subAgentRun.costUsd !== null && (
                        <> (~{formatCurrency(subAgentRun.costUsd)})</>
                      )}
                    </span>
                  </Link>
                </li>
              );
            })}
            {/* Total = this orchestrating run + every sub-run it spawned. */}
            <li className="flex items-center justify-between gap-3 border-t-2 border-[var(--color-border)] px-1 py-2">
              <span className="text-foreground font-medium">
                Total
                <span className="text-foreground-weak font-normal">
                  {" "}
                  (this run + {subAgentRuns.length} sub-run
                  {subAgentRuns.length === 1 ? "" : "s"})
                </span>
              </span>
              <span className="text-foreground shrink-0 font-medium">
                {grandTotalTokens !== null && (
                  <>{formatTokens(grandTotalTokens)} tokens</>
                )}
                {grandTotalCost !== null && (
                  <span className="text-foreground-weak font-normal">
                    {" "}
                    (~{formatCurrency(grandTotalCost)})
                  </span>
                )}
              </span>
            </li>
          </ul>
        </Section>
      )}

      {/* Fallback Output box for runs with no steps (e.g. cargo-ai) or the
          "Running…" / "Waiting…" states before the first step lands. */}
      {steps.length === 0 && run.status !== "failed" && (
        <Section title="Output">
          {run.status === "queued" && (
            <p className="text-foreground-weak text-base">Waiting to start…</p>
          )}
          {run.status === "running" && (
            <p className="text-foreground-weak text-base">Running…</p>
          )}
          {run.output && (
            <div className="bg-surface-raised border-border group relative overflow-hidden rounded-lg border">
              <div className="absolute right-2 top-2 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
                <CopyOutputButton text={stripStopReason(run.output)} />
              </div>
              <pre className="text-foreground overflow-x-auto whitespace-pre-wrap p-4 text-sm leading-6">
                {stripStopReason(run.output)}
              </pre>
            </div>
          )}
        </Section>
      )}

      {run.status === "failed" && (
        <Section title="Failure">
          <FailedReason
            run={run}
            workspaceSlug={workspace.slug}
            role={role}
          />
        </Section>
      )}

      {/* Hide the improvement section while the run is in flight — there's
          nothing to improve on yet, and the form pulling the eye away
          from the streaming output feels wrong. Fade it in two seconds
          after the output settles so the user finishes reading first. */}
      {(run.status === "succeeded" || run.status === "failed") &&
        temboConfigured &&
        !locked && (
          <>
            <hr className="border-[var(--color-border-weak)]" />
            <ImproveForm
              workspaceSlug={workspace.slug}
              runId={run.id}
              improvements={improvements}
              commitMode={workspace.commitMode}
            />
          </>
        )}
    </div>
  );
}

function FailedReason({
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
  const canViewDiagnostics = role === "workspace_admin";

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
      {canViewDiagnostics && run.errorMessage && (
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

const STATUS_LABELS: Record<RunRecord["status"], string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

// Colored text tone per status, used inline in the meta <dl>. Replaces
// the Badge pair we used to render above the metadata block — same
// semantics, less visual weight.
const STATUS_TEXT_TONE: Record<RunRecord["status"], string> = {
  queued: "text-[var(--color-yellow-700)]",
  running: "text-[var(--color-blue-600)]",
  succeeded: "text-sentiment-positive",
  failed: "text-sentiment-negative",
  cancelled: "text-foreground-muted",
};

// Historical runs (pre-9d5f2dc) have a `\n\n[stop_reason=...]`
// suffix appended by the Rust runner. Strip it on read so older
// outputs render cleanly. Future runs don't write the suffix at all.
function stripStopReason(output: string): string {
  return output.replace(/\n*\[stop_reason=[^\]]*\]\s*$/, "");
}

function formatRelative(fromIso: string, toIso: string): string {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  if (ms < 1000) return `${ms}ms after queued`;
  return `${Math.round(ms / 1000)}s after queued`;
}

function formatDuration(fromIso: string, toIso: string): string {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
