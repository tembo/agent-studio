import { redirect } from "next/navigation";

import { Section } from "@/components/section";
import { evalSidecarCandidates } from "@/lib/agent-evals";
import { getLatestEvalRun } from "@/lib/agent-evals-db";
import { readEvalSuite } from "@/lib/agent-evals-run";
import {
  getAgentOwner,
  getStableVersion,
  listAgentVersions,
} from "@/lib/agent-versions";
import { meetsMinRole } from "@/lib/rbac";
import { getWorkspaceRole, listWorkspaceMembers } from "@/lib/workspace";

import { loadAgentContext } from "../agent-page-context";
import { EvalsSection } from "../evals-section";
import { PromoteButton } from "../promote-button";
import { VersionsSection } from "../versions-section";

export const dynamic = "force-dynamic";

// Versions tab — released stable snapshots (current one marked) plus the
// promote-the-draft action (moved here from the header).

export default async function AgentVersionsPage({
  params,
}: {
  params: Promise<{ workspace: string; agent: string }>;
}) {
  const { workspace: slug, agent: agentName } = await params;
  const { session, workspace, agent, raw, canonicalName, locked } =
    await loadAgentContext(slug, agentName);
  // Locked agents hide their history tabs (#12) — block the direct URL too.
  if (locked) {
    redirect(`/${slug}/agents/${encodeURIComponent(canonicalName)}`);
  }

  const agentPath = agent.ok ? agent.path : null;
  const [versions, stable, owner, allMembers, currentUserRole, latestEval, evalSuite] =
    await Promise.all([
      listAgentVersions(workspace.id, canonicalName),
      getStableVersion(workspace.id, canonicalName),
      getAgentOwner(workspace.id, canonicalName),
      listWorkspaceMembers(workspace.id),
      getWorkspaceRole(workspace.id, session.user.id),
      getLatestEvalRun(workspace.id, canonicalName),
      agentPath
        ? readEvalSuite(workspace.id, agentPath)
        : Promise.resolve(null),
    ]);

  const canEdit = meetsMinRole(currentUserRole, "operator");
  const isAdmin = currentUserRole === "workspace_admin";
  const isOwner = owner?.ownerUserId === session.user.id;
  const canPromote = canEdit && (!owner || isOwner || isAdmin);
  const draftChanged = agent.ok && (!stable || stable.specContent !== raw);
  const nextVersion = (stable?.versionNumber ?? 0) + 1;

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

  return (
    <>
      {agent.ok && canPromote && (
        <Section
          title="Promote the draft"
          description={
            draftChanged
              ? `The draft differs from the current stable. Promote it to v${nextVersion} so scheduled, Slack, and webhook runs pick it up.`
              : "The draft matches the current stable — nothing to promote."
          }
        >
          <PromoteButton
            workspaceSlug={workspace.slug}
            agentName={canonicalName}
            nextVersion={nextVersion}
            hasChanges={draftChanged}
            isOwner={isOwner}
            ownerLabel={ownerLabel}
          />
        </Section>
      )}

      <EvalsSection
        latest={latestEval}
        hasEvalFile={evalSuite !== null}
        evalPath={
          evalSuite && evalSuite.ok
            ? evalSuite.path
            : agentPath
              ? evalSidecarCandidates(agentPath)[0]
              : null
        }
        parseError={evalSuite && !evalSuite.ok ? evalSuite.detail : null}
        canRun={canEdit && !(evalSuite && !evalSuite.ok)}
        hasStable={Boolean(stable)}
        workspaceSlug={workspace.slug}
        agentName={canonicalName}
      />

      <VersionsSection
        versions={versions}
        stableVersionId={stable?.id ?? null}
        workspaceSlug={workspace.slug}
        agentName={canonicalName}
        nameFor={nameFor}
      />
    </>
  );
}
