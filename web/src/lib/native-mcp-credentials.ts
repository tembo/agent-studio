import "server-only";

import {
  getNativeConnectionById,
  getNativeConnectionCredentials,
  type WorkspaceConnection,
} from "@/lib/connections";

export async function getUsableNativeMcpCredentials(
  connection: WorkspaceConnection,
) {
  if (connection.authType === "oauth2") {
    const token = process.env.INTERNAL_API_TOKEN;
    if (!token) {
      throw new Error("Authorization refresh is unavailable. Contact an administrator.");
    }
    const apiUrl = process.env.API_INTERNAL_URL ?? "http://localhost:8080";
    const response = await fetch(
      `${apiUrl}/internal/connections/native/${connection.id}/refresh`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workspaceId: connection.workspaceId,
          userId: connection.userId,
        }),
        cache: "no-store",
      },
    );
    if (!response.ok) {
      if (response.status === 409) {
        throw new Error("Authorization is inactive. Reconnect this account.");
      }
      throw new Error("Authorization refresh is unavailable. Retry later.");
    }
  }
  const current = await getNativeConnectionById(connection.workspaceId, connection.id);
  if (!current || current.userId !== connection.userId || current.status !== "active") {
    throw new Error("Authorization is inactive. Reconnect this account.");
  }
  const credentials = await getNativeConnectionCredentials(current.id);
  if (
    (current.tokenExpiresAt && current.tokenExpiresAt.getTime() <= Date.now()) ||
    (credentials.expires_at && new Date(credentials.expires_at).getTime() <= Date.now())
  ) {
    throw new Error("Authorization refresh is unavailable. Retry later.");
  }
  return credentials;
}
