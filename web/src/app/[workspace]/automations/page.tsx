import Link from "next/link";
import { notFound } from "next/navigation";

import { IconPlusLarge } from "central-icons";

import { Button } from "@/components/ui/button";
import { listAutomations } from "@/lib/automations-api";
import { getServerSession } from "@/lib/session";
import { listTriggersForWorkspace } from "@/lib/triggers-db";
import { listWebhooksForWorkspace } from "@/lib/webhooks-db";
import { getWorkspaceBySlug, listWorkspaceMembers } from "@/lib/workspace";

import { AutomationsTable, type AutomationRow } from "./automations-table";

export const dynamic = "force-dynamic";

// Every automation in the workspace — schedules, Composio event triggers, and
// inbound webhooks — in one full-width table. "New automation" opens a type
// picker (Schedule / Trigger / Webhook), mirroring the New connection flow.
export default async function AutomationsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;

  const session = await getServerSession();
  if (!session) notFound();

  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();

  const [automations, triggers, webhooks, members] = await Promise.all([
    listAutomations(workspace.id),
    listTriggersForWorkspace(workspace.id),
    listWebhooksForWorkspace(workspace.id),
    listWorkspaceMembers(workspace.id),
  ]);

  // Resolve a "run as" user id → display label for triggers/webhooks (schedules
  // already carry the resolved owner name).
  const memberLabel = new Map(members.map((m) => [m.userId, m.name ?? m.email]));
  const runAsOf = (userId: string) => memberLabel.get(userId) ?? "—";

  const agentAutomationHref = (agentName: string) =>
    `/${slug}/agents/${encodeURIComponent(agentName)}/automation`;

  const rows: AutomationRow[] = [
    ...automations.map((a): AutomationRow => ({
      id: a.id,
      kind: "schedule",
      name: a.name,
      agentName: a.agentName,
      runAs: a.ownerUserName ?? a.ownerUserEmail ?? "—",
      enabled: a.enabled,
      lastFiredAtIso: a.lastFiredAt ? a.lastFiredAt.toISOString() : null,
      lastFireError: a.lastFireError,
      lastFireEventId: a.lastFireEventId,
      href: `/${slug}/automations/${a.id}`,
      cron: a.cron,
    })),
    ...triggers.map((t): AutomationRow => ({
      id: t.id,
      kind: "trigger",
      name: t.triggerType,
      agentName: t.agentName,
      runAs: runAsOf(t.userId),
      enabled: t.enabled,
      lastFiredAtIso: t.lastFiredAt ? t.lastFiredAt.toISOString() : null,
      lastFireError: t.lastFireError,
      lastFireEventId: t.lastFireEventId,
      href: agentAutomationHref(t.agentName),
      toolkitSlug: t.toolkitSlug,
      triggerType: t.triggerType,
    })),
    ...webhooks.map((w): AutomationRow => ({
      id: w.id,
      kind: "webhook",
      name: w.name,
      agentName: w.agentName,
      runAs: runAsOf(w.ownerUserId),
      enabled: w.enabled,
      lastFiredAtIso: w.lastFiredAt ? w.lastFiredAt.toISOString() : null,
      lastFireError: w.lastFireError,
      lastFireEventId: w.lastFireEventId,
      href: agentAutomationHref(w.agentName),
      tokenLast4: w.tokenLast4,
    })),
  ];

  return (
    <div className="flex w-full flex-col gap-6 px-6 py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
            Automations
          </h1>
          <p className="text-foreground-weak text-base">
            Every way agents in this workspace fire on their own — schedules,
            event triggers, and inbound webhooks.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="secondary">
            <Link href={`/${slug}/automations/history`}>Dispatch history</Link>
          </Button>
          <Button asChild>
            <Link href={`/${slug}/automations/new`}>
              <IconPlusLarge size={16} />
              <span>New automation</span>
            </Link>
          </Button>
        </div>
      </div>

      <hr className="border-[var(--color-border-weak)]" />

      <AutomationsTable rows={rows} workspaceSlug={slug} />
    </div>
  );
}
