import Link from "next/link";
import { notFound } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { LocalTime } from "@/components/local-time";
import { Badge } from "@/components/ui/badge";
import {
  getAutomationDispatchEvent,
  type AutomationDispatchEvent,
} from "@/lib/automation-events";
import { getServerSession } from "@/lib/session";
import {
  getWorkspaceBySlug,
  getWorkspaceRole,
} from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function AutomationEventPage({
  params,
}: {
  params: Promise<{ workspace: string; eventId: string }>;
}) {
  const { workspace: slug, eventId } = await params;
  const session = await getServerSession();
  if (!session) notFound();

  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();

  const role = await getWorkspaceRole(workspace.id, session.user.id);
  if (!role) notFound();
  const event = await getAutomationDispatchEvent(
    workspace.id,
    eventId,
    role === "workspace_admin",
  );
  if (!event) notFound();

  const automationHref = sourceHref(slug, event);
  const isFailure = event.outcome === "failed";

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-col gap-2">
        <BackLink
          href={`/${slug}/automations/history`}
          label="Dispatch history"
        />
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
            {isFailure ? "Dispatch failed" : "Dispatch recovered"}
          </h1>
          <Badge variant={isFailure ? "red" : "green"}>
            {isFailure ? "Failed" : "Recovered"}
          </Badge>
        </div>
      </div>

      <div
        className={
          isFailure
            ? "border-sentiment-negative bg-[var(--color-input-error)] rounded-lg border p-4"
            : "border-sentiment-positive bg-[var(--color-sentiment-positive-subtle)] rounded-lg border p-4"
        }
      >
        <p className="text-foreground font-medium">
          {event.failureSummary ??
            "A run was queued after the previous dispatch failure."}
        </p>
        {event.failureRecommendation && (
          <p className="text-foreground-weak mt-1">
            {event.failureRecommendation}
          </p>
        )}
      </div>

      <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        <Detail label="Automation">
          <Link href={automationHref} className="text-foreground hover:underline">
            {event.automationName}
          </Link>
        </Detail>
        <Detail label="Agent">
          <Link
            href={`/${slug}/agents/${encodeURIComponent(event.agentName)}`}
            className="text-foreground hover:underline"
          >
            {event.agentName}
          </Link>
        </Detail>
        <Detail label="Attempt">{event.attempt}</Detail>
        <Detail label="Occurred">
          <LocalTime iso={event.occurredAt.toISOString()} />
        </Detail>
        {event.resolvedAt && (
          <Detail label="Resolved">
            <LocalTime iso={event.resolvedAt.toISOString()} />
          </Detail>
        )}
        {event.runId && (
          <Detail label="Related run">
            <Link
              href={`/${slug}/agents/${encodeURIComponent(event.agentName)}/runs/${event.runId}`}
              className="text-foreground hover:underline"
            >
              Open run →
            </Link>
          </Detail>
        )}
      </dl>

      {role === "workspace_admin" && event.diagnosticDetail && (
        <details className="border-border border-t pt-4">
          <summary className="text-foreground cursor-pointer font-medium">
            Technical details
          </summary>
          <pre className="text-foreground mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-surface-raised p-3 font-mono text-sm leading-5">
            {event.diagnosticDetail}
          </pre>
        </details>
      )}
    </div>
  );
}

function sourceHref(
  workspaceSlug: string,
  event: AutomationDispatchEvent,
): string {
  if (event.automationKind === "schedule") {
    return `/${workspaceSlug}/automations/${event.automationId}`;
  }
  return `/${workspaceSlug}/agents/${encodeURIComponent(event.agentName)}/automation`;
}

function Detail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-foreground-muted text-sm uppercase tracking-wide">
        {label}
      </dt>
      <dd className="text-foreground-weak mt-1">{children}</dd>
    </div>
  );
}
