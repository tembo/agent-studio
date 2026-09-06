import Link from "next/link";
import { notFound } from "next/navigation";

import { IconPlusLarge } from "central-icons";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getServerSession } from "@/lib/session";
import {
  getSmsPhoneForMember,
  listSmsChannels,
  type SmsChannel,
} from "@/lib/sms-channel";
import { getWorkspaceBySlug, getWorkspaceRole } from "@/lib/workspace";

import { PhoneLinkCard } from "./phone-link-card";

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

  const [channels, linkedPhoneNumber] = await Promise.all([
    listSmsChannels(workspace.id),
    getSmsPhoneForMember(workspace.id, session.user.id),
  ]);
  const enabledChannels = channels
    .filter((channel) => channel.enabled)
    .map(({ id, name, phoneNumber }) => ({ id, name, phoneNumber }));
  const isAdmin = role === "workspace_admin";

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
          Text messages
        </h1>
        <p className="text-foreground-weak text-base">
          Connect named Twilio numbers to different label-scoped sets of agents.
          Workspace members link their phone once, then use any enabled number.
        </p>
      </div>

      {enabledChannels.length > 0 && (
        <PhoneLinkCard
          workspaceSlug={workspace.slug}
          channels={enabledChannels}
          linkedPhoneNumber={linkedPhoneNumber}
        />
      )}

      <hr className="border-[var(--color-border-weak)]" />

      <div className="flex flex-col gap-4">
        {isAdmin && (
          <div className="flex items-center justify-end">
            <Button asChild>
              <Link href={`/${workspace.slug}/text-messages/new`}>
                <IconPlusLarge size={16} />
                <span>New text number</span>
              </Link>
            </Button>
          </div>
        )}

        {channels.length > 0 ? (
          <div className="flex flex-col gap-2">
            {channels.map((channel) => (
              <TextNumberRow
                key={channel.id}
                channel={channel}
                workspaceSlug={workspace.slug}
                canManage={isAdmin}
              />
            ))}
          </div>
        ) : (
          <p className="text-foreground-muted rounded-lg border border-dashed border-[var(--color-border)] px-3 py-10 text-center text-sm">
            {isAdmin
              ? "No text numbers yet. Create one to launch agents over SMS."
              : "A workspace admin has not configured text messages yet."}
          </p>
        )}

        {!isAdmin && channels.length > 0 && (
          <p className="text-foreground-muted text-sm">
            Workspace admins manage text numbers and their connected agents.
          </p>
        )}
      </div>
    </div>
  );
}

function TextNumberRow({
  channel,
  workspaceSlug,
  canManage,
}: {
  channel: SmsChannel;
  workspaceSlug: string;
  canManage: boolean;
}) {
  const content = (
    <>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-foreground font-medium group-hover:underline">
            {channel.name}
          </span>
          <Badge variant={channel.enabled ? "green" : "gray"} size="small">
            {channel.enabled ? "enabled" : "paused"}
          </Badge>
        </div>
        <span className="text-foreground-muted truncate text-sm">
          {channel.phoneNumber} · {channel.agentLabels.join(", ") || "no labels"}
        </span>
      </div>
      {canManage && (
        <span className="text-foreground-muted shrink-0 text-sm" aria-hidden>
          →
        </span>
      )}
    </>
  );

  const className =
    "border-border bg-surface flex items-center justify-between gap-3 rounded-lg border px-4 py-3";
  return canManage ? (
    <Link
      href={`/${workspaceSlug}/text-messages/${channel.id}`}
      className={`${className} hover:bg-surface-secondary group transition-colors`}
    >
      {content}
    </Link>
  ) : (
    <div className={className}>{content}</div>
  );
}
