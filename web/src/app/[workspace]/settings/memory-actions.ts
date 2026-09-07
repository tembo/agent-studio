"use server";

import { revalidatePath } from "next/cache";
import { authorizeWorkspace } from "@/lib/auth-server";
import { authorizeInstance } from "@/lib/instance";
import { writeAuditEvent } from "@/lib/audit-db";
import { memoryRequest } from "@/lib/memory";

export type MemoryState = { error?: string; message?: string };

export async function saveMemoryAction(_previous: MemoryState, data: FormData): Promise<MemoryState> {
  const instance = await authorizeInstance();
  if (!instance.ok) return { error: "Only an instance admin can change Memory sharing." };
  const slug = String(data.get("workspace") ?? "");
  const auth = await authorizeWorkspace(slug);
  if (!auth.ok) return { error: "Workspace access required." };
  const retry = data.get("operation") === "retry";
  const target = String(data.get("memory_workspace_id") ?? "");
  const enabled = data.get("enabled") === "on";
  try {
    await memoryRequest(auth.workspace.id, retry ? "POST" : "PUT", retry ? {} : { memory_workspace_id: target, enabled }, retry);
  } catch {
    return { error: "Could not update Memory. Check the connection and retry." };
  }
  await writeAuditEvent({
    workspaceId: auth.workspace.id, actorUserId: instance.userId,
    source: "human_action", kind: retry ? "memory.retry_requested" : "memory.workspace_selected",
    targetType: "workspace", targetId: auth.workspace.id, agentName: null,
    payload: retry ? {} : { memory_workspace_id: target, enabled },
  });
  revalidatePath(`/${slug}/settings/general`);
  return { message: retry ? "Blocked reports scheduled for retry against their original destinations." : "Memory settings saved. New runs use this selection; queued reports keep their original destination." };
}
