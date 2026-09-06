import "server-only";

import { listAgents } from "@/lib/workspace-agents";

export type ScopedAgent = { name: string; path: string; description?: string };

/** Valid workspace agents carrying at least one of the supplied labels. */
export async function listAgentsByLabels(
  workspaceId: string,
  agentLabels: string[],
): Promise<ScopedAgent[]> {
  if (agentLabels.length === 0) return [];
  const labels = new Set(agentLabels);
  const listing = await listAgents(workspaceId);
  if (!listing.ok) return [];
  const scoped: ScopedAgent[] = [];
  for (const agent of listing.agents) {
    if (!agent.ok) continue;
    if (agent.spec.labels.some((label) => labels.has(label))) {
      scoped.push({
        name: agent.spec.name,
        path: agent.path,
        description: agent.spec.description,
      });
    }
  }
  return scoped;
}
