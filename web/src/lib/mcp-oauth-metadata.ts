import "server-only";

import {
  MCP_OAUTH_READ_SCOPE,
  MCP_OAUTH_WRITE_SCOPE,
  mcpOAuthIssuer,
  mcpOAuthResource,
} from "@/lib/mcp-oauth";

export function mcpProtectedResourceMetadata(): Response {
  return Response.json(
    {
      resource: mcpOAuthResource(),
      authorization_servers: [mcpOAuthIssuer()],
      scopes_supported: [MCP_OAUTH_READ_SCOPE, MCP_OAUTH_WRITE_SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "Tembo Agent Studio MCP",
    },
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
}

