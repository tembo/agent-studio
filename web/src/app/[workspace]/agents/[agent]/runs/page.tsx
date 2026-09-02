import { Section } from "@/components/section";
import { listRunsForWorkspace } from "@/lib/runs-db";
import { parseRunListQuery, runListQueryKey } from "@/lib/run-list-query";

import { RunsList } from "../../../runs/runs-list";
import { toLoaded } from "../../../runs/shape";
import { loadAgentContext } from "../agent-page-context";

export const dynamic = "force-dynamic";

// Runs tab — the agent's run history, using the same table as the workspace
// Runs page (minus the Agent + Input columns and the Agent filter), scoped to
// this agent. Keeps the status/trigger/search filters + pagination.

export default async function AgentRunsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; agent: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspace: slug, agent: agentName }, sp] = await Promise.all([
    params,
    searchParams,
  ]);
  const { workspace, canonicalName } = await loadAgentContext(slug, agentName);
  const filters = parseRunListQuery(sp);

  const runs = await listRunsForWorkspace(workspace.id, {
    agentName: canonicalName,
    statuses: filters.statuses.length ? filters.statuses : undefined,
    triggers: filters.triggers.length ? filters.triggers : undefined,
    environments: filters.environments.length
      ? filters.environments
      : undefined,
      search: filters.search || undefined,
      dryRun: filters.dryRun || undefined,
    });

  return (
    <Section title="Runs" description="This agent's run history.">
      <RunsList
        key={runListQueryKey({ ...filters, agentName: canonicalName })}
        workspaceSlug={workspace.slug}
        agentNames={[]}
        initial={runs.map(toLoaded)}
        initialFilters={{
          statuses: filters.statuses,
          triggers: filters.triggers,
          environments: filters.environments,
          agentName: canonicalName,
          search: filters.search,
          dryRun: filters.dryRun,
        }}
        lockedAgent={canonicalName}
      />
    </Section>
  );
}
