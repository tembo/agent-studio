import "server-only";

import {
  apiKeyTokenMatches,
  getApiKeyByToken,
  touchApiKeyLastUsed,
} from "@/lib/api-keys-db";
import { meetsMinRole, type WorkspaceRole } from "@/lib/rbac";
import { getWorkspaceById, getWorkspaceRole, type Workspace } from "@/lib/workspace";
import {
  MCP_OAUTH_READ_SCOPE,
  MCP_OAUTH_WORKSPACE_CLAIM,
} from "@/lib/mcp-oauth";

// API-client analogue of authorizeWorkspace (lib/auth-server.ts). That helper is
// session/cookie based; programmatic callers (the /api/v1 REST surface and the
// /api/mcp server) present bearer credentials instead. REST accepts `tas_` API
// keys; MCP additionally accepts OAuth access-token claims. Both funnel through
// this module so the live-membership RBAC policy lives in one place.
//
// Unlike authorizeWorkspace (which returns a reason enum the caller maps to a
// status), API callers always want an HTTP status, so we return it directly.
// Error strings are intentionally vague — never leak whether a token, a
// workspace, or a membership is the thing that's missing.

/** Which programmatic surface a request came in on — stamped onto audit
 *  events (`payload.via`) so the timeline distinguishes a REST-API change
 *  from an MCP-tool change from an in-app (UI) one. */
export type ApiSurface = "api" | "mcp";

export type AuthorizeApiSuccess = {
  ok: true;
  workspace: Workspace;
  userId: string;
  role: WorkspaceRole;
  apiKeyId: string;
  surface: ApiSurface;
  oauthScopes?: readonly string[];
};

export type AuthorizeApiFailure = {
  ok: false;
  status: 401 | 403;
  error: string;
};

export type AuthorizeApiResult = AuthorizeApiSuccess | AuthorizeApiFailure;

const UNAUTHORIZED: AuthorizeApiFailure = {
  ok: false,
  status: 401,
  error: "invalid or missing API key",
};

/** Pull a `tas_`-prefixed bearer token out of the Authorization header. */
function bearerToken(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (!m) return null;
  const token = m[1].trim();
  return token.startsWith("tas_") ? token : null;
}

export async function authorizeApiRequest(
  request: Request,
  minRole: WorkspaceRole = "viewer",
  surface: ApiSurface = "api",
): Promise<AuthorizeApiResult> {
  const token = bearerToken(request);
  if (!token) return UNAUTHORIZED;

  const row = await getApiKeyByToken(token);
  if (!row || !row.enabled || !apiKeyTokenMatches(row, token)) {
    return UNAUTHORIZED;
  }

  // Fire-and-forget — never block the request on the usage bump.
  void touchApiKeyLastUsed(row.id);
  return authorizeProgrammaticIdentity({
    workspaceId: row.workspaceId,
    userId: row.userId,
    minRole,
    credentialId: row.id,
    surface,
    deniedMessage: "this API key's user lacks the required role for this action",
  });
}

type OAuthMcpClaims = {
  sub?: unknown;
  azp?: unknown;
  scope?: unknown;
  [claim: string]: unknown;
};

export async function authorizeOAuthMcpClaims(
  claims: OAuthMcpClaims,
): Promise<AuthorizeApiResult> {
  const workspaceId = claims[MCP_OAUTH_WORKSPACE_CLAIM];
  const scopes =
    typeof claims.scope === "string"
      ? claims.scope.split(" ").filter(Boolean)
      : [];
  if (
    typeof claims.sub !== "string" ||
    typeof claims.azp !== "string" ||
    typeof workspaceId !== "string" ||
    !scopes.includes(MCP_OAUTH_READ_SCOPE)
  ) {
    return UNAUTHORIZED;
  }

  return authorizeProgrammaticIdentity({
    workspaceId,
    userId: claims.sub,
    minRole: "viewer",
    credentialId: `oauth:${claims.azp}`,
    surface: "mcp",
    oauthScopes: scopes,
    deniedMessage: "this OAuth token's user lacks access to its TAS workspace",
  });
}

async function authorizeProgrammaticIdentity(args: {
  workspaceId: string;
  userId: string;
  minRole: WorkspaceRole;
  credentialId: string;
  surface: ApiSurface;
  oauthScopes?: readonly string[];
  deniedMessage: string;
}): Promise<AuthorizeApiResult> {
  const workspace = await getWorkspaceById(args.workspaceId);
  if (!workspace) return UNAUTHORIZED;

  // Effective role is always live. Demoting/removing the user changes both API
  // key and OAuth access immediately, regardless of the credential lifetime.
  const role = await getWorkspaceRole(workspace.id, args.userId);
  if (!meetsMinRole(role, args.minRole)) {
    return { ok: false, status: 403, error: args.deniedMessage };
  }

  return {
    ok: true,
    workspace,
    userId: args.userId,
    role: role as WorkspaceRole,
    apiKeyId: args.credentialId,
    surface: args.surface,
    ...(args.oauthScopes ? { oauthScopes: args.oauthScopes } : {}),
  };
}
