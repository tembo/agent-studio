import "server-only";

import {
  getNativeConnection,
  getNativeConnectionCredentials,
} from "@/lib/connections";
import type { McpProviderSlug } from "@/lib/mcp-providers";

export type ReusableDcrRegistration = {
  clientId: string;
  clientSecret: string | null;
};

/**
 * Reconnect with the OAuth client the provider already registered for this
 * connection. DCR providers commonly rate-limit registrations, while the
 * issued client identity remains valid across authorization grants.
 */
export async function getReusableDcrRegistration(args: {
  workspaceId: string;
  userId: string;
  provider: McpProviderSlug;
  connectionName: string;
  mcpServerUrl: string;
}): Promise<ReusableDcrRegistration | null> {
  const connection = await getNativeConnection(
    args.workspaceId,
    args.userId,
    args.provider,
    args.connectionName,
  );
  if (!connection || connection.mcpServerUrl !== args.mcpServerUrl) return null;

  const rawClientId = connection.metadata.dcr_client_id;
  const clientId = typeof rawClientId === "string" ? rawClientId.trim() : "";
  if (!clientId || connection.metadata.auth_mode === "manual") return null;

  if (connection.metadata.auth_mode !== "dcr_confidential") {
    return { clientId, clientSecret: null };
  }

  try {
    const credentials = await getNativeConnectionCredentials(connection.id);
    if (
      credentials.client_id !== clientId ||
      typeof credentials.client_secret !== "string" ||
      !credentials.client_secret
    ) {
      return null;
    }
    return { clientId, clientSecret: credentials.client_secret };
  } catch {
    // A missing or undecryptable secret cannot authenticate this client. A
    // fresh DCR attempt is the only safe recovery path.
    return null;
  }
}

export function dcrRegistrationFailureMessage(
  providerName: string,
  status: number,
): string {
  if (status === 429) {
    return `${providerName} is temporarily limiting new connections. Please try again later.`;
  }
  return `Couldn't register a new ${providerName} connection (${status}). Please try again later.`;
}
