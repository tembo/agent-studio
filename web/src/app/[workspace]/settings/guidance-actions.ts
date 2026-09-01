"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";

import { writeAuditEvent } from "@/lib/audit-db";
import {
  authorizeWorkspace,
  DENIED_MESSAGE,
} from "@/lib/auth-server";
import {
  getGuidanceRefreshSettings,
  isGuidanceRefreshCadence,
  refreshWorkspaceGuidance,
  setGuidanceRefreshCadence,
} from "@/lib/guidance-refresh";

export type GuidanceFormState = {
  message?: string;
  error?: string;
};

async function authorizeGuidanceChange(slug: string) {
  const auth = await authorizeWorkspace(slug, "workspace_admin");
  if (!auth.ok) {
    if (auth.reason === "denied") return null;
    notFound();
  }
  return auth;
}

export async function syncGuidanceAction(
  _prev: GuidanceFormState,
  formData: FormData,
): Promise<GuidanceFormState> {
  const slug = String(formData.get("workspace") ?? "");
  const auth = await authorizeGuidanceChange(slug);
  if (!auth) return { error: DENIED_MESSAGE };

  const result = await refreshWorkspaceGuidance({
    workspaceId: auth.workspace.id,
    actorUserId: auth.userId,
    source: "human_action",
    trigger: "manual",
  });
  if (!result.ok) {
    if (result.error === "no-repo") {
      return { error: "Connect a Git repository first." };
    }
    return { error: result.error };
  }

  revalidatePath(`/${slug}/settings/repository`);
  return {
    message:
      "Synced agents/AGENTS.md and the per-framework AGENT_GUIDE.md files. Check the repo for new commits.",
  };
}

export async function setGuidanceRefreshCadenceAction(
  _prev: GuidanceFormState,
  formData: FormData,
): Promise<GuidanceFormState> {
  const slug = String(formData.get("workspace") ?? "");
  const rawCadence = String(formData.get("cadence") ?? "");
  if (!isGuidanceRefreshCadence(rawCadence)) {
    return { error: "Choose Off, Daily, or Weekly." };
  }

  const auth = await authorizeGuidanceChange(slug);
  if (!auth) return { error: DENIED_MESSAGE };

  const current = await getGuidanceRefreshSettings(auth.workspace.id);
  if (current.cadence !== rawCadence) {
    await setGuidanceRefreshCadence(auth.workspace.id, rawCadence);
    await writeAuditEvent({
      workspaceId: auth.workspace.id,
      actorUserId: auth.userId,
      source: "policy_change",
      kind: "guidance.cadence_changed",
      targetType: "workspace",
      targetId: null,
      agentName: null,
      payload: { from: current.cadence, to: rawCadence },
    });
  }

  revalidatePath(`/${slug}/settings/repository`);
  return {
    message:
      rawCadence === "off"
        ? "Automatic guidance refresh is off."
        : `Agent guidance will refresh ${rawCadence}.`,
  };
}
