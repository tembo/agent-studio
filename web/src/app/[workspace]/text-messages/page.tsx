import { notFound } from "next/navigation";

import { getPublicOrigin } from "@/lib/config";
import { getServerSession } from "@/lib/session";
import { getSmsChannel } from "@/lib/sms-channel";
import {
  getWorkspaceBySlug,
  getWorkspaceRole,
  listWorkspaceMembers,
} from "@/lib/workspace";
import { listAgents } from "@/lib/workspace-agents";

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

  const [channel, listing, memberRows] = await Promise.all([
    getSmsChannel(workspace.id),
    listAgents(workspace.id),
    listWorkspaceMembers(workspace.id),
  ]);
  const agents = listing.ok
    ? listing.agents
        .filter((agent) => agent.ok)
        .map((agent) => ({ value: agent.spec.name, label: agent.spec.name }))
        .sort((a, b) => a.label.localeCompare(b.label))
    : [];
  const members = memberRows.map((member) => ({
    value: member.userId,
    label: member.name?.trim() || member.email,
  }));
  const webhookUrl = channel
    ? `${getPublicOrigin()}/api/sms/${channel.id}/messages`
    : null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
          Text messages
        </h1>
        <p className="text-foreground-weak text-base">
          Let anyone with the number message one Agent Studio agent from their
          phone. Twilio receives the text; Agent Studio runs the agent and texts
          its answer back.
        </p>
      </div>

      <hr className="border-[var(--color-border-weak)]" />

      {role !== "workspace_admin" ? (
        <p className="text-foreground-weak text-sm">
          Only workspace admins can manage text messages.
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
          members={members}
        />
      )}
    </div>
  );
}
