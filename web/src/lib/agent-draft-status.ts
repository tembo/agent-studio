import "server-only";

import { promises as fs } from "node:fs";
import { resolve } from "node:path";

import {
  listStableVersions,
  type AgentVersion,
} from "@/lib/agent-versions";
import { listFileCommits } from "@/lib/github";
import { diffLines, type DiffStats } from "@/lib/text-diff";
import type { ListAgentsResult, ListedAgent } from "@/lib/workspace-agents";
import {
  getWorkspaceRepo,
  getWorkspaceSecretPlaintext,
} from "@/lib/workspace";

export type PendingAgentDraft = {
  agentName: string;
  agentPath: string;
  stableVersionNumber: number | null;
  stableChangedAt: Date | null;
  draftChangedAt: Date | null;
  diffStats: DiffStats;
};

export function pendingDraftFromContent(args: {
  agentName: string;
  agentPath: string;
  sourceContent: string;
  stable: AgentVersion | null;
}): PendingAgentDraft | null {
  const diff = diffLines(args.stable?.specContent ?? "", args.sourceContent);
  if (args.stable && diff.unchanged) return null;
  return {
    agentName: args.agentName,
    agentPath: args.agentPath,
    stableVersionNumber: args.stable?.versionNumber ?? null,
    stableChangedAt: args.stable?.createdAt ?? null,
    draftChangedAt: null,
    diffStats: diff.stats,
  };
}

export async function listPendingAgentDrafts(
  workspaceId: string,
  listing: ListAgentsResult | null,
  options: { includeDraftChangedAt?: boolean } = {},
): Promise<PendingAgentDraft[]> {
  if (!listing?.ok) return [];
  const validAgents = listing.agents.filter(
    (agent): agent is Extract<ListedAgent, { ok: true }> => agent.ok,
  );
  const stableVersions = await listStableVersions(
    workspaceId,
    validAgents.map((agent) => agent.spec.name),
  );
  const pending = validAgents.flatMap((agent) => {
    const status = pendingDraftFromContent({
      agentName: agent.spec.name,
      agentPath: agent.path,
      sourceContent: agent.sourceContent,
      stable: stableVersions.get(agent.spec.name) ?? null,
    });
    return status ? [status] : [];
  });
  if (!options.includeDraftChangedAt || pending.length === 0) return pending;

  const changedAt = await listDraftChangedAt(workspaceId, pending);
  return pending.map((draft) => ({
    ...draft,
    draftChangedAt: changedAt.get(draft.agentPath) ?? null,
  }));
}

export async function getDraftChangedAt(
  workspaceId: string,
  agentPath: string,
): Promise<Date | null> {
  const dates = await listDraftChangedAt(workspaceId, [
    {
      agentPath,
    },
  ]);
  return dates.get(agentPath) ?? null;
}

async function listDraftChangedAt(
  workspaceId: string,
  drafts: Array<Pick<PendingAgentDraft, "agentPath">>,
): Promise<Map<string, Date>> {
  const repo = await getWorkspaceRepo(workspaceId);
  if (repo) {
    let token: string;
    try {
      token = await getWorkspaceSecretPlaintext(workspaceId, "github_pat");
    } catch {
      return new Map();
    }
    const entries = await Promise.all(
      drafts.map(async ({ agentPath }) => {
        const result = await listFileCommits(
          token,
          { owner: repo.owner, name: repo.name, branch: repo.defaultBranch },
          agentPath,
          1,
        );
        const value = result.ok ? result.commits[0]?.date : null;
        const date = value ? new Date(value) : null;
        return date && !Number.isNaN(date.getTime())
          ? ([agentPath, date] as const)
          : null;
      }),
    );
    return new Map(entries.filter((entry) => entry !== null));
  }

  const localRoot = process.env.TAS_LOCAL_AGENTS_DIR?.trim();
  if (!localRoot) return new Map();
  const root = resolve(localRoot);
  const entries = await Promise.all(
    drafts.map(async ({ agentPath }) => {
      const path = resolve(root, agentPath);
      if (!path.startsWith(`${root}/`)) return null;
      try {
        return [agentPath, (await fs.stat(path)).mtime] as const;
      } catch {
        return null;
      }
    }),
  );
  return new Map(entries.filter((entry) => entry !== null));
}
