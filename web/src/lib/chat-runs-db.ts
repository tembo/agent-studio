import "server-only";

import { db } from "@/lib/db";

export interface ChatRun {
  id: string;
  agentName: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  userMessage: string;
  output: string;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

/** The newest chat-originated runs, returned oldest-first for the thread UI. */
export async function listChatRunsForAgent(
  workspaceId: string,
  agentName: string,
  limit = 50,
): Promise<ChatRun[]> {
  const { rows } = await db.query<{
    id: string;
    agent_name: string;
    status: ChatRun["status"];
    user_message: string;
    output: string;
    failure_summary: string | null;
    created_at: Date;
    completed_at: Date | null;
  }>(
    `SELECT id, agent_name, status, user_message, output, failure_summary, created_at, completed_at
       FROM run
       WHERE workspace_id = $1 AND agent_name = $2
         AND trigger <> 'eval'
         AND user_message IS NOT NULL AND user_message <> ''
      ORDER BY created_at DESC
      LIMIT $3`,
    [workspaceId, agentName, limit],
  );
  return rows.toReversed().map((r) => ({
    id: r.id,
    agentName: r.agent_name,
    status: r.status,
    userMessage: r.user_message,
    output: r.output,
    errorMessage: r.failure_summary,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  }));
}
