import Link from "next/link";
import type { ReactNode } from "react";

import { DocsSidebarLink } from "@/components/docs-sidebar-link";
import { ActionNeeded } from "@/components/action-needed";
import { SidebarNav } from "@/components/sidebar-nav";
import { countActiveInboxItems } from "@/lib/inbox-api";
import { Button } from "@/components/ui/button";
import { UserMenu } from "@/components/user-menu";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { toolkitLabel } from "@/lib/composio";
import { getMcpProvider } from "@/lib/mcp-providers";
import { getInstanceName } from "@/lib/instance-settings";
import { isInstanceAdmin as checkInstanceAdmin } from "@/lib/instance";
import type { WorkspaceRole } from "@/lib/rbac";
import type { Workspace } from "@/lib/workspace";
import { IconExclamationTriangle } from "central-icons";

// Layout shell shared by every signed-in workspace route. Modeled on
// Tembo's apps/web sidebar pattern — fixed-width left rail, top bar
// owned by the page, content in a scrollable column. Intentionally
// slimmer than the full @tembo/ui Sidebar primitive (no collapse,
// no mobile drawer, no keyboard shortcuts) — those can land later
// once we have routes that justify the surface area.

type MissingConnection = {
  toolkit: string;
  /** Named slot — "default" or a user-chosen alias like "work". */
  name: string;
  agentName: string;
  /** Which substrate the agent's entry targets. Drives the authorize
   *  URL and the displayed label — Composio + Native MCP have
   *  separate connection sets per user; "secret" is a workspace-level
   *  API key set under Connections → Secrets. */
  source: "composio" | "native-mcp" | "secret";
};

type FailingAgentAlert = {
  agentName: string;
  failures: number;
  /** ISO string so the prop is plain-data crossable. */
  lastFailureAtIso: string;
};

type ErroredAutomationAlert = {
  id: string;
  name: string;
  agentName: string;
};

type PendingPromotionAlert = {
  agentName: string;
};

type Props = {
  workspace: Workspace;
  workspaces: { slug: string; name: string }[];
  user: { id: string; name?: string | null; email: string };
  /** The user's role in this workspace, shown as a badge by their name. */
  role?: WorkspaceRole | null;
  /**
   * (toolkit, agent) pairs where an agent in this workspace declared
   * a Composio toolkit the workspace hasn't authorized. Rendered as
   * a list of "Connect X for Y" alerts in the sidebar — clicking
   * jumps to Settings → Connections so the user can authorize.
   */
  missingConnections: MissingConnection[];
  /**
   * Agents that have failed at least once in the last 24h. Rendered
   * above the missing-connection alerts so the loudest signal
   * (something broke recently) leads. Capped upstream so the rail
   * doesn't grow unbounded.
   */
  failingAgents: FailingAgentAlert[];
  /** Enabled schedules whose most recent firing attempt was skipped. */
  erroredAutomations: ErroredAutomationAlert[];
  /** Agent drafts that differ from stable and need an explicit promotion. */
  pendingPromotions: PendingPromotionAlert[];
  /** False when the workspace has neither an Anthropic nor OpenAI key —
   *  agents can't run, so the sidebar shows a "add an LLM key" CTA. */
  hasLlmProvider: boolean;
  children: ReactNode;
};

export async function AppShell({
  workspace,
  workspaces,
  user,
  role,
  missingConnections,
  failingAgents,
  erroredAutomations,
  pendingPromotions,
  hasLlmProvider,
  children,
}: Props) {
  const instanceName = await getInstanceName();
  const isInstanceAdmin = await checkInstanceAdmin(user.email);
  const home = `/${workspace.slug}`;
  const inboxCount = await countActiveInboxItems(workspace.id, user.id);

  // Collapse missing-connection alerts by the connection itself (substrate +
  // toolkit + slot). One HubSpot app needed by three agents is a single card
  // ("HubSpot for 3 agents"), not three identical ones stacked in the rail.
  const groupedMissing = (() => {
    const groups = new Map<
      string,
      { rep: MissingConnection; agentNames: string[] }
    >();
    for (const m of missingConnections) {
      const key = `${m.source}:${m.toolkit}:${m.name}`;
      const g = groups.get(key);
      if (g) {
        if (!g.agentNames.includes(m.agentName)) g.agentNames.push(m.agentName);
      } else {
        groups.set(key, { rep: m, agentNames: [m.agentName] });
      }
    }
    return [...groups.values()];
  })();

  return (
    <div className="bg-surface flex min-h-screen">
      {/* sticky h-screen so the sidebar stays put while the main
          column scrolls — user menu always reachable at the bottom
          regardless of how tall the content gets. Inner nav scrolls
          on overflow rather than pushing the footer off-screen. */}
      <aside className="bg-surface-secondary border-border sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r">
        {/* py-3 matches the TopBar height. Whitespace, not borders,
            does the visual separation between sections — keeps the
            sidebar quieter so the Action needed cards (when present)
            land as the loudest thing in the rail. */}
        <div className="flex flex-col gap-0.5 px-3 py-3">
          <span className="text-foreground-muted text-sm font-medium uppercase tracking-widest">
            {instanceName}
          </span>
          <WorkspaceSwitcher
            current={{ slug: workspace.slug, name: workspace.name }}
            workspaces={workspaces}
            canCreateWorkspace={isInstanceAdmin}
          />
        </div>

        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3 pt-6">
          <SidebarNav home={home} inboxCount={inboxCount} />

          <ActionNeeded
            hasStaticContent={
              !hasLlmProvider ||
              erroredAutomations.length > 0 ||
              pendingPromotions.length > 0 ||
              failingAgents.length > 0
            }
            staticContent={
              <>
                {!hasLlmProvider && (
                  <div className="flex items-start gap-2 rounded-md bg-[var(--color-sentiment-caution-subtle)] px-2 py-2">
                    <IconExclamationTriangle
                      size={14}
                      className="mt-0.5 shrink-0 text-[var(--color-icon-sentiment-caution)]"
                    />
                    <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
                      <span className="text-sm leading-tight text-[var(--color-foreground-sentiment-caution)]">
                        <span className="font-semibold">
                          LLM provider needed
                        </span>{" "}
                        — add an Anthropic or OpenAI key to run agents
                      </span>
                      <Button asChild variant="orange" size="small">
                        <Link href={`/${workspace.slug}/settings/providers`}>
                          Add a key
                        </Link>
                      </Button>
                    </div>
                  </div>
                )}
                {pendingPromotions.length > 0 && (
                  <div className="flex items-start gap-2 rounded-md bg-[var(--color-sentiment-caution-subtle)] px-2 py-2">
                    <IconExclamationTriangle
                      size={14}
                      className="mt-0.5 shrink-0 text-[var(--color-icon-sentiment-caution)]"
                    />
                    <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
                      <span className="text-sm leading-tight text-[var(--color-foreground-sentiment-caution)]">
                        <span className="font-semibold">
                          {pendingPromotions.length === 1
                            ? pendingPromotions[0].agentName
                            : `${pendingPromotions.length} agent drafts`}
                        </span>{" "}
                        {pendingPromotions.length === 1
                          ? "has changes awaiting promotion"
                          : "are awaiting promotion"}
                      </span>
                      <Button asChild variant="orange" size="small">
                        <Link
                          href={
                            pendingPromotions.length === 1
                              ? `/${workspace.slug}/agents/${encodeURIComponent(pendingPromotions[0].agentName)}/versions`
                              : `/${workspace.slug}?promotion=pending`
                          }
                        >
                          Review
                        </Link>
                      </Button>
                    </div>
                  </div>
                )}
                {erroredAutomations.map((automation) => (
                  <div
                    key={`automation:${automation.id}`}
                    className="flex items-start gap-2 rounded-md bg-[var(--color-sentiment-negative-subtle)] px-2 py-2"
                  >
                    <IconExclamationTriangle
                      size={14}
                      className="text-sentiment-negative mt-0.5 shrink-0"
                    />
                    <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
                      <span className="text-sentiment-negative text-sm leading-tight">
                        <span className="font-semibold">{automation.name}</span>{" "}
                        did not fire for {automation.agentName}
                      </span>
                      <Button asChild variant="destructive" size="small">
                        <Link
                          href={`/${workspace.slug}/automations/${automation.id}`}
                        >
                          Open
                        </Link>
                      </Button>
                    </div>
                  </div>
                ))}
                {failingAgents.map((f) => {
                  const agentHref = `/${workspace.slug}/agents/${encodeURIComponent(f.agentName)}`;
                  return (
                    <div
                      key={`fail:${f.agentName}`}
                      className="flex items-start gap-2 rounded-md bg-[var(--color-sentiment-negative-subtle)] px-2 py-2"
                    >
                      <IconExclamationTriangle
                        size={14}
                        className="text-sentiment-negative mt-0.5 shrink-0"
                      />
                      <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
                        <span className="text-sentiment-negative text-sm leading-tight">
                          <span className="font-semibold">{f.agentName}</span>{" "}
                          failed{" "}
                          <span className="font-semibold">{f.failures}×</span> in
                          24h
                        </span>
                        <Button asChild variant="destructive" size="small">
                          <Link href={agentHref}>Open</Link>
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </>
            }
            missingItems={groupedMissing.map(({ rep: m, agentNames }) => {
              // Authorize endpoint differs per substrate: Composio is one route
              // per workspace (toolkit in query string), Native MCP one route per
              // provider (provider in path), secrets link to the Secrets tab.
              // Dispatch by source so Connect lands on the right flow.
              let href: string;
              let providerLabel: string;
              if (m.source === "secret") {
                href = `/${workspace.slug}/connections/secrets`;
                providerLabel = m.toolkit;
              } else if (m.source === "native-mcp") {
                const params = new URLSearchParams({ workspace: workspace.slug });
                if (m.name && m.name !== "default") params.set("name", m.name);
                href = `/api/connections/native/${m.toolkit}/authorize?${params.toString()}`;
                providerLabel =
                  getMcpProvider(m.toolkit)?.displayName ?? m.toolkit;
              } else {
                const params = new URLSearchParams({
                  workspace: workspace.slug,
                  toolkit: m.toolkit,
                });
                if (m.name && m.name !== "default") params.set("name", m.name);
                href = `/api/connections/composio/authorize?${params.toString()}`;
                providerLabel = toolkitLabel(m.toolkit);
              }
              const label =
                m.name && m.name !== "default"
                  ? `${providerLabel} (${m.name})`
                  : providerLabel;
              return {
                key: `${m.source}:${m.toolkit}:${m.name}`,
                label,
                agentLabel:
                  agentNames.length === 1
                    ? agentNames[0]
                    : `${agentNames.length} agents`,
                href,
                action: m.source === "secret" ? "Set" : "Connect",
              };
            })}
          />
        </nav>

        <div className="border-border border-t px-2 pb-1 pt-2">
          <DocsSidebarLink href={`/${workspace.slug}/docs`} />
        </div>
        <div className="px-2 pb-2">
          <UserMenu
            name={user.name ?? null}
            email={user.email}
            role={role}
            isInstanceAdmin={isInstanceAdmin}
          />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
