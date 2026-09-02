import Link from "next/link";
import type { ReactNode } from "react";

import { BackLink } from "@/components/back-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FRAMEWORK_LABELS } from "@/lib/agent-framework";
import {
  getDraftChangedAt,
  pendingDraftFromContent,
} from "@/lib/agent-draft-status";
import { agentDisplayName } from "@/lib/agent-format";
import { getAgentOwner, getStableVersion } from "@/lib/agent-versions";
import { toolkitLabel } from "@/lib/composio-label";
import { getMcpProvider } from "@/lib/mcp-providers";
import { meetsMinRole } from "@/lib/rbac";
import { isTemboConfiguredForUser } from "@/lib/tembo-credentials";
import {
  getWorkspaceRole,
  listWorkspaceMembers,
} from "@/lib/workspace";

import {
  AgentConnectionIcons,
  type ConnectionIconItem,
} from "./agent-connection-icons";
import { AgentNav } from "./agent-nav";
import { loadAgentContext } from "./agent-page-context";
import { DraftChangesBanner } from "./draft-changes-banner";
import { ForkAgentButton } from "./fork-agent-button";
import { RunNowButton } from "./run-now-button";

export const dynamic = "force-dynamic";

// Shared shell for the agent view. Renders the constant header (name, badges,
// connection icons, owner, action buttons, draft-changes banner) and the left
// tab rail; each tab's content renders into {children}. Mirrors the Settings /
// Connections two-column layout.

export default async function AgentLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspace: string; agent: string }>;
}) {
  const { workspace: slug, agent: agentName } = await params;
  const { session, workspace, repo, agent, raw, canonicalName, locked } =
    await loadAgentContext(slug, agentName);

  const [currentUserRole, temboConfigured, stable, owner, allMembers] =
    await Promise.all([
      getWorkspaceRole(workspace.id, session.user.id),
      isTemboConfiguredForUser(workspace.id, session.user.id),
      getStableVersion(workspace.id, canonicalName),
      getAgentOwner(workspace.id, canonicalName),
      listWorkspaceMembers(workspace.id),
    ]);

  const canEdit = meetsMinRole(currentUserRole, "operator");
  const isAdmin = currentUserRole === "workspace_admin";
  const runAsMembers = isAdmin
    ? allMembers.map((m) => ({ userId: m.userId, name: m.name, email: m.email }))
    : undefined;

  // Disambiguate display names by email when two members share a name.
  const nameCounts = new Map<string, number>();
  for (const m of allMembers) {
    if (m.name) nameCounts.set(m.name, (nameCounts.get(m.name) ?? 0) + 1);
  }
  const nameFor = (userId: string): string => {
    const m = allMembers.find((x) => x.userId === userId);
    if (!m) return "unknown";
    if (!m.name) return m.email;
    return (nameCounts.get(m.name) ?? 0) > 1 ? `${m.name} (${m.email})` : m.name;
  };
  const ownerLabel = owner ? nameFor(owner.ownerUserId) : null;
  const pendingDraft = agent.ok
    ? pendingDraftFromContent({
        agentName: canonicalName,
        agentPath: agent.path,
        sourceContent: raw,
        stable,
      })
    : null;
  const draftChangedAt = pendingDraft
    ? await getDraftChangedAt(workspace.id, agent.path)
    : null;
  const canPromote =
    canEdit &&
    !locked &&
    (!owner || owner.ownerUserId === session.user.id || isAdmin);
  // No GitHub source URL for local-agents dev mode (no connected repo).
  const sourceHref = repo
    ? `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${agent.path}`
    : null;

  // External services the agent declares, deduped by slug, for the icon row.
  const connectionIcons: ConnectionIconItem[] = [];
  if (agent.ok && agent.spec.framework === "pydantic-agentspec") {
    const seen = new Set<string>();
    for (const c of agent.spec.connections) {
      const cslug = c.toolkit.trim().toLowerCase();
      if (!cslug || seen.has(cslug)) continue;
      seen.add(cslug);
      connectionIcons.push({
        slug: cslug,
        name: c.name,
        label:
          c.source === "native-mcp"
            ? (getMcpProvider(cslug)?.displayName ?? toolkitLabel(cslug))
            : toolkitLabel(cslug),
        source: c.source,
      });
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-col gap-2">
        <BackLink href={`/${workspace.slug}`} label="Agents" />
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-2">
            <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
              {agent.ok ? agentDisplayName(agent.spec) : canonicalName}
            </h1>
            {agent.ok ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {stable ? (
                  <Badge variant="green" size="small">
                    Stable v{stable.versionNumber}
                  </Badge>
                ) : (
                  <Badge variant="gray" size="small">
                    Draft only
                  </Badge>
                )}
                {locked && (
                  <Badge variant="red" size="small">
                    Locked
                  </Badge>
                )}
                <Badge variant="blue" size="small">
                  {FRAMEWORK_LABELS[agent.spec.framework]}
                </Badge>
                <Badge variant="purple" size="small">
                  {agent.spec.model ?? "—"}
                </Badge>
                <code className="text-foreground-muted text-sm">
                  {agent.filename}
                </code>
                <span className="text-foreground-muted text-sm">
                  {ownerLabel ? (
                    <>
                      Owner:{" "}
                      <span className="text-foreground-weak">{ownerLabel}</span>
                    </>
                  ) : (
                    "Unassigned"
                  )}
                </span>
              </div>
            ) : (
              <p className="text-sentiment-negative text-sm">
                Invalid agent: {agent.error}
                {agent.detail ? ` — ${agent.detail}` : ""}
              </p>
            )}
            {connectionIcons.length > 0 && (
              <AgentConnectionIcons connections={connectionIcons} />
            )}
            {agent.ok &&
              agent.spec.framework === "pydantic-agentspec" &&
              agent.spec.skills.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-foreground-muted mr-0.5 text-xs uppercase tracking-wide">
                    Skills
                  </span>
                  {agent.spec.skills.map((s) => (
                    <Link key={s} href={`/${workspace.slug}/skills`}>
                      <Badge variant="gray" size="small">
                        {s}
                      </Badge>
                    </Link>
                  ))}
                </div>
              )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {sourceHref && (
              <Button asChild variant="ghost">
                <a href={sourceHref} target="_blank" rel="noreferrer noopener">
                  View source
                </a>
              </Button>
            )}
            {agent.ok && canEdit && temboConfigured && !locked && (
              <Button asChild variant="secondary">
                <Link
                  href={`/${workspace.slug}/agents/${encodeURIComponent(canonicalName)}/chat`}
                >
                  Chat to edit
                </Link>
              </Button>
            )}
            {agent.ok && canEdit && !locked && (
              <ForkAgentButton
                workspaceSlug={workspace.slug}
                agentName={canonicalName}
              />
            )}
            {agent.ok && canEdit && (
              <RunNowButton
                workspaceSlug={workspace.slug}
                agentName={canonicalName}
                members={runAsMembers}
                currentUserId={session.user.id}
                stableVersion={stable?.versionNumber}
              />
            )}
          </div>
        </div>
        {agent.ok && agent.spec.description && (
          <p className="text-foreground-weak max-w-prose text-sm leading-6">
            {agent.spec.description}
          </p>
        )}
      </div>

      {pendingDraft && canEdit && (
        <DraftChangesBanner
          workspaceSlug={workspace.slug}
          agentName={canonicalName}
          reviewHref={
            locked
              ? `/${workspace.slug}/agents/${encodeURIComponent(canonicalName)}/definition`
              : `/${workspace.slug}/agents/${encodeURIComponent(canonicalName)}/versions`
          }
          canPromote={canPromote}
          stableVersionNumber={pendingDraft.stableVersionNumber}
          stableChangedAtIso={
            pendingDraft.stableChangedAt?.toISOString() ?? null
          }
          draftChangedAtIso={draftChangedAt?.toISOString() ?? null}
          addedLines={pendingDraft.diffStats.added}
          removedLines={pendingDraft.diffStats.removed}
        />
      )}

      <hr className="border-[var(--color-border-weak)]" />

      <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:gap-10">
        <AgentNav
          workspaceSlug={workspace.slug}
          agentName={canonicalName}
          locked={locked}
          pendingPromotion={pendingDraft !== null}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-8">{children}</div>
      </div>
    </div>
  );
}
