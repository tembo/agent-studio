import { LocalTime } from "@/components/local-time";
import { Section } from "@/components/section";
import { getStableVersion, listAgentVersions } from "@/lib/agent-versions";
import {
  detectAgentSpecLanguage,
  highlightAgentSpec,
  type AgentSpecHighlightKind,
} from "@/lib/agent-spec-highlight";
import { listFileCommits, type FileCommit } from "@/lib/github";
import { getWorkspaceSecretPlaintext } from "@/lib/workspace";

import { loadAgentContext } from "../agent-page-context";
import {
  SpecVersionViewer,
  type SpecVersionItem,
} from "./spec-version-viewer";

export const dynamic = "force-dynamic";

// Definition tab — the agent spec (the live draft plus every stable version's
// snapshot, switchable), read-only. Sidecar Python lives on the Code tab.
// Edits go through Git / Chat-to-edit.

export default async function AgentDefinitionPage({
  params,
}: {
  params: Promise<{ workspace: string; agent: string }>;
}) {
  const { workspace: slug, agent: agentName } = await params;
  const { workspace, canonicalName, repo, agent, raw } =
    await loadAgentContext(slug, agentName);

  const [versions, stable] = await Promise.all([
    listAgentVersions(workspace.id, canonicalName),
    getStableVersion(workspace.id, canonicalName),
  ]);

  // Commit history of the spec file on GitHub — every version that landed in
  // the repo, newest first (distinct from the promoted stable snapshots above).
  // Skipped in local-agents dev mode (no connected repo).
  let commits: FileCommit[] = [];
  if (repo && agent.path) {
    try {
      const token = await getWorkspaceSecretPlaintext(workspace.id, "github_pat");
      const res = await listFileCommits(
        token,
        { owner: repo.owner, name: repo.name, branch: repo.defaultBranch },
        agent.path,
        50,
      );
      if (res.ok) commits = res.commits;
    } catch {
      // No token / repo unreachable — just omit the history section.
    }
  }

  const specLanguage = detectAgentSpecLanguage(
    raw,
    agent.ok ? agent.spec.framework : undefined,
  );

  // Draft first (the default view), then each version newest-first. Versions
  // are the same agent/format, so reuse the detected language.
  const draftDiffers = stable ? stable.specContent !== raw : versions.length > 0;
  const specItems: SpecVersionItem[] = [
    {
      id: "draft",
      label: draftDiffers ? "Draft (current file)" : "Draft",
      block: <HighlightedCodeBlock source={raw} language={specLanguage} />,
      source: raw,
    },
    ...versions.map((v) => ({
      id: `v${v.versionNumber}`,
      label:
        stable?.versionNumber === v.versionNumber
          ? `v${v.versionNumber} · stable`
          : `v${v.versionNumber}`,
      block: (
        <HighlightedCodeBlock source={v.specContent} language={specLanguage} />
      ),
      source: v.specContent,
    })),
  ];

  return (
    <>
      {commits.length > 0 && repo && (
        <Section
          title={`History (${commits.length})`}
          description="Every version of this spec file that landed on GitHub, newest first. Click a hash to view that version on GitHub."
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
                  <span className="text-foreground-muted">{c.authorName}</span>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section
        title="Full definition"
        description={`${specLanguage.toUpperCase()} · ${countLines(raw)} lines. Expand to view, choose a promoted version, or copy the source.`}
        collapsible
      >
        <SpecVersionViewer items={specItems} />
      </Section>
    </>
  );
}

function countLines(source: string): number {
  const content = source.trimEnd();
  return content ? content.split(/\r\n|\r|\n/).length : 0;
}

const tokenClasses: Partial<Record<AgentSpecHighlightKind, string>> = {
  key: "text-foreground-category-blue font-semibold",
  string: "text-foreground-category-green",
  number: "text-foreground-category-purple",
  literal: "text-foreground-category-orange",
  comment: "text-foreground-muted",
  punctuation: "text-foreground-weak",
};

function HighlightedCodeBlock({
  source,
  language,
}: {
  source: string;
  language: "yaml" | "json";
}) {
  const tokens = highlightAgentSpec(source, language);

  return (
    <pre className="bg-surface border-border text-foreground overflow-x-auto rounded-lg border p-4 font-mono text-sm leading-5">
      <code>
        {tokens.map((token, index) => {
          const className = tokenClasses[token.kind];
          return className ? (
            <span key={index} className={className}>
              {token.text}
            </span>
          ) : (
            token.text
          );
        })}
      </code>
    </pre>
  );
}
