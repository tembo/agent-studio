import { notFound } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { getServerSession } from "@/lib/session";
import { getWorkspaceBySlug, getWorkspaceRole } from "@/lib/workspace";
import { listAgents } from "@/lib/workspace-agents";

import { TextMessageForm } from "../text-message-form";

export const dynamic = "force-dynamic";

export default async function NewTextNumberPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const session = await getServerSession();
  if (!session) notFound();
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();
  const role = await getWorkspaceRole(workspace.id, session.user.id);
  if (role !== "workspace_admin") notFound();

  const listing = await listAgents(workspace.id);
  const agents = listing.ok
    ? listing.agents
        .filter((agent) => agent.ok)
        .map((agent) => ({ name: agent.spec.name, labels: agent.spec.labels }))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-col gap-2">
        <BackLink href={`/${workspace.slug}/text-messages`} label="Text messages" />
        <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
          New text number
        </h1>
        <p className="text-foreground-weak text-base">
          Each number has its own Twilio credentials and agent-label scope. You
          will configure its unique webhook after creating it.
        </p>
      </div>

      <hr className="border-[var(--color-border-weak)]" />

      {agents.length > 0 ? (
        <TextMessageForm workspaceSlug={workspace.slug} channel={null} agents={agents} />
      ) : (
        <p className="text-foreground-weak text-sm">
          Add a valid agent before creating a text number.
        </p>
      )}
    </div>
  );
}
