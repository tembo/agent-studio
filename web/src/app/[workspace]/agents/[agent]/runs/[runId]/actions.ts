"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";

import {
  authorizeWorkspace,
  DENIED_MESSAGE,
} from "@/lib/auth-server";
import {
  buildImprovePrompt,
  createTemboTask,
  type CapError,
} from "@/lib/cap-api";
import {
  createImprovement,
  improvementMarker,
  setImprovementCommitted,
  setImprovementTask,
} from "@/lib/improvements-api";
import { cancelRun, getRun } from "@/lib/runs-api";
import { resolveTemboCredential } from "@/lib/tembo-credentials";
import { getWorkspaceRepo } from "@/lib/workspace";

export type ImproveResult =
  | {
      ok: true;
      improvementId: string;
      taskId: string;
      htmlUrl: string;
      status: string;
    }
  | { ok: false; error: string };

export async function improveAgentAction(args: {
  workspaceSlug: string;
  runId: string;
  improvement: string;
  includeEvals?: boolean;
}): Promise<ImproveResult> {
  const improvement = args.improvement.trim();
  if (!improvement) {
    return { ok: false, error: "Tell us what to improve before submitting." };
  }

  const auth = await authorizeWorkspace(args.workspaceSlug, "operator");
  if (!auth.ok) {
    if (auth.reason === "denied") return { ok: false, error: DENIED_MESSAGE };
    notFound();
  }
  const { workspace, userId } = auth;

  const run = await getRun(args.runId, workspace.id);
  if (!run || run.workspaceId !== workspace.id) notFound();

  const repo = await getWorkspaceRepo(workspace.id);
  if (!repo) {
    return {
      ok: false,
      error:
        "This workspace has no GitHub repository connected. Connect one in Settings before requesting improvements.",
    };
  }

  const temboCredential = await resolveTemboCredential(workspace.id, userId);
  if (!temboCredential) {
    return {
      ok: false,
      error:
        "Connect your Tembo account or ask an admin to configure the workspace fallback account in Settings → Tembo Coding Agent.",
    };
  }

  // Persist the improvement row before talking to Tembo so we own
  // the id we embed in the prompt — even if the CAP call fails the
  // row exists with status='submitted' and we can retry later.
  const row = await createImprovement({
    workspaceId: workspace.id,
    runId: run.id,
    agentName: run.agentName,
    agentPath: run.agentPath,
    improvementText: improvement,
    delivery: workspace.commitMode,
    userId,
  });

  const prompt = buildImprovePrompt({
    agentPath: run.agentPath,
    model: run.model,
    userMessage: "", // Run record doesn't capture the user message separately from the prompt; revisit when chat lands.
    output: run.output,
    improvement,
    improvementMarker: improvementMarker(row.id),
    commitMode: workspace.commitMode,
    defaultBranch: repo.defaultBranch,
    repositoryUrl: `https://github.com/${repo.owner}/${repo.name}`,
    includeEvals: args.includeEvals !== false,
  });

  const res = await createTemboTask({
    apiKey: temboCredential.apiKey,
    input: {
      prompt,
      repositoryUrl: `https://github.com/${repo.owner}/${repo.name}`,
      targetBranch: repo.defaultBranch,
    },
  });

  if (!res.ok) {
    return { ok: false, error: formatCapError(res.error) };
  }

  // Direct/YOLO lands on the branch with no PR — mark committed now; the scan
  // attaches the commit URL later. PR mode stays 'submitted' until detected.
  if (workspace.commitMode === "direct") {
    await setImprovementCommitted({
      id: row.id,
      temboTaskId: res.result.taskId,
      temboTaskHtmlUrl: res.result.htmlUrl,
    });
  } else {
    await setImprovementTask({
      id: row.id,
      temboTaskId: res.result.taskId,
      temboTaskHtmlUrl: res.result.htmlUrl,
    });
  }

  return {
    ok: true,
    improvementId: row.id,
    taskId: res.result.taskId,
    htmlUrl: res.result.htmlUrl,
    status: res.result.status,
  };
}

export type CancelRunResult =
  | { ok: true; cancelled: boolean }
  | { ok: false; error: string };

/** Kill an in-flight run. Operator+ only. Returns cancelled=false when the run
 *  had already finished (the page just refreshes to the terminal state). */
export async function cancelRunAction(args: {
  workspaceSlug: string;
  agentName: string;
  runId: string;
}): Promise<CancelRunResult> {
  const auth = await authorizeWorkspace(args.workspaceSlug, "operator");
  if (!auth.ok) {
    if (auth.reason === "denied") return { ok: false, error: DENIED_MESSAGE };
    notFound();
  }
  const { workspace } = auth;

  const run = await getRun(args.runId, workspace.id);
  if (!run || run.workspaceId !== workspace.id) notFound();

  let cancelled: boolean;
  try {
    cancelled = await cancelRun(run.id, workspace.id);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Failed to cancel the run.",
    };
  }

  revalidatePath(
    `/${args.workspaceSlug}/agents/${encodeURIComponent(args.agentName)}/runs/${run.id}`,
  );
  return { ok: true, cancelled };
}

function formatCapError(error: CapError): string {
  switch (error.kind) {
    case "missing_tembo_key":
      return "Connect your Tembo account or ask an admin to configure the workspace fallback account under Settings → Tembo Coding Agent.";
    case "http":
      if (error.status === 401 || error.status === 403) {
        return "Tembo rejected the API key (it may have been rotated or revoked). Update it under Settings → Tembo Coding Agent.";
      }
      return `POST ${error.url} → ${error.status}\n${error.body.slice(0, 600) || "(no body)"}`;
    case "network":
      return `Could not reach Tembo CAP: ${error.message}`;
  }
}
