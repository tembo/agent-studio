"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";

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
  const version = String(formData.get("version") ?? "") === "stable"
    ? "stable"
    : "draft";

  const auth = await authorizeWorkspace(slug, "operator");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }

  const result = await startEvalRun({
    workspaceId: auth.workspace.id,
    userId: auth.userId,
    agent: agentName,
    version,
    source: "manual",
  });
  if (!result.ok) return { error: result.error };

  revalidatePath(`/${slug}/agents/${encodeURIComponent(agentName)}/versions`);
  return { message: `Eval started against the ${version}.` };
}
