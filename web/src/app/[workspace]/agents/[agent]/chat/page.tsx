import { notFound, redirect } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { isAgentLocked } from "@/lib/agent-lock";
import { agentDisplayName } from "@/lib/agent-format";
import { listChatRunsForAgent } from "@/lib/chat-runs-db";
import { scanImprovementsForPRs } from "@/lib/improvement-scan";
import { listImprovementsForAgent } from "@/lib/improvements-api";
import { getServerSession } from "@/lib/session";
import { getWorkspaceBySlug } from "@/lib/workspace";
import { getAgentByName } from "@/lib/workspace-agents";

import { ChatThread, type ChatTurn } from "./chat-thread";

export const dynamic = "force-dynamic";

export default async function AgentChatPage({
  params,
}: {
  params: Promise<{ workspace: string; agent: string }>;
}) {
  const { workspace: slug, agent: agentParam } = await params;
  const agentName = decodeURIComponent(agentParam);

  const session = await getServerSession();
  if (!session) notFound();

  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();

  const result = await getAgentByName(workspace.id, agentName);
  if (!result) notFound();
  const { agent } = result;
  const canonicalName = agent.ok ? agent.spec.name : agentName;
  // Locked agents (#12) take no in-app edits — chat-to-edit is disabled.
  if (await isAgentLocked(workspace.id, canonicalName)) {
    redirect(`/${slug}/agents/${encodeURIComponent(canonicalName)}`);
  }
  const displayName = agent.ok ? agentDisplayName(agent.spec) : agentName;

  const [stored, chatRuns] = await Promise.all([
    listImprovementsForAgent(workspace.id, canonicalName),
    listChatRunsForAgent(workspace.id, canonicalName),
  ]);
  const improvements = await scanImprovementsForPRs(workspace.id, stored);

  // Merge runs + improvements into a single chronological turn list.
  // Stable sort against created_at keeps "send" / "submit change"
  // ordering intuitive even when they fire in quick succession.
  const turns: ChatTurn[] = [
    ...chatRuns.map<ChatTurn>((run) => ({
      kind: "run",
      createdAt: run.createdAt,
      run,
    })),
    ...improvements.map<ChatTurn>((improvement) => ({
      kind: "improvement",
      createdAt: improvement.createdAt,
      improvement,
    })),
  ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const agentHref = `/${workspace.slug}/agents/${encodeURIComponent(canonicalName)}`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <BackLink href={agentHref} label={displayName} />
        <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
          Chat to edit
        </h1>
        <p className="text-foreground-weak text-base">
          Describe a change you&apos;d like to make to{" "}
          <span className="text-foreground font-medium">
            {displayName}
          </span>
          .{" "}
          {workspace.commitMode === "direct"
            ? "Each request is committed directly to the default branch (YOLO mode)."
            : "Each request opens a pull request for review; merged PRs become live behavior."}
        </p>
      </div>

      <hr className="border-[var(--color-border-weak)]" />

      <ChatThread
        workspaceSlug={workspace.slug}
        agentName={canonicalName}
        turns={turns}
        commitMode={workspace.commitMode}
      />
    </div>
  );
}
