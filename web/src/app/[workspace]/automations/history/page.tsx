import Link from "next/link";
import { notFound } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { LocalTime } from "@/components/local-time";
import { Badge } from "@/components/ui/badge";
import {
  listAutomationDispatchEvents,
  type AutomationKind,
} from "@/lib/automation-events";
import { getServerSession } from "@/lib/session";
import { getWorkspaceBySlug } from "@/lib/workspace";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<AutomationKind, string> = {
  schedule: "Schedule",
  trigger: "Trigger",
  webhook: "Webhook",
};

export default async function AutomationHistoryPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const session = await getServerSession();
  if (!session) notFound();

  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();

  const events = await listAutomationDispatchEvents(workspace.id);

  return (
    <div className="flex w-full flex-col gap-6 px-6 py-8">
      <div className="flex flex-col gap-2">
        <BackLink href={`/${slug}/automations`} label="Automations" />
        <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
          Dispatch history
        </h1>
        <p className="text-foreground-weak text-base">
          Failures remain here after an automation is edited or recovers.
        </p>
      </div>

      <hr className="border-[var(--color-border-weak)]" />

      {events.length === 0 ? (
        <p className="text-foreground-weak rounded-lg border border-dashed border-[var(--color-border)] px-4 py-8 text-center text-sm">
          No automation dispatch failures have been recorded.
        </p>
      ) : (
        <div className="border-border overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-surface-secondary text-foreground-weak uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-left font-medium">Automation</th>
                <th className="px-3 py-2 text-left font-medium">Agent</th>
                <th className="px-3 py-2 text-left font-medium">Detail</th>
                <th className="px-3 py-2 text-left font-medium">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-weak)]">
              {events.map((event) => (
                <tr key={event.id} className="bg-surface-raised">
                  <td className="px-3 py-2 align-top">
                    <Badge
                      variant={event.outcome === "failed" ? "red" : "green"}
                      size="small"
                    >
                      {event.outcome === "failed" ? "Failed" : "Recovered"}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <Link
                      href={`/${slug}/automations/history/${event.id}`}
                      className="text-foreground font-medium hover:underline"
                    >
                      {event.automationName}
                    </Link>
                    <p className="text-foreground-muted mt-0.5">
                      {KIND_LABEL[event.automationKind]} · Attempt {event.attempt}
                    </p>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <Link
                      href={`/${slug}/agents/${encodeURIComponent(event.agentName)}`}
                      className="text-foreground hover:underline"
                    >
                      {event.agentName}
                    </Link>
                  </td>
                  <td className="text-foreground-weak max-w-xl px-3 py-2 align-top">
                    {event.failureSummary ??
                      "A run was queued after the previous dispatch failure."}
                  </td>
                  <td className="text-foreground-weak whitespace-nowrap px-3 py-2 align-top">
                    <LocalTime iso={event.occurredAt.toISOString()} style="relative" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
