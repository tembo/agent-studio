import Link from "next/link";

import { RunHistoryList } from "@/components/run-history-list";
import { Section } from "@/components/section";
import { listRecentRunsForAgent } from "@/lib/run-history-db";
import {
  getAgentDailyRunBands30d,
  getAgentStats30d,
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
}: {
  params: Promise<{ workspace: string; agent: string }>;
}) {
  const { workspace: slug, agent: agentName } = await params;
  const { workspace, canonicalName } = await loadAgentContext(slug, agentName);

  const [stats, daily, failures, toolUsage, recentRuns] = await Promise.all([
    getAgentStats30d(workspace.id, canonicalName),
    getAgentDailyRunBands30d(workspace.id, canonicalName),
    listAgentFailureGroups30d(workspace.id, canonicalName, 5),
    listAgentToolUsage30d(workspace.id, canonicalName),
    listRecentRunsForAgent(workspace.id, canonicalName, RECENT_PEEK),
  ]);

  const runsHref = `/${workspace.slug}/agents/${encodeURIComponent(canonicalName)}/runs`;

  return (
    <>
      <AgentDashboard
        stats={stats}
        daily={daily}
        failures={failures}
        toolUsage={toolUsage}
        workspaceSlug={workspace.slug}
        agentName={canonicalName}
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
    </>
  );
}
