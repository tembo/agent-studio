import Link from "next/link";

import { RunHistoryList } from "@/components/run-history-list";
import { RunEnvironmentTabs } from "@/components/run-environment-tabs";
import { Section } from "@/components/section";
import { listRecentRunsForAgent } from "@/lib/run-history-db";
import { parseRunEnvironmentFilter } from "@/lib/run-environment";
import {
  getAgentDailyRunBands30d,
  getAgentStats30d,
} from "@/lib/run-analytics-db";
import {
  listAgentFailureGroups30d,
  listAgentToolUsage30d,
} from "@/lib/runs-db";

import { AgentDashboard } from "./agent-dashboard";
import { loadAgentContext } from "./agent-page-context";

export const dynamic = "force-dynamic";

// Overview tab — the agent's at-a-glance landing: 30-day dashboard plus a peek
// at the most recent runs. The header + nav come from the layout.

const RECENT_PEEK = 5;

export default async function AgentOverviewPage({
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
  const environment = parseRunEnvironmentFilter(sp.environment);
  const { workspace, canonicalName } = await loadAgentContext(slug, agentName);

  const [stats, daily, failures, toolUsage, recentRuns] = await Promise.all([
    getAgentStats30d(workspace.id, canonicalName, environment),
    getAgentDailyRunBands30d(workspace.id, canonicalName, environment),
    listAgentFailureGroups30d(workspace.id, canonicalName, 5, environment),
    listAgentToolUsage30d(workspace.id, canonicalName, 50, environment),
    listRecentRunsForAgent(
      workspace.id,
      canonicalName,
      RECENT_PEEK,
      environment,
    ),
  ]);

  const runsHref = `/${workspace.slug}/agents/${encodeURIComponent(canonicalName)}/runs`;

  return (
    <>
      <RunEnvironmentTabs
        active={environment}
        baseHref={`/${workspace.slug}/agents/${encodeURIComponent(canonicalName)}`}
      />

      <Section
        title="Recent runs"
        actions={
          recentRuns.length > 0 ? (
            <Link
              href={runsHref}
              className="text-foreground-weak hover:text-foreground text-sm"
            >
              View all →
            </Link>
          ) : undefined
        }
      >
        <RunHistoryList
          runs={recentRuns}
          workspaceSlug={workspace.slug}
          emptyMessage={
            <>
              No runs yet. Click{" "}
              <strong className="text-foreground">Run now</strong> above.
            </>
          }
        />
      </Section>

      <AgentDashboard
        stats={stats}
        daily={daily}
        failures={failures}
        toolUsage={toolUsage}
        workspaceSlug={workspace.slug}
        agentName={canonicalName}
        environment={environment}
      />
    </>
  );
}
