import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { Toaster } from "@/components/toaster";
import { listErroredEnabledAutomations } from "@/lib/automations-api";
import {
  buildConnectionSlotSets,
  isAgentConnectionMissing,
} from "@/lib/connection-checks";
import { listConnectionsForUser } from "@/lib/composio-connections";
import { listNativeConnectionsForUser } from "@/lib/connections";
import { FAVICON_ASSET_VERSION } from "@/lib/favicon-constants";
import { listSecretConnections } from "@/lib/secret-connections";
import { listFailingAgents24h } from "@/lib/runs-db";
import { getServerSession } from "@/lib/session";
import { listAgents } from "@/lib/workspace-agents";
import {
  getWorkspaceBySlug,
  getWorkspaceRole,
  getWorkspaceSecretPreview,
  listWorkspacesForUser,
  resolveWorkspaceSlugAlias,
  touchWorkspaceLastVisited,
  userIsMember,
} from "@/lib/workspace";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ workspace: string }>;
}): Promise<Metadata> {
  const { workspace: slug } = await params;
  // Point at our favicon route handler — it resolves the workspace's
  // chosen default or streams the custom blob. Append a `?v=<kind>`
  // cache-buster: browsers cache favicons per-origin hard (a hard
  // refresh won't clear them), so without a changing URL a stale entry
  // (e.g. from before the icon was wired up, or the previous choice)
  // sticks. Keying on faviconKind changes the URL whenever the default
  // kind changes; custom uploads stay fresh via the route's
  // must-revalidate header. The FAVICON_ASSET_VERSION suffix versions
  // the default SVG artwork itself, so a redesign of the static icons
  // refetches even when the kind is unchanged.
  const ws = await getWorkspaceBySlug(slug);
  const kind = ws ? encodeURIComponent(ws.faviconKind) : "default";
  const v = `${kind}-${FAVICON_ASSET_VERSION}`;
  const href = `/api/workspaces/${encodeURIComponent(slug)}/favicon?v=${v}`;
  return {
    icons: { icon: href, shortcut: href, apple: href },
  };
}

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;

  const session = await getServerSession();
  if (!session) notFound();

  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) {
    // The slug may be a workspace's *old* slug (renamed). If so, redirect to
    // its current slug, preserving the rest of the path so deep links survive.
    // `x-pathname` is set by proxy.ts; fall back to the workspace root.
    const canonical = await resolveWorkspaceSlugAlias(slug);
    if (canonical) {
      const pathname = (await headers()).get("x-pathname") ?? `/${slug}`;
      const rest = pathname.startsWith(`/${slug}/`)
        ? pathname.slice(`/${slug}`.length)
        : "";
      redirect(`/${canonical}${rest}`);
    }
    notFound();
  }

  const isMember = await userIsMember(workspace.id, session.user.id);
  if (!isMember) notFound();

  // Fire-and-forget last-visited bump so the "/" landing redirect
  // returns the user here next session. Doesn't block render.
  void touchWorkspaceLastVisited(workspace.id, session.user.id);

  // Compute "Connect X for agent Y" alerts the sidebar surfaces when
  // an agent declares a Composio toolkit the CURRENT user hasn't
  // authorized yet. Connections are now per-user (migration 0022),
  // so each member sees their own gaps — not the workspace's. Lets
  // a new team member know exactly which toolkits they need to
  // authorize themselves vs which their team has already covered.
  //
  // Both fetches are tolerated to fail (no repo, invalid GitHub
  // token, Composio query error) — the sidebar drops the alerts
  // section in that case rather than blocking page render.
  const [
    workspaces,
    agentsListing,
    myConnections,
    myNativeConnections,
    workspaceSecrets,
    failingAgents,
    erroredAutomations,
    anthropicKey,
    openaiKey,
    role,
  ] = await Promise.all([
    listWorkspacesForUser(session.user.id),
    listAgents(workspace.id).catch(() => null),
    listConnectionsForUser(workspace.id, session.user.id).catch(() => []),
    listNativeConnectionsForUser(workspace.id, session.user.id).catch(() => []),
    listSecretConnections(workspace.id).catch(() => []),
    listFailingAgents24h(workspace.id, session.user.id).catch(() => []),
    listErroredEnabledAutomations(workspace.id).catch(() => []),
    getWorkspaceSecretPreview(workspace.id, "anthropic_api_key").catch(
      () => null,
    ),
    getWorkspaceSecretPreview(workspace.id, "openai_api_key").catch(() => null),
    getWorkspaceRole(workspace.id, session.user.id).catch(() => null),
  ]);
  // Agents run on the workspace's own provider keys; with neither set,
  // every run fails immediately. Surface a sidebar CTA so a new
  // workspace's first job is obvious.
  const hasLlmProvider = anthropicKey !== null || openaiKey !== null;
  const switcherList = workspaces.map((w) => ({ slug: w.slug, name: w.name }));
  // Slot inventory + the missing-slot predicate are shared with the run-blocking
  // pre-flight (findMissingConnections) so the sidebar and the runtime agree —
  // crucially including the native single-connection fallback (an agent pins a
  // slot by name, but a user with exactly one connection for that provider runs
  // fine regardless of the name, so it isn't "missing"). They drifted before:
  // the sidebar lacked the fallback and nagged "Attio (tembo) Connect" even
  // though the agent ran.
  const slotSets = buildConnectionSlotSets(
    myConnections,
    myNativeConnections,
    workspaceSecrets,
  );
  const missingConnections: {
    toolkit: string;
    name: string;
    agentName: string;
    source: "composio" | "native-mcp" | "secret";
  }[] = [];
  if (agentsListing && agentsListing.ok) {
    for (const a of agentsListing.agents) {
      if (!a.ok) continue;
      if (a.spec.framework !== "pydantic-agentspec") continue;
      for (const conn of a.spec.connections) {
        const toolkit = conn.toolkit.trim().toLowerCase();
        const name = conn.name.trim().toLowerCase() || "default";
        if (!toolkit) continue;
        if (!isAgentConnectionMissing(conn.source, toolkit, name, slotSets)) {
          continue;
        }
        missingConnections.push({
          toolkit,
          // Secrets are workspace-level (one shared key); normalize the slot.
          name: conn.source === "secret" ? "default" : name,
          agentName: a.spec.name,
          source: conn.source,
        });
      }
    }
  }

  // Cap the failing-agents alert at 5 so the sidebar can't grow
  // unbounded if a workspace has many broken agents at once. The
  // full list lives on the workspace dashboard's "Top failing
  // agents" section.
  const failingAlerts = failingAgents.slice(0, 5).map((f) => ({
    agentName: f.agentName,
    failures: f.failures,
    lastFailureAtIso: f.lastFailureAt.toISOString(),
  }));

  return (
    <AppShell
      workspace={workspace}
      workspaces={switcherList}
      user={session.user}
      role={role}
      missingConnections={missingConnections}
      failingAgents={failingAlerts}
      erroredAutomations={erroredAutomations.map((a) => ({
        id: a.id,
        name: a.name,
        agentName: a.agentName,
      }))}
      hasLlmProvider={hasLlmProvider}
    >
      {children}
      <Toaster />
    </AppShell>
  );
}
