import { notFound } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { RunHistoryList } from "@/components/run-history-list";
import { Section } from "@/components/section";
import { getWorkspaceMemberChoice } from "@/lib/workspace-member-search";
import { getAutomation } from "@/lib/automations-api";
import { listRecentRunsForAutomation } from "@/lib/run-history-db";
import { getServerSession } from "@/lib/session";
import { getWorkspaceBySlug } from "@/lib/workspace";
import { listAgents } from "@/lib/workspace-agents";

import { AutomationForm } from "../automation-form";
import { DeleteAutomationForm } from "./delete-automation-form";

export const dynamic = "force-dynamic";

export default async function EditAutomationPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;

  const session = await getServerSession();
  if (!session) notFound();

  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();

  const automation = await getAutomation(id);
  if (!automation || automation.workspaceId !== workspace.id) notFound();

  const [result, owner, recentRuns] = await Promise.all([
    listAgents(workspace.id),
    getWorkspaceMemberChoice(workspace.id, automation.ownerUserId),
    listRecentRunsForAutomation(workspace.id, automation.id, 10),
  ]);
  const agents = result.ok
    ? result.agents.filter((a) => a.ok).map((a) => ({ name: a.spec.name }))
    : [];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-col gap-2">
        <BackLink href={`/${slug}/automations`} label="Automations" />
        <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
          Edit automation
        </h1>
      </div>

      <hr className="border-[var(--color-border-weak)]" />

      <AutomationForm
        workspaceSlug={slug}
        agents={agents}
        initialOwner={owner ?? { id: automation.ownerUserId, label: "Former member — choose a current member" }}
        defaults={{
          id: automation.id,
          name: automation.name,
          agentName: automation.agentName,
          cron: automation.cron,
          timezone: automation.timezone,
          inputMessage: automation.inputMessage,
          enabled: automation.enabled,
          useDraft: automation.useDraft,
        }}
        mode="edit"
      />

      <hr className="border-[var(--color-border-weak)]" />

      <Section
        title="Run history"
        description="Recent runs started by this automation, including the effective execution identity."
      >
        <RunHistoryList
          runs={recentRuns}
          workspaceSlug={workspace.slug}
          emptyMessage="This automation has not run yet."
        />
      </Section>

      <hr className="border-[var(--color-border-weak)]" />

      <DeleteAutomationForm
        workspaceSlug={slug}
        id={automation.id}
        name={automation.name}
      />
    </div>
  );
}
