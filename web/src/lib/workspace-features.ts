import "server-only";

import { db } from "@/lib/db";

export async function getTextMessagesEnabled(workspaceId: string): Promise<boolean> {
  const { rows } = await db.query<{ text_messages_enabled: boolean }>(
    "SELECT text_messages_enabled FROM workspace WHERE id = $1",
    [workspaceId],
  );
  return rows[0]?.text_messages_enabled ?? false;
}

export async function setTextMessagesEnabled(workspaceId: string, enabled: boolean): Promise<void> {
  await db.query(
    "UPDATE workspace SET text_messages_enabled = $2, updated_at = now() WHERE id = $1",
    [workspaceId, enabled],
  );
}
