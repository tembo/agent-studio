import Link from "next/link";
import { notFound } from "next/navigation";

import { LocalTime } from "@/components/local-time";
import { Section } from "@/components/section";
import { Badge } from "@/components/ui/badge";
import { emailPasswordEnabled } from "@/lib/auth-providers";
import { listAutomations } from "@/lib/automations-api";
import { toolkitLabel } from "@/lib/composio";
import { listConnectionsForUser } from "@/lib/composio-connections";
import { listNativeConnectionsForUser } from "@/lib/connections";
import { getMcpProvider } from "@/lib/mcp-providers";
import { listRunsForWorkspace } from "@/lib/runs-db";
import { getServerSession } from "@/lib/session";
import {
  getWorkspaceBySlug,
  getWorkspaceRole,
  listWorkspaceMembers,
} from "@/lib/workspace";

import { ResetPasswordLink } from "../../reset-password-link";

export const dynamic = "force-dynamic";

// Member detail — workspace-admin view of one member's footprint:
// their per-user tool connections, the automations that "Run as" them,
// and the runs they've triggered. Mostly read-only (role change /
// remove live on the members list); the one action here is the
// password-reset link on email/password instances. Useful for
// offboarding ("what does this person own before I remove them?").
export default async function MemberDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; userId: string }>;
}) {
  const { workspace: slug, userId } = await params;

  const session = await getServerSession();
  if (!session) notFound();
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();

  // Admin-only: viewing another member's connections/runs is privileged.
  const role = await getWorkspaceRole(workspace.id, session.user.id);
  if (role !== "workspace_admin") notFound();

  const members = await listWorkspaceMembers(workspace.id);
  const member = members.find((m) => m.userId === userId);
  if (!member) notFound();

  const [composio, native, automations, runs] = await Promise.all([
    listConnectionsForUser(workspace.id, userId).catch(() => []),
    listNativeConnectionsForUser(workspace.id, userId).catch(() => []),
    listAutomations(workspace.id).catch(() => []),
    listRunsForWorkspace(workspace.id, { createdBy: userId }, { limit: 20 }).catch(
      () => [],
    ),
  ]);
  const ownedAutomations = automations.filter((a) => a.ownerUserId === userId);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link
          href={`/${slug}/settings/members`}
          className="text-foreground-weak hover:text-foreground text-sm"
        >
          ← Members
        </Link>
        <h2 className="text-foreground-title text-xl font-bold">
          {member.name ?? member.email}
        </h2>
        <p className="text-foreground-weak text-sm">
          {member.email} ·{" "}
          <span className="capitalize">{member.role.replace("_", " ")}</span> ·
          joined <LocalTime iso={member.joinedAt.toISOString()} />
        </p>
      </div>

      {emailPasswordEnabled() && (
        <Section
          title="Password"
          description="Generate a one-time reset link if this member is locked out. Share it with them directly — TAS doesn't send email."
        >
          <ResetPasswordLink
            workspaceSlug={slug}
            userId={member.userId}
            email={member.email}
          />
        </Section>
      )}

      <Section
        title="Connections"
        description="Tool accounts this member authorized. Scheduled runs that 'Run as' them use these."
      >
        {composio.length === 0 && native.length === 0 ? (
          <Empty>No connections.</Empty>
        ) : (
          <ul className="border-border divide-border-weak bg-surface divide-y overflow-hidden rounded-lg border">
            {composio.map((c) => (
              <ConnRow
                key={`c:${c.id}`}
                kind="Composio"
                label={toolkitLabel(c.toolkit)}
                slot={c.name}
                status={c.status}
              />
            ))}
            {native.map((c) => (
              <ConnRow
                key={`n:${c.id}`}
                kind="Native MCP"
                label={getMcpProvider(c.type)?.displayName ?? c.type}
                slot={c.name}
                status={c.status}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Automations (Run as)"
        description="Schedules that execute as this member. During removal, an admin can reassign them; otherwise enabled schedules are paused."
      >
        {ownedAutomations.length === 0 ? (
          <Empty>None.</Empty>
        ) : (
          <ul className="border-border divide-border-weak bg-surface divide-y overflow-hidden rounded-lg border">
            {ownedAutomations.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between gap-4 px-3 py-2.5 text-sm"
              >
                <Link
                  href={`/${slug}/automations/${a.id}`}
                  className="text-foreground font-medium hover:underline"
                >
                  {a.name}
                </Link>
                <div className="text-foreground-weak flex items-center gap-3">
                  <code className="text-sm">{a.cron}</code>
                  <Badge variant={a.enabled ? "green" : "gray"} size="small">
                    {a.enabled ? "Enabled" : "Paused"}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Recent runs"
        description="The latest runs triggered by this member."
      >
        {runs.length === 0 ? (
          <Empty>None.</Empty>
        ) : (
          <ul className="border-border divide-border-weak bg-surface divide-y overflow-hidden rounded-lg border">
            {runs.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between gap-4 px-3 py-2.5 text-sm"
              >
                <Link
                  href={`/${slug}/agents/${encodeURIComponent(r.agentName)}/runs/${r.id}`}
                  className="text-foreground font-medium hover:underline"
                >
                  {r.agentName}
                </Link>
                <div className="text-foreground-weak flex items-center gap-3">
                  {r.isDryRun && (
                    <Badge variant="orange" size="small">
                      Dry run
                    </Badge>
                  )}
                  <Badge variant={RUN_BADGE[r.status]} size="small">
                    {r.status}
                  </Badge>
                  <LocalTime iso={r.createdAt.toISOString()} style="relative" />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

const RUN_BADGE: Record<string, "green" | "red" | "yellow" | "blue" | "gray"> = {
  queued: "yellow",
  running: "blue",
  succeeded: "green",
  failed: "red",
  cancelled: "gray",
};

function ConnRow({
  kind,
  label,
  slot,
  status,
}: {
  kind: string;
  label: string;
  slot: string;
  status: string;
}) {
  const active = status.toLowerCase() === "active";
  return (
    <li className="flex items-center justify-between gap-4 px-3 py-2.5 text-sm">
      <div className="flex min-w-0 flex-col">
        <span className="text-foreground font-medium">
          {label}
          {slot && slot !== "default" ? (
            <span className="text-foreground-weak"> ({slot})</span>
          ) : null}
        </span>
        <span className="text-foreground-muted text-sm">{kind}</span>
      </div>
      <Badge variant={active ? "green" : "yellow"} size="small">
        {status}
      </Badge>
    </li>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-foreground-weak rounded-lg border border-dashed border-[var(--color-border)] px-4 py-6 text-center text-sm">
      {children}
    </p>
  );
}
