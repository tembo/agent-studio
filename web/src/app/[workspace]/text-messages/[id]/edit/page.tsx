import { notFound } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { getServerSession } from "@/lib/session";
import { getSmsChannel } from "@/lib/sms-channel";
import { getWorkspaceBySlug, getWorkspaceRole } from "@/lib/workspace";
import { listAgents } from "@/lib/workspace-agents";

import { TextMessageForm } from "../../text-message-form";

export const dynamic = "force-dynamic";

export default async function EditTextNumberPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;
  const session = await getServerSession();
  if (!session) notFound();
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();
  const role = await getWorkspaceRole(workspace.id, session.user.id);
  if (role !== "workspace_admin") notFound();

  const [channel, listing] = await Promise.all([
    getSmsChannel(workspace.id, id),
    listAgents(workspace.id),
  ]);
  if (!channel) notFound();
  const agents = listing.ok
    ? listing.agents
        .filter((agent) => agent.ok)
        .map((agent) => ({ name: agent.spec.name, labels: agent.spec.labels }))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-col gap-2">
        <BackLink
          href={`/${workspace.slug}/text-messages/${channel.id}`}
          label={channel.name}
        />
        <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
          Edit {channel.name}
        </h1>
        <p className="text-foreground-weak text-base">
          Leave the Twilio Auth Token blank to keep the existing secret.
        </p>
      </div>

      <hr className="border-[var(--color-border-weak)]" />

      <TextMessageForm
        workspaceSlug={workspace.slug}
        channel={channel}
        agents={agents}
      />
    </div>
  );
}
