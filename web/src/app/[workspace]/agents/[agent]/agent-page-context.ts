import "server-only";

import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { isAgentLocked } from "@/lib/agent-lock";
import { getServerSession } from "@/lib/session";
import { getAgentByName, type ListedAgent } from "@/lib/workspace-agents";
import { getWorkspaceBySlug, getWorkspaceRepo } from "@/lib/workspace";
import { type Workspace } from "@/lib/workspace";

// Shared resolver for the agent layout + each tab page. Centralizes the
// session / workspace / repo / agent lookups (and the notFound/redirect gates)
// so every route in agents/[agent]/** does it the same cheap way — getAgentByName
// is backed by the GitHub readFile/listAgents cache, so repeated calls within a
// navigation are cheap.

export type AgentPageContext = {
  session: NonNullable<Awaited<ReturnType<typeof getServerSession>>>;
  workspace: Workspace;
  /** Null in local-agents dev mode (no connected repo). */
  repo: Awaited<ReturnType<typeof getWorkspaceRepo>>;
  agent: ListedAgent;
  raw: string;
  toolsModuleContent: string | undefined;
  /** The agent's declared name (falls back to the URL param for invalid files). */
  canonicalName: string;
  /** Admin "Locked" flag — hides edit affordances + history tabs (#12). */
  locked: boolean;
};

export const loadAgentContext = cache(async function loadAgentContext(
  slug: string,
  agentName: string,
): Promise<AgentPageContext> {
  const session = await getServerSession();
  if (!session) notFound();

  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();

  // No repo is fine in local-agents dev mode (TAS_LOCAL_AGENTS_DIR); otherwise
  // a workspace must connect a repo before its agents resolve.
  const repo = await getWorkspaceRepo(workspace.id);
  if (!repo && !process.env.TAS_LOCAL_AGENTS_DIR?.trim()) {
    redirect(`/onboarding/repo?ws=${encodeURIComponent(workspace.slug)}`);
  }

  const result = await getAgentByName(workspace.id, agentName);
  if (!result) notFound();

  const { agent, raw, toolsModuleContent } = result;
  const canonicalName = agent.ok ? agent.spec.name : agentName;
  const locked = await isAgentLocked(workspace.id, canonicalName);

  return {
    session,
    workspace,
    repo,
    agent,
    raw,
    toolsModuleContent,
    canonicalName,
    locked,
  };
});
