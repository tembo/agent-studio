import "server-only";

import type { AgentDelivery } from "@/lib/agent-format";
import { claimAgentOwner } from "@/lib/agent-versions";
import type { RunEnvironment } from "@/lib/run-environment";

// Typed client for the Rust API's /internal/runs surface. Auth is a
// shared bearer (INTERNAL_API_TOKEN env var); the web container reaches
// the API service via the docker network at API_INTERNAL_URL.

const API_URL = process.env.API_INTERNAL_URL ?? "http://localhost:8080";

function authHeader(): Record<string, string> {
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) {
    throw new Error(
      "INTERNAL_API_TOKEN is required for web → api calls. " +
        "Set it in .env and pass it through docker-compose.yml.",
    );
  }
  return { Authorization: `Bearer ${token}` };
}

export type CreateRunInput = {
  workspaceId: string;
  userId: string;
  agentName: string;
  agentPath: string;
  model: string;
  userMessage?: string;
  // Both frameworks now run as passthrough subprocess calls into the
  // upstream tool — Pydantic agents through the bundled Python
  // wrapper, Cargo AI agents through the bundled cargo-ai CLI. The
  // runner needs the raw file contents and format for both.
  framework?: "pydantic-agentspec" | "cargo-ai";
  specContent?: string;
  specFormat?: "yaml" | "json";
  // Optional sidecar Python module (the agent's `tools_module:`) whose
  // functions the pydantic wrapper exposes to the model as tools. Read
  // from the repo at dispatch time; runtime-only (not persisted).
  toolsModuleContent?: string;
  // Files of the Agent Skills the agent opts into, as { repoPath: content }.
  // Read from the repo at dispatch; the wrapper materializes them to a temp
  // dir and mounts pydantic-ai-skills. Runtime-only (not persisted).
  skillsContent?: Record<string, string>;
  // Defaults to "manual" on the API side. Slack/webhook dispatch passes
  // "event" so the run is attributed correctly in /runs.
  trigger?: RunTrigger;
  // Which agent version produced specContent. versionId is the
  // agent_version.id for a stable snapshot (null for draft/live runs);
  // versionLabel is the human string ("v3" | "draft") for the UI.
  agentVersionId?: string | null;
  agentVersionLabel?: string | null;
  /** Agent-authored delivery intent from the exact spec this run executes. */
  delivery?: AgentDelivery;
  automationId?: string;
  // The orchestrator run that triggered this sub-agent through trigger_run.
  // Recorded so the orchestrator's page can roll up sub-runs.
  orchestratorRunId?: string;
  /** Manual dry-run: stub declared delivery tools. Default false. */
  isDryRun?: boolean;
};

export type CreateRunResponse = { runId: string };

export type RunTrigger = "manual" | "schedule" | "event" | "eval";

export type RunRecord = {
  id: string;
  workspaceId: string;
  agentName: string;
  agentPath: string;
  /** Optional user input the run started with ("" when none). */
  userMessage: string;
  model: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  output: string;
  /** Live partial output while running (null once terminal). */
  streamedOutput: string | null;
  /** Privileged runner diagnostics. Never serialize this to regular users. */
  errorMessage: string | null;
  /** Stable failure category and safe copy for user-facing surfaces. */
  failureCode: string | null;
  failureSummary: string | null;
  failureRecommendation: string | null;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  /** ScaleDown prompt-compression totals (null unless the run compressed). */
  scaledownOriginalTokens: number | null;
  scaledownCompressedTokens: number | null;
  trigger: RunTrigger;
  automationId: string | null;
  agentVersionId: string | null;
  agentVersionLabel: string | null;
  runEnvironment: RunEnvironment;
  /** Number of API restarts this run recovered from. */
  resumeCount: number;
  resumedAt: string | null;
  isDryRun: boolean;
};

type ApiRunRecord = {
  id: string;
  workspace_id: string;
  agent_name: string;
  agent_path: string;
  user_message: string;
  model: string;
  status: RunRecord["status"];
  output: string;
  streamed_output: string | null;
  error_message: string | null;
  failure_code: string | null;
  failure_summary: string | null;
  failure_recommendation: string | null;
  created_by: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  scaledown_original_tokens: number | null;
  scaledown_compressed_tokens: number | null;
  trigger: RunTrigger;
  automation_id: string | null;
  agent_version_id: string | null;
  agent_version_label: string | null;
  run_environment: RunEnvironment;
  resume_count: number;
  resumed_at: string | null;
  is_dry_run?: boolean;
};

function fromApi(r: ApiRunRecord): RunRecord {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    agentName: r.agent_name,
    agentPath: r.agent_path,
    userMessage: r.user_message ?? "",
    model: r.model,
    status: r.status,
    output: r.output,
    streamedOutput: r.streamed_output,
    errorMessage: r.error_message,
    failureCode: r.failure_code,
    failureSummary: r.failure_summary,
    failureRecommendation: r.failure_recommendation,
    createdBy: r.created_by,
    createdAt: r.created_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    tokensInput: r.tokens_input,
    tokensOutput: r.tokens_output,
    scaledownOriginalTokens: r.scaledown_original_tokens,
    scaledownCompressedTokens: r.scaledown_compressed_tokens,
    trigger: r.trigger,
    automationId: r.automation_id,
    agentVersionId: r.agent_version_id,
    agentVersionLabel: r.agent_version_label,
    runEnvironment: r.run_environment,
    resumeCount: r.resume_count,
    resumedAt: r.resumed_at,
    isDryRun: r.is_dry_run ?? false,
  };
}

export async function createRun(input: CreateRunInput): Promise<CreateRunResponse> {
  const res = await fetch(`${API_URL}/internal/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeader(),
    },
    cache: "no-store",
    body: JSON.stringify({
      workspace_id: input.workspaceId,
      user_id: input.userId,
      agent_name: input.agentName,
      agent_path: input.agentPath,
      model: input.model,
      user_message: input.userMessage ?? "",
      framework: input.framework,
      spec_content: input.specContent,
      spec_format: input.specFormat,
      tools_module_content: input.toolsModuleContent,
      skills_content: input.skillsContent,
      trigger: input.trigger,
      automation_id: input.automationId,
      agent_version_id: input.agentVersionId,
      agent_version_label: input.agentVersionLabel,
      orchestrator_run_id: input.orchestratorRunId,
      output_delivery: input.delivery,
      is_dry_run: input.isDryRun ?? false,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Run API returned ${res.status}: ${text.slice(0, 400)}`);
  }
  const body = (await res.json()) as { run_id: string };
  // First run claims ownership if the agent has none yet (chat-created agents
  // already have an owner; repo-committed ones don't). Best-effort — never let
  // an ownership write fail a run that was just accepted.
  try {
    await claimAgentOwner(input.workspaceId, input.agentName, input.userId);
  } catch (e) {
    console.error("claimAgentOwner failed (non-fatal)", e);
  }
  return { runId: body.run_id };
}

export async function getRun(
  runId: string,
  workspaceId: string,
): Promise<RunRecord | null> {
  const params = new URLSearchParams({ workspace_id: workspaceId });
  const res = await fetch(
    `${API_URL}/internal/runs/${encodeURIComponent(runId)}?${params}`,
    {
      method: "GET",
      headers: { ...authHeader() },
      cache: "no-store",
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Run API returned ${res.status}: ${text.slice(0, 400)}`);
  }
  const body = (await res.json()) as ApiRunRecord;
  return fromApi(body);
}

/** Kill an in-flight run. Returns true if this call transitioned the run to
 *  'cancelled', false if it was already terminal (nothing to do). */
export async function cancelRun(
  runId: string,
  workspaceId: string,
): Promise<boolean> {
  const params = new URLSearchParams({ workspace_id: workspaceId });
  const res = await fetch(
    `${API_URL}/internal/runs/${encodeURIComponent(runId)}/cancel?${params}`,
    {
      method: "POST",
      headers: { ...authHeader() },
      cache: "no-store",
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Run API returned ${res.status}: ${text.slice(0, 400)}`);
  }
  const body = (await res.json()) as { cancelled: boolean };
  return body.cancelled;
}

/** Push live run-queue limits to the api process. Saved instance settings
 *  still win on the next api boot if this call fails. */
export async function updateRunConcurrency(input: {
  maxConcurrentRuns: number;
  maxSubAgentsPerOrchestrator: number;
}): Promise<void> {
  const res = await fetch(`${API_URL}/internal/run-concurrency`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...authHeader(),
    },
    cache: "no-store",
    body: JSON.stringify({
      max_concurrent_runs: input.maxConcurrentRuns,
      max_sub_agents_per_orchestrator: input.maxSubAgentsPerOrchestrator,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Run API returned ${res.status}: ${text.slice(0, 400)}`);
  }
}
