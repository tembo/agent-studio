import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { FRAMEWORK_LABELS } from "@/lib/agent-framework";
import { agentDisplayName } from "@/lib/agent-format";
import { listPendingAgentDrafts } from "@/lib/agent-draft-status";
import { listStarredAgentNames } from "@/lib/agent-stars";
import { listOwnedAgentNames } from "@/lib/agent-versions";
import { toolkitLabel } from "@/lib/composio-label";
import { scheduleImprovementScan } from "@/lib/improvement-scan";
import {
  listPendingCreatesForWorkspace,
  reconcileLandedCreates,
} from "@/lib/improvements-api";
import { getMcpProvider } from "@/lib/mcp-providers";
import { meetsMinRole } from "@/lib/rbac";
import { listAgentSubAgentEdges } from "@/lib/run-orchestration-db";
import { listAgentSummaries30d } from "@/lib/runs-db";
import { getServerSession } from "@/lib/session";
import { isTemboConfiguredForUser } from "@/lib/tembo-credentials";
import { listAgents } from "@/lib/workspace-agents";
import {
  getWorkspaceBySlug,
  getWorkspaceRepo,
  getWorkspaceRole,
} from "@/lib/workspace";

import {
  AgentsInventory,
  type InventoryAgent,
  type McpIcon,
} from "./agents-inventory";

export const dynamic = "force-dynamic";

export default async function WorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspace: slug } = await params;
  const sp = await searchParams;
  const deletedAgentName =
    typeof sp.deleted === "string" ? sp.deleted : null;
  const initialPromotionOnly = sp.promotion === "pending";

  const session = await getServerSession();
  if (!session) notFound();

  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();

  // No repo is fine in local-agents dev mode (agents load from
  // TAS_LOCAL_AGENTS_DIR); otherwise send the user to connect a repo first.
  const repo = await getWorkspaceRepo(workspace.id);
  if (!repo && !process.env.TAS_LOCAL_AGENTS_DIR?.trim()) {
    redirect(`/onboarding/repo?ws=${encodeURIComponent(workspace.slug)}`);
  }

  const [
    temboConfigured,
    agentsResult,
    pendingStored,
    currentUserRole,
    starredNames,
    ownedNames,
  ] = await Promise.all([
    isTemboConfiguredForUser(workspace.id, session.user.id),
    listAgents(workspace.id),
    listPendingCreatesForWorkspace(workspace.id),
    getWorkspaceRole(workspace.id, session.user.id),
    listStarredAgentNames(workspace.id, session.user.id),
    listOwnedAgentNames(workspace.id, session.user.id),
  ]);
  const canEdit = meetsMinRole(currentUserRole, "operator");
  const pendingDrafts = await listPendingAgentDrafts(
    workspace.id,
    agentsResult,
    { includeDraftChangedAt: true },
  );
  const pendingDraftsByName = new Map(
    pendingDrafts.map((draft) => [draft.agentName, draft]),
  );

  const validNames = agentsResult.ok
    ? agentsResult.agents.filter((a) => a.ok).map((a) => a.spec.name)
    : [];

  // Auto-reconcile ghost Pending cards: if a create's agent has already landed
  // in the repo (file present at its path, or a live agent under its name),
  // close the row now — the marker-based commit scan can't always attach a
  // commit_url, which otherwise leaves a direct-commit create stuck Pending
  // forever. All repo files (parsing or not) count as "landed" via path; only
  // run when the repo was actually read (agentsResult.ok) so a failed listing
  // isn't misread as "nothing landed". Drop the closed ids from the in-memory
  // pending list so they don't render this pass.
  const livePaths = agentsResult.ok
    ? agentsResult.agents.map((a) => a.path)
    : [];
  const reconciledIds = new Set(
    await reconcileLandedCreates(workspace.id, livePaths, validNames),
  );
  const pendingActive = pendingStored.filter((p) => !reconciledIds.has(p.id));

  const [summaries, subAgentEdges] = await Promise.all([
    listAgentSummaries30d(workspace.id, validNames),
    listAgentSubAgentEdges(workspace.id),
  ]);

  // Per-agent top-level MCP icons, from each spec's declared connections
  // (deduped by provider slug). Also drives the orchestrators' sub-agent
  // rollup below.
  const mcpsByAgent = new Map<string, McpIcon[]>();
  if (agentsResult.ok) {
    for (const a of agentsResult.agents) {
      if (!a.ok || a.spec.framework !== "pydantic-agentspec") continue;
      const seen = new Set<string>();
      const icons: McpIcon[] = [];
      for (const c of a.spec.connections) {
        const slug = c.toolkit.trim().toLowerCase();
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);
        icons.push({
          slug,
          label:
            c.source === "native-mcp"
              ? (getMcpProvider(slug)?.displayName ?? toolkitLabel(slug))
              : toolkitLabel(slug),
        });
      }
      mcpsByAgent.set(a.spec.name, icons);
    }
  }

  // Which sub-agents each orchestrator spawned (orchestrator_run_id graph) → the
  // union of those sub-agents' MCPs, minus the ones the orchestrator already
  // declares itself. Lets the list show "top-level MCPs + sub-agent MCPs".
  const subAgentNamesByOrchestrator = new Map<string, Set<string>>();
  for (const e of subAgentEdges) {
    let set = subAgentNamesByOrchestrator.get(e.orchestratorAgentName);
    if (!set) {
      set = new Set<string>();
      subAgentNamesByOrchestrator.set(e.orchestratorAgentName, set);
    }
    set.add(e.subAgentName);
  }
  const subMcpsByAgent = new Map<string, McpIcon[]>();
  for (const [orchestrator, subAgents] of subAgentNamesByOrchestrator) {
    const own = new Set((mcpsByAgent.get(orchestrator) ?? []).map((m) => m.slug));
    const seen = new Set<string>();
    const icons: McpIcon[] = [];
    for (const subAgent of subAgents) {
      for (const m of mcpsByAgent.get(subAgent) ?? []) {
        if (own.has(m.slug) || seen.has(m.slug)) continue;
        seen.add(m.slug);
        icons.push(m);
      }
    }
    if (icons.length > 0) subMcpsByAgent.set(orchestrator, icons);
  }

  // Refresh PR state after this response. Pending creates remain visible for
  // at most one extra navigation while GitHub reconciliation catches up.
  scheduleImprovementScan(workspace.id, pendingActive);
  const pending = pendingActive.filter(
    (p) =>
      p.status === "submitted" ||
      p.status === "pr_opened" ||
      // YOLO creates are optimistically 'committed' the moment CAP accepts
      // them, before the file lands. Keep the pending card until the scan
      // attaches the commit URL (matches listPendingCreatesForWorkspace).
      (p.delivery === "direct" && p.status === "committed" && !p.commitUrl),
  );

  // Live agents have names sourced from the parsed spec. If a pending
  // create's intended name already matches a live agent — meaning the
  // PR merged and the file landed before we caught the status change —
  // drop the pending row so we don't double-render.
  const liveNames = new Set(validNames);

  const inventoryAgents: InventoryAgent[] = agentsResult.ok
    ? agentsResult.agents
        // Defensive filter against the GitHub fetch cache returning
        // a just-deleted file. ?deleted=<name> arrives via the post-
        // delete redirect (see deleteAgentAction); even if the next
        // listAgents call hasn't picked up the deletion yet, we hide
        // the row so the user gets immediate visual confirmation.
        .filter((a) =>
          deletedAgentName && a.ok ? a.spec.name !== deletedAgentName : true,
        )
        .map((a): InventoryAgent => {
          if (!a.ok) {
            return {
              kind: "invalid",
              path: a.path,
              filename: a.filename,
              error: a.error,
              detail: a.detail,
            };
          }
          const s = summaries.get(a.spec.name);
          const pendingDraft = pendingDraftsByName.get(a.spec.name) ?? null;
          return {
            kind: "live",
            path: a.path,
            filename: a.filename,
            name: a.spec.name,
            displayName: agentDisplayName(a.spec),
            description: a.spec.description?.trim() || null,
            detailHref: `/${workspace.slug}/agents/${encodeURIComponent(a.spec.name)}`,
            frameworkLabel: FRAMEWORK_LABELS[a.spec.framework],
            labels: a.spec.labels,
            mcps: mcpsByAgent.get(a.spec.name) ?? [],
            subMcps: subMcpsByAgent.get(a.spec.name) ?? [],
            model: a.spec.model ?? null,
            runs30d: s?.totalRuns30d ?? 0,
            succeeded30d: s?.succeeded30d ?? 0,
            failed30d: s?.failed30d ?? 0,
            avgCostUsd30d: s?.avgCostUsd30d ?? null,
            lastRun:
              s?.lastRunStatus && s.lastRunAt
                ? {
                    status: s.lastRunStatus,
                    createdAtIso: s.lastRunAt.toISOString(),
                  }
                : null,
            isStarred: starredNames.has(a.spec.name),
            isMine: ownedNames.has(a.spec.name),
            pendingPromotion: pendingDraft
              ? {
                  href: `/${workspace.slug}/agents/${encodeURIComponent(a.spec.name)}/versions`,
                  stableVersionNumber: pendingDraft.stableVersionNumber,
                  stableChangedAtIso:
                    pendingDraft.stableChangedAt?.toISOString() ?? null,
                  draftChangedAtIso:
                    pendingDraft.draftChangedAt?.toISOString() ?? null,
                  addedLines: pendingDraft.diffStats.added,
                  removedLines: pendingDraft.diffStats.removed,
                }
              : null,
          };
        })
    : [];

  // Append pending creates so the inventory sees them. The default
  // sort surfaces them above idle agents (Pending sorts before Active
  // / Idle in STATUS_META).
  for (const p of pending) {
    if (liveNames.has(p.agentName)) continue;
    const framework = p.agentPath.startsWith("agents/cargo-ai/")
      ? "cargo-ai"
      : "pydantic-agentspec";
    inventoryAgents.push({
      kind: "pending-create",
      key: p.id,
      name: p.agentName,
      path: p.agentPath,
      frameworkLabel: FRAMEWORK_LABELS[framework],
      createdAtIso: p.createdAt.toISOString(),
      status: p.status === "pr_opened" ? "pr_opened" : "submitted",
      temboTaskHtmlUrl: p.temboTaskHtmlUrl,
      prUrl: p.prUrl,
      prNumber: p.prNumber,
    });
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
          Agents
        </h1>
      </div>

      <hr className="border-[var(--color-border-weak)]" />

      {deletedAgentName && (
        <div className="border-sentiment-positive bg-[var(--color-sentiment-positive-subtle)] rounded-lg border px-3 py-2 text-sm">
          <span className="text-foreground">
            Deleted{" "}
            <code className="bg-surface rounded px-1 py-0.5 text-sm">
              {deletedAgentName}
            </code>
            . The file&apos;s gone from the repo; restore it from{" "}
            <Link
              href={`/${workspace.slug}/settings`}
              className="text-foreground underline underline-offset-2"
            >
              Settings → Deleted agents
            </Link>{" "}
            if you change your mind.
          </span>
        </div>
      )}

      {!temboConfigured && (
        <div className="bg-surface-raised border-border flex flex-col gap-2 rounded-lg border p-4">
          <h2 className="text-foreground text-sm font-medium">
            Connect a Tembo account
          </h2>
          <p className="text-foreground-weak text-base">
            Connect your personal Tembo account, or ask an admin to configure
            the workspace fallback account, to create, edit, and improve agents
            through Tembo. Running an existing agent uses your Anthropic or
            OpenAI key separately.
          </p>
          <div>
            <Link
              href={`/${workspace.slug}/settings/tembo`}
              className="text-foreground hover:underline text-sm font-medium"
            >
              Open Tembo settings →
            </Link>
          </div>
        </div>
      )}

      {!agentsResult.ok ? (
        <div className="text-sentiment-negative text-sm">
          Couldn&apos;t list agents: {agentsResult.error}
          {agentsResult.detail ? ` — ${agentsResult.detail}` : ""}
        </div>
      ) : (
        <AgentsInventory
          key={initialPromotionOnly ? "pending-promotions" : "all-agents"}
          agents={inventoryAgents}
          newAgentHref={`/${workspace.slug}/agents/new`}
          canCreate={canEdit && temboConfigured}
          workspaceSlug={workspace.slug}
          canEdit={canEdit}
          initialPromotionOnly={initialPromotionOnly}
        />
      )}
    </div>
  );
}
