import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { BackLink } from "@/components/back-link";
import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { listAgentsByLabels } from "@/lib/agent-scope";
import { getPublicOrigin } from "@/lib/config";
import { getServerSession } from "@/lib/session";
import { getSmsChannel } from "@/lib/sms-channel";
import { getWorkspaceBySlug, getWorkspaceRole } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function TextNumberDetailPage({
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

  const channel = await getSmsChannel(workspace.id, id);
  if (!channel) notFound();
  const connectedAgents = await listAgentsByLabels(
    workspace.id,
    channel.agentLabels,
  );
  const webhookUrl = `${getPublicOrigin()}/api/sms/${channel.id}/messages`;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-col gap-2">
        <BackLink href={`/${workspace.slug}/text-messages`} label="Text messages" />
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
              {channel.name}
            </h1>
            <Badge variant={channel.enabled ? "green" : "gray"} size="small">
              {channel.enabled ? "enabled" : "paused"}
            </Badge>
          </div>
          <Button asChild variant="secondary">
            <Link href={`/${workspace.slug}/text-messages/${channel.id}/edit`}>
              Edit
            </Link>
          </Button>
        </div>
      </div>

      <hr className="border-[var(--color-border-weak)]" />

      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
        <Row label="Phone number">
          <code className="text-foreground">{channel.phoneNumber}</code>
        </Row>
        <Row label="Agent labels">{channel.agentLabels.join(", ")}</Row>
        <Row label="Connected agents">
          {connectedAgents.length > 0
            ? connectedAgents.map((agent) => agent.name).join(", ")
            : "none"}
        </Row>
        <Row label="Twilio credentials">
          {channel.hasAuthToken ? `set for ${channel.accountSid}` : "not set"}
        </Row>
      </dl>

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-foreground font-medium">Twilio webhook</h2>
          <p className="text-foreground-weak mt-1 text-sm">
            Set this number&apos;s incoming-message webhook to HTTP POST in Twilio.
          </p>
        </div>
        <div className="border-border bg-surface flex items-center gap-2 rounded-lg border px-3 py-2">
          <code className="text-foreground min-w-0 flex-1 break-all text-sm">
            {webhookUrl}
          </code>
          <CopyButton text={webhookUrl} ariaLabel="Copy Twilio webhook URL" />
        </div>
      </section>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-foreground-muted">{label}</dt>
      <dd className="text-foreground-weak">{children}</dd>
    </>
  );
}
