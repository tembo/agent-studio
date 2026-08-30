import { NextResponse, type NextRequest } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { isAPIError } from "better-auth/api";

import {
  authorizeApiRequest,
  authorizeOAuthMcpClaims,
  type AuthorizeApiSuccess,
} from "@/lib/api-auth";
import {
  MCP_OAUTH_READ_SCOPE,
  mcpOAuthIssuer,
  mcpOAuthResource,
} from "@/lib/mcp-oauth";
import { buildMcpServer } from "@/lib/mcp/server";

// MCP server endpoint (Streamable HTTP). A client such as Claude Code connects
// here to read and drive a TAS deployment:
//
//   claude mcp add --transport http tas https://<host>/mcp \
//     --header "Authorization: Bearer tas_..."
//
// Header clients may use the same per-user API key as /api/v1. Hosted clients
// use OAuth 2.1; their signed access token carries the selected workspace and
// user, then the live membership role is re-read before constructing the
// server. A fresh server + transport is created per POST (stateless), and
// enableJsonResponse keeps simple request/response replies as plain JSON.
//
// We use the SDK's Web-standard transport (Request -> Response) so this is a
// native Next.js App Router handler with no Node req/res bridge.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handleAuthorizedMcpRequest(
  request: NextRequest,
  auth: AuthorizeApiSuccess,
): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const parentRunId = request.headers.get("x-tas-parent-run") ?? undefined;
  const server = buildMcpServer(auth, { parentRunId });
  await server.connect(transport);
  return transport.handleRequest(request);
}

const { verifyAccessTokenRequest } = oauthProviderResourceClient().getActions();

async function handleOAuthMcpRequest(request: NextRequest): Promise<Response> {
  try {
    const claims = await verifyAccessTokenRequest(request, {
      jwksUrl: `${mcpOAuthIssuer()}/jwks`,
      verifyOptions: {
        issuer: mcpOAuthIssuer(),
        audience: mcpOAuthResource(),
      },
      requiredScopes: [MCP_OAUTH_READ_SCOPE],
    });
    const auth = await authorizeOAuthMcpClaims(claims);
    if (!auth.ok) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.status },
      );
    }
    return handleAuthorizedMcpRequest(request, auth);
  } catch (error) {
    if (isAPIError(error)) {
      return new Response(error.message, {
        status: error.statusCode,
        headers: error.headers,
      });
    }
    throw error;
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const token = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim();
  if (!token?.startsWith("tas_")) {
    return handleOAuthMcpRequest(request);
  }

  // Min role viewer to connect; write tools re-check operator on the resolved
  // context (ctx.role) inside buildMcpServer.
  const auth = await authorizeApiRequest(request, "viewer", "mcp");
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  return handleAuthorizedMcpRequest(request, auth);
}

// Stateless server: no standalone SSE stream and no session to terminate, so GET
// and DELETE aren't supported. Return 405 rather than 404 so clients can tell
// the endpoint exists but the method isn't offered.
export function GET(): Response {
  return NextResponse.json(
    { error: "method not allowed; POST JSON-RPC to this endpoint" },
    { status: 405 },
  );
}

export const DELETE = GET;
