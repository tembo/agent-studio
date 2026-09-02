import { Section } from "@/components/section";
import { evalSidecarCandidates } from "@/lib/agent-evals";
import { getLatestEvalRun } from "@/lib/agent-evals-db";
import { readEvalSuite } from "@/lib/agent-evals-run";
import {
  detectAgentSpecLanguage,
  highlightAgentSpec,
  type AgentSpecHighlightKind,
} from "@/lib/agent-spec-highlight";
import { getStableVersion } from "@/lib/agent-versions";
import { meetsMinRole } from "@/lib/rbac";
import { getWorkspaceRole } from "@/lib/workspace";

import { loadAgentContext } from "../agent-page-context";
import { EvalsSection } from "../evals-section";

export const dynamic = "force-dynamic";

export default async function AgentEvalPage({
  params,
}: {
  params: Promise<{ workspace: string; agent: string }>;
}) {
  const { workspace: slug, agent: agentName } = await params;
  const { session, workspace, agent, canonicalName } = await loadAgentContext(
    slug,
    agentName,
  );

  const agentPath = agent.ok ? agent.path : null;
  const [latestEval, evalSuite, stable, currentUserRole] = await Promise.all([
    getLatestEvalRun(workspace.id, canonicalName),
    agentPath ? readEvalSuite(workspace.id, agentPath) : Promise.resolve(null),
    getStableVersion(workspace.id, canonicalName),
    getWorkspaceRole(workspace.id, session.user.id),
  ]);

  const canEdit = meetsMinRole(currentUserRole, "operator");
  const evalPath =
    evalSuite?.path ??
    (agentPath ? evalSidecarCandidates(agentPath)[0] : null);
  const content = evalSuite?.content ?? null;
  const language = content ? detectAgentSpecLanguage(content) : "yaml";

  return (
    <>
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

      {content && evalPath && (
        <Section
          title="Eval file"
          description={`${evalPath} · ${language.toUpperCase()} · ${countLines(content)} lines. Edits go through Git or chat-to-edit.`}
          collapsible
          defaultOpen
        >
          <HighlightedCodeBlock source={content} language={language} />
        </Section>
      )}
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
