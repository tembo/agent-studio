"use server";

import { revalidatePath } from "next/cache";

import { writeAuditEvent } from "@/lib/audit-db";
import { authorizeWorkspace, DENIED_MESSAGE } from "@/lib/auth-server";
import { setTextMessagesEnabled } from "@/lib/workspace-features";

export type FeaturesState = { error?: string; message?: string };

export async function saveFeaturesAction(
  _previous: FeaturesState,
  data: FormData,
): Promise<FeaturesState> {
  const slug = String(data.get("workspace") ?? "");
  const auth = await authorizeWorkspace(slug, "workspace_admin");
  if (!auth.ok) return { error: DENIED_MESSAGE };

  const enabled = data.get("text_messages_enabled") === "on";
  await setTextMessagesEnabled(auth.workspace.id, enabled);
  await writeAuditEvent({
    workspaceId: auth.workspace.id,
    actorUserId: auth.userId,
    source: "human_action",
    kind: "workspace.features_updated",
    targetType: "workspace",
    targetId: auth.workspace.id,
    agentName: null,
    payload: { text_messages_enabled: enabled },
  });
  revalidatePath(`/${auth.workspace.slug}`, "layout");
  return { message: "Features saved." };
}
