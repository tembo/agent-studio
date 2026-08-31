import "server-only";

import { db } from "@/lib/db";

// A run spawned by an orchestrator through the tembo-agent-studio MCP
// trigger_run tool. Shown on the orchestrator run page so its true cost (its
// own + every sub-run) is visible in one place.
export type SubAgentRun = {
  id: string;
  agentName: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  costUsd: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  createdAt: Date;
  createdByName: string | null;
  createdByEmail: string | null;
};

// Distinct tool names invoked across every sub-run an orchestrator run spawned.
// The caller maps these to provider slugs to show which MCPs the sub-agents
// actually used.
export async function listSubAgentRunToolNames(
  workspaceId: string,
  orchestratorRunId: string,
): Promise<string[]> {
  const { rows } = await db.query<{ tool_name: string }>(
    `SELECT DISTINCT tc.tool_name
       FROM run_tool_call tc
       JOIN run r ON r.id = tc.run_id
      WHERE r.workspace_id = $1 AND r.orchestrator_run_id = $2`,
    [workspaceId, orchestratorRunId],
  );
  return rows.map((r) => r.tool_name);
}

// Distinct orchestrator → sub-agent edges observed across the workspace. An
// edge means a run of `orchestratorAgentName` spawned a run of `subAgentName`.
// Self-edges are excluded.
export async function listAgentSubAgentEdges(
  workspaceId: string,
): Promise<{ orchestratorAgentName: string; subAgentName: string }[]> {
  const { rows } = await db.query<{
    orchestrator_agent: string;
    sub_agent: string;
  }>(
    `SELECT DISTINCT orchestrator.agent_name AS orchestrator_agent,
            sub_agent.agent_name AS sub_agent
       FROM run sub_agent
       JOIN run orchestrator ON orchestrator.id = sub_agent.orchestrator_run_id
      WHERE sub_agent.workspace_id = $1
        AND orchestrator.agent_name <> sub_agent.agent_name`,
    [workspaceId],
  );
  return rows.map((r) => ({
    orchestratorAgentName: r.orchestrator_agent,
    subAgentName: r.sub_agent,
  }));
}

export async function listSubAgentRuns(
  workspaceId: string,
  orchestratorRunId: string,
): Promise<SubAgentRun[]> {
  const { rows } = await db.query<{
    id: string;
    agent_name: string;
    status: SubAgentRun["status"];
    cost_usd: string | null;
    tokens_input: number | null;
    tokens_output: number | null;
    created_at: Date;
    created_by_name: string | null;
    created_by_email: string | null;
  }>(
    `SELECT r.id, r.agent_name, r.status, r.cost_usd, r.tokens_input,
            r.tokens_output, r.created_at,
            u.name AS created_by_name, u.email AS created_by_email
       FROM run r
       LEFT JOIN "user" u ON u.id = r.created_by
      WHERE r.workspace_id = $1 AND r.orchestrator_run_id = $2
      ORDER BY r.created_at ASC`,
    [workspaceId, orchestratorRunId],
  );
  return rows.map((r) => ({
    id: r.id,
    agentName: r.agent_name,
    status: r.status,
    costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
    tokensInput: r.tokens_input,
    tokensOutput: r.tokens_output,
    createdAt: r.created_at,
    createdByName: r.created_by_name,
    createdByEmail: r.created_by_email,
  }));
}
