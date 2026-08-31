import Link from "next/link";

import { IconPlusLarge } from "central-icons";

import { Section } from "@/components/section";
import { Button } from "@/components/ui/button";
import { listAutomationsForAgent } from "@/lib/automations-api";
import { getPublicOrigin } from "@/lib/config";
import { meetsMinRole } from "@/lib/rbac";
import { listTriggersForAgent } from "@/lib/triggers-db";
import { listWebhooksForAgent } from "@/lib/webhooks-db";
import { getWorkspaceRole, listWorkspaceMembers } from "@/lib/workspace";

import { loadAgentContext } from "../agent-page-context";
import {
  AgentAutomationsTable,
  type AgentAutomationRow,
} from "../agent-automations-table";

export const dynamic = "force-dynamic";

// Automation tab — every way this agent fires on its own: cron schedules,
// Composio event triggers, and inbound external webhooks, in one unified table.
// "New automation" opens a per-agent type picker (Schedule / Trigger / Webhook),
// mirroring the workspace /automations list.

export default async function AgentAutomationPage({
  params,
}: {
  params: Promise<{ workspace: string; agent: string }>;
}) {
  const { workspace: slug, agent: agentName } = await params;
  const { session, workspace, canonicalName } = await loadAgentContext(
    slug,
    agentName,
  );

  const [triggers, webhooks, automations, currentUserRole, allMembers] =
    await Promise.all([
      listTriggersForAgent(workspace.id, canonicalName),
      listWebhooksForAgent(workspace.id, canonicalName),
      listAutomationsForAgent(workspace.id, canonicalName),
      getWorkspaceRole(workspace.id, session.user.id),
      listWorkspaceMembers(workspace.id),
    ]);

  const canEdit = meetsMinRole(currentUserRole, "operator");
  const baseUrl = getPublicOrigin();
  const memberLabel = new Map(
    allMembers.map((m) => [m.userId, m.name ?? m.email]),
  );
  const runAsOf = (userId: string) => memberLabel.get(userId) ?? "—";

  const rows: AgentAutomationRow[] = [
    ...automations.map((a): AgentAutomationRow => ({
      id: a.id,
      kind: "schedule",
      name: a.name,
      runAs: a.ownerUserName ?? a.ownerUserEmail ?? "—",
      enabled: a.enabled,
      lastFiredAtIso: a.lastFiredAt ? a.lastFiredAt.toISOString() : null,
      lastFireError: a.lastFireError,
      lastFireEventId: a.lastFireEventId,
      href: `/${workspace.slug}/automations/${a.id}`,
      cron: a.cron,
    })),
    ...triggers.map((t): AgentAutomationRow => ({
      id: t.id,
      kind: "trigger",
      name: t.triggerType,
      runAs: runAsOf(t.userId),
      enabled: t.enabled,
      lastFiredAtIso: t.lastFiredAt ? t.lastFiredAt.toISOString() : null,
      lastFireError: t.lastFireError,
      lastFireEventId: t.lastFireEventId,
      href: null,
      toolkitSlug: t.toolkitSlug,
      triggerType: t.triggerType,
    })),
    ...webhooks.map((w): AgentAutomationRow => ({
      id: w.id,
      kind: "webhook",
      name: w.name,
      runAs: runAsOf(w.ownerUserId),
      enabled: w.enabled,
      lastFiredAtIso: w.lastFiredAt ? w.lastFiredAt.toISOString() : null,
      lastFireError: w.lastFireError,
      lastFireEventId: w.lastFireEventId,
      href: null,
      tokenLast4: w.tokenLast4,
      webhookUrl: `${baseUrl}/api/hooks/webhook/${w.id}`,
      signed: w.hasSigningSecret,
    })),
  ];

  return (
    <Section
      title="Automations"
      description="Every way this agent fires on its own: schedules, event triggers, and inbound webhooks."
      actions={
        <Button asChild>
          <Link
            href={`/${workspace.slug}/agents/${encodeURIComponent(canonicalName)}/automation/new`}
          >
            <IconPlusLarge size={16} />
            <span>New automation</span>
          </Link>
        </Button>
      }
    >
      <AgentAutomationsTable
        rows={rows}
        workspaceSlug={workspace.slug}
        canManageWebhooks={canEdit}
      />
    </Section>
  );
}
