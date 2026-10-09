"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";

import { getWorkspaceRole } from "@/lib/workspace";
import { startEvalRun } from "@/lib/agent-evals-run";
import {
  authorizeWorkspace,
  DENIED_MESSAGE,
} from "@/lib/auth-server";

export type RunEvalsFormState = {
  error?: string;
  message?: string;
};

export async function runAgentEvalsAction(
  _prev: RunEvalsFormState,
  formData: FormData,
): Promise<RunEvalsFormState> {
  const slug = String(formData.get("workspace") ?? "");
  const agentName = String(formData.get("agent") ?? "");
  const runAsRaw = String(formData.get("run_as") ?? "").trim();
  const version = String(formData.get("version") ?? "") === "stable"
    ? "stable"
    : "draft";

  const auth = await authorizeWorkspace(slug, "operator");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }

  let runAsUserId = auth.userId;
  if (runAsRaw && runAsRaw !== auth.userId) {
    if (auth.role !== "workspace_admin") {
      return { error: "Only workspace admins can run as another member." };
    }
    if (!(await getWorkspaceRole(auth.workspace.id, runAsRaw))) {
      return { error: "That user isn't a member of this workspace." };
    }
    runAsUserId = runAsRaw;
  }

  const result = await startEvalRun({
    workspaceId: auth.workspace.id,
    userId: auth.userId,
    runAsUserId,
    agent: agentName,
    version,
    source: "manual",
  });
  if (!result.ok) return { error: result.error };

  revalidatePath(`/${slug}/agents/${encodeURIComponent(agentName)}/versions`);
  return { message: `Eval started against the ${version}.` };
}
