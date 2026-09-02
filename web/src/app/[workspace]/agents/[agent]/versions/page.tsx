import { redirect } from "next/navigation";

import { LocalTime } from "@/components/local-time";
import { Section } from "@/components/section";
import { evalSidecarCandidates } from "@/lib/agent-evals";
import { getLatestEvalRun } from "@/lib/agent-evals-db";
import { readEvalSuite } from "@/lib/agent-evals-run";
import { detectAgentSpecLanguage } from "@/lib/agent-spec-highlight";
import {
  getAgentOwner,
  getStableVersion,
  listAgentVersions,
} from "@/lib/agent-versions";
import { listFileCommits, type FileCommit } from "@/lib/github";
import { meetsMinRole } from "@/lib/rbac";
import {
  getWorkspaceRole,
  getWorkspaceSecretPlaintext,
  listWorkspaceMembers,
} from "@/lib/workspace";

import { loadAgentContext } from "../agent-page-context";
import { EvalsSection } from "../evals-section";
import {
  countSourceLines,
  HighlightedSpec,
} from "../highlighted-spec";
import { PromoteButton } from "../promote-button";
import { VersionsSection } from "../versions-section";
import { VersionsSourceTabs } from "./versions-source-tabs";
import {
  SpecVersionViewer,
  type SpecVersionItem,
} from "../definition/spec-version-viewer";

export const dynamic = "force-dynamic";

// Versions tab — promote + numbered snapshots, then a horizontal bar for
// definition / evals / eval file / linked code.

export default async function AgentVersionsPage({
  params,
}: {
  params: Promise<{ workspace: string; agent: string }>;
}) {
  const { workspace: slug, agent: agentName } = await params;
  const {
    session,
    workspace,
    repo,
    agent,
    raw,
    toolsModuleContent,
    canonicalName,
    locked,
  } = await loadAgentContext(slug, agentName);
  if (locked) {
    redirect(`/${slug}/agents/${encodeURIComponent(canonicalName)}`);
  }

  const agentPath = agent.ok ? agent.path : null;
  const toolsModule =
    agent.ok && agent.spec.framework === "pydantic-agentspec"
      ? agent.spec.toolsModule
      : undefined;

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

  let commits: FileCommit[] = [];
  if (repo && agent.path) {
    try {
      const token = await getWorkspaceSecretPlaintext(
        workspace.id,
        "github_pat",
      );
      const res = await listFileCommits(
        token,
        { owner: repo.owner, name: repo.name, branch: repo.defaultBranch },
        agent.path,
        50,
      );
      if (res.ok) commits = res.commits;
    } catch {
      /* omit history */
    }
  }

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

  const specLanguage = detectAgentSpecLanguage(
    raw,
    agent.ok ? agent.spec.framework : undefined,
  );
  const draftDiffers = stable ? stable.specContent !== raw : versions.length > 0;
  const specItems: SpecVersionItem[] = [
    {
      id: "draft",
      label: draftDiffers ? "Draft (current file)" : "Draft",
      block: <HighlightedSpec source={raw} language={specLanguage} />,
      source: raw,
    },
    ...versions.map((v) => ({
      id: `v${v.versionNumber}`,
      label:
        stable?.versionNumber === v.versionNumber
          ? `v${v.versionNumber} · stable`
          : `v${v.versionNumber}`,
      block: (
        <HighlightedSpec source={v.specContent} language={specLanguage} />
      ),
      source: v.specContent,
    })),
  ];

  const evalPath =
    evalSuite?.path ??
    (agentPath ? evalSidecarCandidates(agentPath)[0] : null);
  const evalContent = evalSuite?.content ?? null;
  const evalLanguage = evalContent
    ? detectAgentSpecLanguage(evalContent)
    : "yaml";

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

      <VersionsSection
        versions={versions}
        stableVersionId={stable?.id ?? null}
        workspaceSlug={workspace.slug}
        agentName={canonicalName}
        nameFor={nameFor}
      />

      <VersionsSourceTabs
        tabs={[
          {
            id: "definition",
            label: "Definition",
            content: (
              <>
                {commits.length > 0 && repo && (
                  <Section
                    title="Git history"
                    description="Every version of this spec file that landed on GitHub, newest first."
                  >
                    <ul className="flex max-h-80 flex-col divide-y divide-[var(--color-border-weak)] overflow-y-auto">
                      {commits.map((c) => (
                        <li
                          key={c.sha}
                          className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2 text-sm"
                        >
                          <a
                            href={`https://github.com/${repo.owner}/${repo.name}/blob/${c.sha}/${agent.path}`}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="text-foreground-category-blue font-mono hover:underline"
                          >
                            {c.shortSha}
                          </a>
                          {c.date && (
                            <span className="text-foreground-weak">
                              <LocalTime iso={c.date} />
                            </span>
                          )}
                          <span className="text-foreground min-w-0 flex-1 truncate">
                            {c.summary}
                          </span>
                          {c.authorName && (
                            <span className="text-foreground-muted">
                              {c.authorName}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </Section>
                )}
                <Section
                  title="Definition"
                  description={`${specLanguage.toUpperCase()} · ${countSourceLines(raw)} lines. The live draft and each promoted snapshot.`}
                >
                  <SpecVersionViewer items={specItems} />
                </Section>
              </>
            ),
          },
          {
            id: "evals",
            label: "Evals",
            content: (
              <EvalsSection
                latest={latestEval}
                hasEvalFile={evalSuite !== null}
                evalPath={evalPath}
                parseError={evalSuite && !evalSuite.ok ? evalSuite.detail : null}
                canRun={canEdit && !(evalSuite && !evalSuite.ok)}
                hasStable={Boolean(stable)}
                workspaceSlug={workspace.slug}
                agentName={canonicalName}
              />
            ),
          },
          {
            id: "eval-file",
            label: "Eval file",
            content: evalContent && evalPath ? (
              <Section
                title="Eval file"
                description={`${evalPath} · ${evalLanguage.toUpperCase()} · ${countSourceLines(evalContent)} lines.`}
              >
                <HighlightedSpec source={evalContent} language={evalLanguage} />
              </Section>
            ) : (
              <Section
                title="Eval file"
                description="Colocated sidecar next to the agent spec."
              >
                <p className="text-foreground-weak rounded-lg border border-dashed border-[var(--color-border)] px-4 py-6 text-center text-sm">
                  No eval file yet
                  {evalPath ? (
                    <>
                      {" "}
                      (expected{" "}
                      <code className="text-foreground-muted">{evalPath}</code>)
                    </>
                  ) : null}
                  . Opt in when creating or editing an agent.
                </p>
              </Section>
            ),
          },
          {
            id: "code",
            label: "Code",
            content: (
              <Section
                title="Code"
                description={
                  toolsModule
                    ? `Linked tools module ${toolsModule}${toolsModuleContent ? ` · ${countSourceLines(toolsModuleContent)} lines` : ""}.`
                    : "Sidecar Python the agent declares as tools_module."
                }
              >
                {toolsModule && toolsModuleContent ? (
                  <pre className="bg-surface border-border text-foreground overflow-x-auto rounded-lg border p-4 font-mono text-sm leading-5">
                    {toolsModuleContent}
                  </pre>
                ) : toolsModule ? (
                  <p className="text-sentiment-negative text-sm">
                    The spec references{" "}
                    <code className="font-mono">{toolsModule}</code> but it
                    couldn&apos;t be read from the repo.
                  </p>
                ) : (
                  <p className="text-foreground-weak rounded-lg border border-dashed border-[var(--color-border)] px-4 py-6 text-center text-sm">
                    No linked code. A Pydantic agent can set{" "}
                    <code className="text-foreground-muted">tools_module:</code>{" "}
                    to a sibling Python file.
                  </p>
                )}
              </Section>
            ),
          },
        ]}
      />
    </>
  );
}
