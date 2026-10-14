import { NextResponse, type NextRequest } from "next/server";

import { writeAuditEvent } from "@/lib/audit-db";
import { saveNativeConnection } from "@/lib/connections";
import { getPublicOrigin } from "@/lib/config";
import { decryptSecret } from "@/lib/crypto";
import { aadNativeConnection } from "@/lib/crypto-aad";
import {
  getMcpProvider,
  redirectUriFor,
  type McpProviderSlug,
} from "@/lib/mcp-providers";
import {
  fetchOAuthEndpoint,
  trustedOAuthUrl,
} from "@/lib/native-oauth-security";
import { getNativeOAuthClientSecret } from "@/lib/native-oauth-clients";
import { fetchNativeMcpTools } from "@/lib/native-mcp-tools";
import { replaceToolsForConnection } from "@/lib/mcp-tools";
import { verifyNativeMcpState } from "@/lib/oauth-state";
import { getServerSession } from "@/lib/session";
import { userIsMember } from "@/lib/workspace";

// Native-MCP OAuth callback. The provider redirects the user back
// here with ?code=...&state=...; we swap the code for tokens at the
// token endpoint embedded in the signed state, using the PKCE
// verifier and DCR-issued client_id we squirreled away at authorize
// time. No client_secret — token_endpoint_auth_method=none + PKCE.

function back(
  slug: string,
  provider: string,
  status: "ok" | "error",
  detail?: string,
): NextResponse {
  const target = new URL(`/${slug}/connections`, getPublicOrigin());
  target.searchParams.set("native_mcp", provider);
  target.searchParams.set("result", status);
  if (detail) target.searchParams.set("detail", detail.slice(0, 200));
  return NextResponse.redirect(target, 302);
}

type RouteParams = Promise<{ provider: string }>;

export async function GET(
  request: NextRequest,
  { params }: { params: RouteParams },
): Promise<NextResponse> {
  const { provider: providerSlug } = await params;
  const provider = getMcpProvider(providerSlug);
  if (!provider) {
    return NextResponse.json(
      { error: `Unknown native-MCP provider: ${providerSlug}` },
      { status: 404 },
    );
  }

  const session = await getServerSession();
  if (!session) {
    return NextResponse.redirect(new URL("/", request.url), 302);
  }

  const stateRaw = request.nextUrl.searchParams.get("state");
  if (!stateRaw) {
    return NextResponse.json({ error: "missing state" }, { status: 400 });
  }
  const state = verifyNativeMcpState(stateRaw);
  if (!state) {
    return NextResponse.json(
      { error: "state failed signature verification" },
      { status: 400 },
    );
  }
  if (state.provider !== provider.slug) {
    return NextResponse.json(
      { error: "state provider doesn't match route" },
      { status: 400 },
    );
  }
  if (session.user.id !== state.userId) {
    return back(
      state.workspaceSlug,
      provider.slug,
      "error",
      "Session user changed during OAuth flow.",
    );
  }

  const isMember = await userIsMember(state.workspaceId, session.user.id);
  if (!isMember) {
    return NextResponse.json({ error: "not a member" }, { status: 403 });
  }

  const providerError = request.nextUrl.searchParams.get("error");
  if (providerError) {
    return back(
      state.workspaceSlug,
      provider.slug,
      "error",
      `${provider.displayName} rejected the authorization: ${providerError}`,
    );
  }
  const code = request.nextUrl.searchParams.get("code");
  if (!code) {
    return back(
      state.workspaceSlug,
      provider.slug,
      "error",
      `${provider.displayName} didn't return an authorization code.`,
    );
  }

  // PKCE token exchange. Public client → no client_secret. The
  // code_verifier proves we're the same party that initiated the
  // authorize request (we hold the verifier whose S256 hash we sent
  // as the challenge).
  let tokenJson: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };
  // Instance-based providers carry their resolved per-connection URL in the
  // state (catalog mcpServerUrl is empty); trust is same-origin to that host.
  const mcpServerUrl = state.mcpServerUrl ?? provider.mcpServerUrl;
  const allowedOauthOrigins = state.mcpServerUrl
    ? [new URL(state.mcpServerUrl).origin]
    : provider.oauthAuthorizationServerOrigins;
  let tokenEndpoint: URL;
  try {
    tokenEndpoint = await trustedOAuthUrl(
      state.tokenEndpoint,
      allowedOauthOrigins,
      "Token endpoint",
    );
  } catch (e) {
    return back(
      state.workspaceSlug,
      provider.slug,
      "error",
      `Token endpoint is not trusted: ${(e as Error).message}`,
    );
  }
  // Client authentication at the token exchange:
  //  - manual (BYO confidential app): client_secret_post (body) by default, or
  //    client_secret_basic (HTTP Basic) when the AS only advertises that (Zoom).
  //  - dcr_confidential (Avoma): the DCR-issued secret (decrypted from state) via
  //    HTTP Basic — the spec default when the server omits the auth-method field.
  //  - dcr (public): PKCE only, no secret.
  const tokenParams: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUriFor(provider.slug as McpProviderSlug),
    client_id: state.clientId,
    code_verifier: state.pkceVerifier,
  };
  const tokenHeaders: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  // dcr_confidential: recover the DCR client_secret for both the token exchange
  // and persistence (so refresh can present it). Decrypted under the connection AAD.
  let confidentialSecret: string | null = null;
  if (state.authMode === "manual") {
    const byo = await getNativeOAuthClientSecret(
      state.workspaceId,
      provider.slug,
      state.instance ?? "default",
    );
    if (!byo) {
      return back(
        state.workspaceSlug,
        provider.slug,
        "error",
        `The ${provider.displayName} OAuth app is no longer configured. Re-add it under Connections.`,
      );
    }
    if (state.tokenEndpointAuthMethod === "client_secret_basic") {
      tokenHeaders.Authorization =
        "Basic " +
        Buffer.from(`${state.clientId}:${byo.clientSecret}`).toString("base64");
      // RFC 6749: when using Basic, omit client_id/secret from the body.
      delete tokenParams.client_id;
    } else {
      tokenParams.client_secret = byo.clientSecret;
    }
  } else if (
    state.authMode === "dcr_confidential" &&
    state.clientSecretCiphertext
  ) {
    try {
      confidentialSecret = decryptSecret(
        Buffer.from(state.clientSecretCiphertext, "base64"),
        aadNativeConnection(
          state.workspaceId,
          state.userId,
          provider.slug,
          state.connectionName,
        ),
      );
    } catch {
      return back(
        state.workspaceSlug,
        provider.slug,
        "error",
        "Could not recover the OAuth client secret — please reconnect.",
      );
    }
    tokenHeaders.Authorization =
      "Basic " +
      Buffer.from(`${state.clientId}:${confidentialSecret}`).toString("base64");
  }
  try {
    const tokenRes = await fetchOAuthEndpoint(
      tokenEndpoint,
      allowedOauthOrigins,
      "Token endpoint",
      {
        method: "POST",
        headers: tokenHeaders,
        body: new URLSearchParams(tokenParams).toString(),
      },
    );
    if (!tokenRes.ok) {
      const body = await tokenRes.text().catch(() => "");
      return back(
        state.workspaceSlug,
        provider.slug,
        "error",
        `Token exchange failed (${tokenRes.status}): ${body.slice(0, 200)}`,
      );
    }
    tokenJson = await tokenRes.json();
  } catch (e) {
    return back(
      state.workspaceSlug,
      provider.slug,
      "error",
      `Token exchange fetch failed: ${(e as Error).message}`,
    );
  }
  if (!tokenJson.access_token) {
    return back(
      state.workspaceSlug,
      provider.slug,
      "error",
      `${provider.displayName} returned no access token.`,
    );
  }

  const expiresAt = tokenJson.expires_in
    ? new Date(Date.now() + tokenJson.expires_in * 1000).toISOString()
    : undefined;

  const saved = await saveNativeConnection({
    workspaceId: state.workspaceId,
    userId: state.userId,
    type: provider.slug as McpProviderSlug,
    name: state.connectionName,
    mcpServerUrl,
    authType: "oauth2",
    credentials: {
      access_token: tokenJson.access_token,
      refresh_token: tokenJson.refresh_token,
      expires_at: expiresAt,
      scope: tokenJson.scope,
      token_type: tokenJson.token_type,
      // dcr_confidential: stash the DCR client_id + secret WITH the connection
      // (encrypted with the credentials blob) so the Rust refresh can present
      // them via Basic — there's no per-workspace BYO app to read them from.
      ...(state.authMode === "dcr_confidential" && confidentialSecret
        ? { client_id: state.clientId, client_secret: confidentialSecret }
        : {}),
    },
    // The client identity the refresh exchange must present:
    //  - manual: BYO client_id + auth_mode → refresh reads the secret from
    //    workspace_native_oauth_client.
    //  - dcr_confidential: auth_mode → refresh reads client_id/secret from the
    //    credentials blob (above) and uses Basic.
    //  - dcr (public): just the registered client_id, no secret.
    metadata: {
      ...(state.authMode === "manual"
        ? {
            auth_mode: "manual",
            client_id: state.clientId,
            instance: state.instance ?? "default",
            // Zoom etc. need Basic on refresh; HubSpot keeps post (default).
            ...(state.tokenEndpointAuthMethod
              ? {
                  token_endpoint_auth_method: state.tokenEndpointAuthMethod,
                }
              : {}),
          }
        : state.authMode === "dcr_confidential"
          ? { auth_mode: "dcr_confidential", dcr_client_id: state.clientId }
          : { dcr_client_id: state.clientId }),
      // Instance-based: tell the Rust refresh to trust this connection's own
      // (same-origin) endpoints rather than the fixed compile-time allowlist.
      ...(state.mcpServerUrl ? { instance_based: true } : {}),
    },
  });

  await writeAuditEvent({
    workspaceId: state.workspaceId,
    actorUserId: state.userId,
    source: "human_action",
    kind: "connection.authorized",
    targetType: "connection",
    targetId: saved.id,
    agentName: null,
    payload: {
      provider: provider.slug,
      name: state.connectionName,
      source: "native-mcp",
    },
  });

  // Best-effort: prime the tool-list cache so the Connections page
  // can show "N tools available" immediately. Don't block the
  // redirect on failure — the connection itself is good, and we can
  // backfill the cache later (refresh button, or lazy on first
  // render). Just log so a recurring failure is visible.
  try {
    const tools = await fetchNativeMcpTools(
      mcpServerUrl,
      tokenJson.access_token,
      (url, init) =>
        fetchOAuthEndpoint(
          url,
          [new URL(mcpServerUrl).origin],
          "MCP tools endpoint",
          init,
        ),
    );
    await replaceToolsForConnection({
      workspaceId: state.workspaceId,
      userId: state.userId,
      source: "native-mcp",
      provider: provider.slug,
      connectionName: state.connectionName,
      tools: tools.map((t) => ({
        slug: t.slug,
        displayName: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
  } catch (e) {
    console.error(
      `[native-mcp/${provider.slug}] tool-cache prime failed:`,
      (e as Error).message,
    );
  }

  // Land on the new connection's detail view.
  const ok = new URL(
    `/${state.workspaceSlug}/connections/native~${saved.id}`,
    getPublicOrigin(),
  );
  ok.searchParams.set("result", "ok");
  return NextResponse.redirect(ok, 302);
}
