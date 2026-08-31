import {
  OutputsView,
  type OutputsSearchParams,
} from "@/app/[workspace]/outputs/outputs-view";
import { Section } from "@/components/section";

import { loadAgentContext } from "../agent-page-context";

export const dynamic = "force-dynamic";

export default async function AgentOutputsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; agent: string }>;
  searchParams: Promise<OutputsSearchParams>;
}) {
  const [{ workspace: slug, agent: agentName }, sp] = await Promise.all([
    params,
    searchParams,
  ]);
  const { workspace, canonicalName } = await loadAgentContext(slug, agentName);
  const baseHref = `/${workspace.slug}/agents/${encodeURIComponent(canonicalName)}/outputs`;

  return (
    <Section
      title="Outputs"
      description="Successful, non-empty outputs produced by this agent."
    >
      <OutputsView
        workspaceId={workspace.id}
        workspaceSlug={workspace.slug}
        baseHref={baseHref}
        searchParams={sp}
        agentName={canonicalName}
      />
    </Section>
  );
}
