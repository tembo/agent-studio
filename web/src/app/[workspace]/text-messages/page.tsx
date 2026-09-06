import { notFound } from "next/navigation";

import { getPublicOrigin } from "@/lib/config";
import { listAgentsByLabels } from "@/lib/agent-scope";
import { getServerSession } from "@/lib/session";
import { getSmsChannel, getSmsPhoneForMember } from "@/lib/sms-channel";
import { getWorkspaceBySlug, getWorkspaceRole } from "@/lib/workspace";
import { listAgents } from "@/lib/workspace-agents";

import { PhoneLinkCard } from "./phone-link-card";
import { TextMessageForm } from "./text-message-form";

export const dynamic = "force-dynamic";

export default async function TextMessagesPage({
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
  if (!role) notFound();

  const [channel, listing, linkedPhoneNumber] = await Promise.all([
    getSmsChannel(workspace.id),
    listAgents(workspace.id),
    getSmsPhoneForMember(workspace.id, session.user.id),
  ]);
  const agents = listing.ok
    ? listing.agents
        .filter((agent) => agent.ok)
        .map((agent) => ({ name: agent.spec.name, labels: agent.spec.labels }))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];
  const webhookUrl = channel
    ? `${getPublicOrigin()}/api/sms/${channel.id}/messages`
    : null;
  const scopedAgentNames = channel
    ? (await listAgentsByLabels(workspace.id, channel.agentLabels)).map(
        (agent) => agent.name,
      )
    : [];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
          Text messages
        </h1>
        <p className="text-foreground-weak text-base">
          Connect a label-scoped set of agents to one shared number. Members
          link their phone, then text an agent name or describe the task.
        </p>
      </div>

      {channel && (
        <PhoneLinkCard
          workspaceSlug={workspace.slug}
          smsPhoneNumber={channel.phoneNumber}
          linkedPhoneNumber={linkedPhoneNumber}
        />
      )}

      {role !== "workspace_admin" ? (
        <p className="text-foreground-weak text-sm">
          {channel
            ? "A workspace admin manages the shared number and connected agents."
            : "A workspace admin has not configured text messages yet."}
        </p>
      ) : agents.length === 0 ? (
        <p className="text-foreground-weak text-sm">
          Add a valid agent before configuring text messages.
        </p>
      ) : (
        <TextMessageForm
          workspaceSlug={workspace.slug}
          channel={channel}
          webhookUrl={webhookUrl}
          agents={agents}
          scopedAgentNames={scopedAgentNames}
        />
      )}
    </div>
  );
}
