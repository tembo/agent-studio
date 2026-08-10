import "server-only";

import { getPublicOrigin } from "@/lib/config";

export const MCP_OAUTH_READ_SCOPE = "mcp:read";
export const MCP_OAUTH_WRITE_SCOPE = "mcp:write";
export const MCP_OAUTH_SCOPES = [
  MCP_OAUTH_READ_SCOPE,
  MCP_OAUTH_WRITE_SCOPE,
  "offline_access",
] as const;

export const MCP_OAUTH_WORKSPACE_CLAIM = "tas_workspace_id";

export function mcpOAuthResource(): string {
  return `${getPublicOrigin()}/mcp`;
}

export function mcpOAuthIssuer(): string {
  return `${getPublicOrigin()}/api/auth`;
}

export function hasMcpOAuthScope(scopes: readonly string[]): boolean {
  return scopes.some(
    (scope) =>
      scope === MCP_OAUTH_READ_SCOPE || scope === MCP_OAUTH_WRITE_SCOPE,
  );
}

