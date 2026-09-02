import { notFound } from "next/navigation";

import { Section } from "@/components/section";

import { loadAgentContext } from "../agent-page-context";

export const dynamic = "force-dynamic";

export default async function AgentCodePage({
  params,
}: {
  params: Promise<{ workspace: string; agent: string }>;
}) {
  const { workspace: slug, agent: agentName } = await params;
  const { agent, toolsModuleContent } = await loadAgentContext(slug, agentName);

  const toolsModule =
    agent.ok && agent.spec.framework === "pydantic-agentspec"
      ? agent.spec.toolsModule
      : undefined;
  if (!toolsModule) notFound();

  return (
    <Section
      title="Tools module"
      description={`Deterministic Python functions the model calls as tools, from ${toolsModule}${toolsModuleContent ? ` · ${countLines(toolsModuleContent)} lines` : ""}. Runs in the agent's process with no token cost.`}
    >
      {toolsModuleContent ? (
        <pre className="bg-surface border-border text-foreground overflow-x-auto rounded-lg border p-4 font-mono text-sm leading-5">
          {toolsModuleContent}
        </pre>
      ) : (
        <p className="text-sentiment-negative text-sm">
          The spec references <code className="font-mono">{toolsModule}</code>{" "}
          but it couldn&apos;t be read from the repo. Runs will fail until the
          file is added next to the agent.
        </p>
      )}
    </Section>
  );
}

function countLines(source: string): number {
  const content = source.trimEnd();
  return content ? content.split(/\r\n|\r|\n/).length : 0;
}
