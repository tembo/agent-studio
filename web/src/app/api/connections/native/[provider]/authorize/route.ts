import { createHash, randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { authorizeWorkspace } from "@/lib/auth-server";
import { getPublicOrigin } from "@/lib/config";
import { createApiKey, deleteApiKey } from "@/lib/api-keys-db";
import { encryptSecret } from "@/lib/crypto";
import { aadNativeConnection } from "@/lib/crypto-aad";
import {
  getNativeConnection,
  saveNativeConnection,
} from "@/lib/connections";
import {
  getMcpProvider,
  isInstanceProvider,
  redirectUriFor,
  resolveInstanceMcpUrl,
  tasMcpServerUrl,
  type McpProvider,
  type McpProviderSlug,
} from "@/lib/mcp-providers";
import { fetchNativeMcpTools } from "@/lib/native-mcp-tools";
import { replaceToolsForConnection } from "@/lib/mcp-tools";
import {
  noRedirectFetchInit,
  trustedMcpOrigin,
  trustedOAuthUrl,
} from "@/lib/native-oauth-security";
import {
  dcrRegistrationFailureMessage,
  getReusableDcrRegistration,
} from "@/lib/native-dcr-registration";
import {
  DEFAULT_INSTANCE,
  getNativeOAuthClientPreview,
} from "@/lib/native-oauth-clients";
import { signNativeMcpState } from "@/lib/oauth-state";

// Native-MCP OAuth authorize handler. URL shape:
//
//   DCR:    GET /api/connections/native/<provider>/authorize?workspace=<slug>&name=<slot>
//   manual: GET /api/connections/native/<provider>/authorize?workspace=<slug>&app=<instance>
//
// For manual (BYO-app) providers the connection's slot name IS the OAuth-app
// instance, so `?app=` picks which app to use AND names the connection; `?name=`
// is ignored. DCR providers use the free-typed `?name=` slot.
//
// MCP-spec auth flow — no per-provider OAuth-app setup needed:
//
//   1. Discover authorization server metadata via the MCP server's
//      /.well-known/oauth-protected-resource endpoint.
//   2. Fetch /.well-known/oauth-authorization-server from the
//      provider's auth server to get registration / authorize /
//      token endpoints + supported scopes.
//   3. Reuse this connection's registered OAuth client when reconnecting.
//      Otherwise, Dynamic Client Registration (RFC 7591) POSTs our redirect
//      URI to registration_endpoint and returns a client_id.
//   4. Generate a PKCE verifier and its S256 challenge. The verifier
//      lands in the signed state token (opaque to the provider);
//      the challenge goes in the /authorize redirect URL.
//   5. Redirect the user to authorization_endpoint with all of the
//      above + scopes from the protected-resource metadata.

function back(slug: string, provider: string, detail: string): NextResponse {
  const target = new URL(`/${slug}/connections`, getPublicOrigin());
  target.searchParams.set("native_mcp", provider);
  target.searchParams.set("result", "error");
  target.searchParams.set("detail", detail.slice(0, 200));
  return NextResponse.redirect(target, 302);
}

/**
 * Self-key connect (Tembo connecting to its own /mcp). No OAuth: mint a
 * per-user `tas_` API key, store it as the connection's bearer, and point the
 * row at TAS's own MCP server. Because the key is owned by the connecting user,
 * /mcp resolves *their* live workspace role at run time — so an agent that uses
 * this connection acts with the role of whoever the run runs as. Reconnecting
 * the same slot revokes the previously minted key so we never orphan a live
 * credential.
 */
async function connectSelfKey(
  provider: McpProvider,
  workspace: { id: string; slug: string },
  userId: string,
  connectionName: string,
): Promise<NextResponse> {
  // Capture any key minted by a prior connect on this slot — revoked after the
  // new one is stored (the saveNativeConnection upsert overwrites credentials).
  const prior = await getNativeConnection(
    workspace.id,
    userId,
    provider.slug,
    connectionName,
  );
  const priorKeyId =
    typeof prior?.metadata.api_key_id === "string"
      ? prior.metadata.api_key_id
      : null;

  const mcpUrl = tasMcpServerUrl();
  const { key, token } = await createApiKey({
    workspaceId: workspace.id,
    userId,
    name: "Tembo (native MCP)",
    createdBy: userId,
  });

  const saved = await saveNativeConnection({
    workspaceId: workspace.id,
    userId,
    type: provider.slug,
    name: connectionName,
    mcpServerUrl: mcpUrl,
    // "pat", with no token_expires_at, so the OAuth refresh sweep skips it —
    // the tas_ key doesn't expire.
    authType: "pat",
    credentials: { access_token: token },
    metadata: { api_key_id: key.id },
  });

  if (priorKeyId && priorKeyId !== key.id) {
    await deleteApiKey(workspace.id, priorKeyId);
  }

  // No audit event: a self-key (Tembo Agent Studio) connection is minted
  // implicitly/automatically — and re-minted on reconnect — so logging each one
  // as "Connection authorized" just floods the timeline with noise. Real OAuth
  // authorizations (DCR/manual) are still audited in the callback route.

  // Best-effort: prime the tool-list cache so the Connections page shows the
  // TAS tool catalog immediately. Don't block the redirect on failure.
  try {
    const tools = await fetchNativeMcpTools(mcpUrl, token);
    await replaceToolsForConnection({
      workspaceId: workspace.id,
      userId,
      source: "native-mcp",
      provider: provider.slug,
      connectionName,
      tools: tools.map((t) => ({
        slug: t.slug,
        displayName: t.name,
        description: t.description,
      })),
    });
  } catch (e) {
    console.error(
      `[native-mcp/${provider.slug}] tool-cache prime failed:`,
      (e as Error).message,
    );
  }

  // Land on the new connection's detail view.
  const target = new URL(
    `/${workspace.slug}/connections/native~${saved.id}`,
    getPublicOrigin(),
  );
  target.searchParams.set("result", "ok");
  return NextResponse.redirect(target, 302);
}

type RouteParams = Promise<{ provider: string }>;

type ProtectedResourceMetadata = {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
};

type AuthServerMetadata = {
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
  code_challenge_methods_supported?: string[];
  grant_types_supported?: string[];
};

type DcrResponse = {
  client_id?: string;
  /** Present when the server registers a CONFIDENTIAL client (Avoma). We capture
   *  it and present it (HTTP Basic) at token exchange + refresh. */
  client_secret?: string;
};

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

  const slug = request.nextUrl.searchParams.get("workspace");
  if (!slug) {
    return NextResponse.json(
      { error: "workspace query param required" },
      { status: 400 },
    );
  }
  // manual (BYO-app) providers use a confidential client per app instance; DCR
  // providers self-register a public client per named slot.
  const isManual = provider.authMode === "manual";
  const slotRaw = isManual
    ? (request.nextUrl.searchParams.get("app") ?? DEFAULT_INSTANCE)
    : (request.nextUrl.searchParams.get("name") ?? DEFAULT_INSTANCE);
  // For manual providers the instance slug doubles as the connection name.
  const connectionName = slotRaw.trim().toLowerCase();
  const instance = connectionName;
  if (!/^[a-z0-9_-]+$/.test(connectionName)) {
    return NextResponse.json(
      { error: `bad ${isManual ? "app instance" : "connection name"} shape: ${slotRaw}` },
      { status: 400 },
    );
  }

  const auth = await authorizeWorkspace(slug, "operator");
  if (!auth.ok) {
    if (auth.reason === "no-session") {
      return NextResponse.redirect(new URL("/", request.url), 302);
    }
    if (auth.reason === "no-workspace") {
      return NextResponse.json(
        { error: "workspace not found" },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { error: "insufficient role — operator required" },
      { status: 403 },
    );
  }
  const { workspace, userId } = auth;

  // Self-key providers (Tembo → its own /mcp) skip the entire OAuth dance:
  // mint a per-user tas_ key and store it as the connection bearer.
  if (provider.authMode === "self-key") {
    return connectSelfKey(provider, workspace, userId, connectionName);
  }
  // PAT / static-bearer providers use a form + server action, not this OAuth
  // route. Bounce back to the connect page so the user pastes a token there.
  if (provider.authMode === "pat") {
    return NextResponse.redirect(
      new URL(
        `/${workspace.slug}/connections/new?provider=${encodeURIComponent(provider.slug)}`,
        getPublicOrigin(),
      ),
      302,
    );
  }

  // Resolve the MCP server URL. Fixed providers use the catalog constant;
  // instance-based (self-hosted, e.g. Metabase) take the host the operator
  // entered (?base=…) and apply the template — so the URL is per-connection.
  let mcpServerUrl: string;
  if (isInstanceProvider(provider)) {
    const baseRaw = request.nextUrl.searchParams.get("base") ?? "";
    const resolved = resolveInstanceMcpUrl(provider, baseRaw);
    if (!resolved) {
      return back(
        workspace.slug,
        provider.slug,
        `Enter your ${provider.displayName} URL (e.g. https://metabase.example.com).`,
      );
    }
    mcpServerUrl = resolved;
  } else {
    mcpServerUrl = provider.mcpServerUrl;
  }

  // ── Step 1: protected-resource discovery ────────────────────────
  let mcpOrigin: string;
  try {
    mcpOrigin = await trustedMcpOrigin(mcpServerUrl);
  } catch (e) {
    return back(
      workspace.slug,
      provider.slug,
      `Provider MCP URL is not trusted: ${(e as Error).message}`,
    );
  }
  // OAuth endpoint trust: fixed providers use the catalog allowlist; instance-
  // based providers trust the user's own origin (same-origin — every discovered
  // endpoint must live on the host they typed). SSRF guards (https + public DNS)
  // apply either way, inside trustedOAuthUrl.
  const allowedOauthOrigins = isInstanceProvider(provider)
    ? [mcpOrigin]
    : provider.oauthAuthorizationServerOrigins;
  // RFC 9728 metadata lives at the origin, but some servers (Gmail) only serve
  // it PATH-SUFFIXED with the resource's path (…/oauth-protected-resource/mcp/v1)
  // and 404 at the bare origin. Try the origin first (all current providers),
  // then the path-suffixed form derived from the MCP URL.
  const resourcePath = new URL(mcpServerUrl).pathname.replace(/\/+$/, "");
  const prCandidates = [`${mcpOrigin}/.well-known/oauth-protected-resource`];
  if (resourcePath && resourcePath !== "/") {
    prCandidates.push(
      `${mcpOrigin}/.well-known/oauth-protected-resource${resourcePath}`,
    );
  }
  let prMeta: ProtectedResourceMetadata | null = null;
  let lastDetail = "";
  for (const prMetaUrl of prCandidates) {
    try {
      const res = await fetch(
        prMetaUrl,
        noRedirectFetchInit({ headers: { Accept: "application/json" } }),
      );
      if (!res.ok) {
        lastDetail = `Couldn't discover ${provider.displayName} MCP auth metadata (${res.status}).`;
        continue;
      }
      prMeta = (await res.json()) as ProtectedResourceMetadata;
      break;
    } catch (e) {
      lastDetail = `Discovery fetch failed: ${(e as Error).message}`;
    }
  }
  if (!prMeta) {
    return back(workspace.slug, provider.slug, lastDetail || "Discovery failed.");
  }
  const authServerUrlRaw = prMeta.authorization_servers?.[0];
  if (!authServerUrlRaw) {
    return back(
      workspace.slug,
      provider.slug,
      `${provider.displayName} MCP didn't advertise an authorization server.`,
    );
  }
  let authServerUrl: URL;
  try {
    authServerUrl = await trustedOAuthUrl(
      authServerUrlRaw,
      allowedOauthOrigins,
      "Authorization server URL",
    );
  } catch (e) {
    return back(
      workspace.slug,
      provider.slug,
      `Authorization server URL is not trusted: ${(e as Error).message}`,
    );
  }
  // A catalog scopeOverride narrows an over-broad advertised set (e.g. Gmail
  // advertises full-mailbox access; we ask for readonly+compose only).
  const scopes = provider.scopeOverride ?? prMeta.scopes_supported ?? [];

  // ── Step 2: authorization-server discovery ──────────────────────
  // RFC 8414: bare `/.well-known/oauth-authorization-server` at the auth
  // server origin, plus the path-aware form when the issuer has a path
  // (Stripe advertises https://access.stripe.com/mcp → metadata lives at
  // …/oauth-authorization-server/mcp). Some servers (GitHub) only publish
  // OpenID discovery. Also try the MCP origin itself (Stripe serves a
  // copy there). First successful JSON wins.
  const asIssuerPath = authServerUrl.pathname.replace(/\/+$/, "");
  const asCandidates = [
    `${authServerUrl.origin}/.well-known/oauth-authorization-server`,
    ...(asIssuerPath && asIssuerPath !== "/"
      ? [
          `${authServerUrl.origin}/.well-known/oauth-authorization-server${asIssuerPath}`,
        ]
      : []),
    `${authServerUrl.origin}/.well-known/openid-configuration`,
    ...(asIssuerPath && asIssuerPath !== "/"
      ? [`${authServerUrl.href.replace(/\/+$/, "")}/.well-known/openid-configuration`]
      : []),
    `${mcpOrigin}/.well-known/oauth-authorization-server`,
  ];
  // De-dupe while preserving order.
  const seenAs = new Set<string>();
  const asUrls = asCandidates.filter((u) => {
    if (seenAs.has(u)) return false;
    seenAs.add(u);
    return true;
  });
  let asMeta: AuthServerMetadata | null = null;
  let asLastDetail = "";
  for (const asMetaUrl of asUrls) {
    try {
      const res = await fetch(
        asMetaUrl,
        noRedirectFetchInit({ headers: { Accept: "application/json" } }),
      );
      if (!res.ok) {
        asLastDetail = `Couldn't fetch authorization server metadata (${res.status}).`;
        continue;
      }
      asMeta = (await res.json()) as AuthServerMetadata;
      break;
    } catch (e) {
      asLastDetail = `Authorization server metadata fetch failed: ${(e as Error).message}`;
    }
  }
  if (!asMeta) {
    return back(
      workspace.slug,
      provider.slug,
      asLastDetail || "Authorization server discovery failed.",
    );
  }
  // "manual" providers (HubSpot) use a confidential BYO OAuth app and have no
  // registration_endpoint; "dcr" providers (Attio, Pylon) self-register a
  // public client. (isManual computed above with the slot parsing.)
  if (
    !asMeta.authorization_endpoint ||
    !asMeta.token_endpoint ||
    (!isManual && !asMeta.registration_endpoint)
  ) {
    return back(
      workspace.slug,
      provider.slug,
      `${provider.displayName} authorization server is missing required endpoints.`,
    );
  }
  // Ask for a refresh token when the provider can mint one. A server that
  // supports the `refresh_token` grant typically only ISSUES a refresh_token
  // when the client also requests the OIDC `offline_access` scope (the
  // resource's own scopes_supported rarely lists it). Without it the access
  // token expires — e.g. Dialed's ~3h — and the refresh-before-use sweep has
  // nothing to renew, so the next run 401s. Only for DCR (public) providers:
  // manual (BYO-app) providers like HubSpot use their own scope vocabulary and
  // already mint refresh tokens, so an unknown `offline_access` could break
  // their connect. Gate on the advertised grant, and never duplicate it.
  if (
    !isManual &&
    !provider.omitOfflineAccess &&
    (asMeta.grant_types_supported ?? []).includes("refresh_token") &&
    !scopes.includes("offline_access")
  ) {
    scopes.push("offline_access");
  }
  let authorizationEndpoint: URL;
  let tokenEndpoint: URL;
  try {
    authorizationEndpoint = await trustedOAuthUrl(
      asMeta.authorization_endpoint,
      allowedOauthOrigins,
      "Authorization endpoint",
    );
    tokenEndpoint = await trustedOAuthUrl(
      asMeta.token_endpoint,
      allowedOauthOrigins,
      "Token endpoint",
    );
  } catch (e) {
    return back(
      workspace.slug,
      provider.slug,
      `Authorization server endpoint is not trusted: ${(e as Error).message}`,
    );
  }
  // Require advertised S256 for DCR (public) clients. Manual/BYO providers
  // (GitHub) often omit code_challenge_methods_supported from their metadata
  // but still accept PKCE S256 — we send it either way; reject only when the
  // server explicitly lists methods and S256 isn't among them.
  const pkceMethods = asMeta.code_challenge_methods_supported;
  if (
    pkceMethods &&
    pkceMethods.length > 0 &&
    !pkceMethods.some((m) => m === "S256")
  ) {
    return back(
      workspace.slug,
      provider.slug,
      `${provider.displayName} auth server doesn't support PKCE/S256 — auth flow won't complete safely.`,
    );
  }
  if (!isManual && !(pkceMethods ?? []).some((m) => m === "S256")) {
    return back(
      workspace.slug,
      provider.slug,
      `${provider.displayName} auth server doesn't support PKCE/S256 — auth flow won't complete safely.`,
    );
  }

  const redirectUri = redirectUriFor(provider.slug as McpProviderSlug);
  const authMethods = asMeta.token_endpoint_auth_methods_supported ?? [];

  // ── Step 3: obtain a client_id ──────────────────────────────────
  let clientId: string;
  // Set when DCR registers a CONFIDENTIAL client (Avoma) — the secret to present.
  let dcrClientSecret: string | null = null;
  // For manual (BYO) confidential clients: which token-endpoint auth method
  // to use. Prefer client_secret_post (HubSpot/Gmail legacy); fall back to
  // client_secret_basic when that's all the AS advertises (Zoom). Empty
  // methods_supported → post (same as before).
  let manualTokenAuth: "client_secret_post" | "client_secret_basic" =
    "client_secret_post";
  if (isManual) {
    const supportsPost = authMethods.some((m) => m === "client_secret_post");
    const supportsBasic = authMethods.some((m) => m === "client_secret_basic");
    if (authMethods.length > 0 && !supportsPost && !supportsBasic) {
      return back(
        workspace.slug,
        provider.slug,
        `${provider.displayName} auth server doesn't support client_secret_post or client_secret_basic.`,
      );
    }
    if (!supportsPost && supportsBasic) {
      manualTokenAuth = "client_secret_basic";
    }
    const byo = await getNativeOAuthClientPreview(
      workspace.id,
      provider.slug,
      instance,
    );
    if (!byo) {
      return back(
        workspace.slug,
        provider.slug,
        `The ${provider.displayName} app "${instance}" isn't configured. An admin can add it under Connections → Native MCP → Manage providers.`,
      );
    }
    clientId = byo.clientId;
  } else {
    const reusable = await getReusableDcrRegistration({
      workspaceId: workspace.id,
      userId,
      provider: provider.slug,
      connectionName,
      mcpServerUrl,
    });
    if (reusable) {
      clientId = reusable.clientId;
      dcrClientSecret = reusable.clientSecret;
    } else {
      // The server decides public vs confidential: a public client gets no
      // secret (PKCE only); a confidential one returns a client_secret we keep
      // for token exchange, refresh, and future reconnects.
      let registrationEndpoint: URL;
      try {
        registrationEndpoint = await trustedOAuthUrl(
          asMeta.registration_endpoint as string,
          allowedOauthOrigins,
          "Registration endpoint",
        );
      } catch (e) {
        return back(
          workspace.slug,
          provider.slug,
          `Registration endpoint is not trusted: ${(e as Error).message}`,
        );
      }
      try {
        const dcrRes = await fetch(
          registrationEndpoint,
          noRedirectFetchInit({
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              client_name: "Tembo Agent Studio",
              redirect_uris: [redirectUri],
              token_endpoint_auth_method: "none",
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
            }),
          }),
        );
        if (!dcrRes.ok) {
          const body = await dcrRes.text().catch(() => "");
          console.error(
            `[native-mcp/${provider.slug}] dynamic client registration failed (${dcrRes.status}): ${body.slice(0, 500)}`,
          );
          return back(
            workspace.slug,
            provider.slug,
            dcrRegistrationFailureMessage(provider.displayName, dcrRes.status),
          );
        }
        const dcrJson = (await dcrRes.json()) as DcrResponse;
        if (!dcrJson.client_id) {
          return back(
            workspace.slug,
            provider.slug,
            `DCR succeeded but no client_id in the response.`,
          );
        }
        clientId = dcrJson.client_id;
        if (dcrJson.client_secret) {
          dcrClientSecret = dcrJson.client_secret;
        }
      } catch (e) {
        return back(
          workspace.slug,
          provider.slug,
          `DCR fetch failed: ${(e as Error).message}`,
        );
      }
    }
    // Confidential DCR returns a secret. Without one, the authorization server
    // must explicitly support public clients authenticated by PKCE.
    if (!dcrClientSecret && !authMethods.some((m) => m === "none")) {
      return back(
        workspace.slug,
        provider.slug,
        `${provider.displayName} auth server requires a confidential client but DCR returned no client_secret.`,
      );
    }
  }

  // ── Step 4: PKCE verifier + S256 challenge ──────────────────────
  // Verifier: 32 bytes → 43 base64url chars. Within spec (43–128).
  const pkceVerifier = randomBytes(32).toString("base64url");
  const pkceChallenge = createHash("sha256")
    .update(pkceVerifier)
    .digest("base64url");

  // ── Step 5: sign state + redirect ───────────────────────────────
  const confidentialDcr = !isManual && dcrClientSecret !== null;
  const state = signNativeMcpState({
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
    userId,
    provider: provider.slug,
    connectionName,
    pkceVerifier,
    clientId,
    tokenEndpoint: tokenEndpoint.toString(),
    authMode: isManual ? "manual" : confidentialDcr ? "dcr_confidential" : "dcr",
    ...(isManual
      ? { instance, tokenEndpointAuthMethod: manualTokenAuth }
      : {}),
    // Instance-based: persist the resolved per-connection URL so the callback
    // stores it (and validates same-origin) — provider.mcpServerUrl is empty.
    ...(isInstanceProvider(provider) ? { mcpServerUrl } : {}),
    // Carry the DCR-issued client_secret to the callback ENCRYPTED (state is
    // signed but readable, and round-trips through the provider). AAD-bound to
    // this connection so the ciphertext is useless elsewhere.
    ...(confidentialDcr
      ? {
          clientSecretCiphertext: encryptSecret(
            dcrClientSecret as string,
            aadNativeConnection(
              workspace.id,
              userId,
              provider.slug,
              connectionName,
            ),
          ).toString("base64"),
        }
      : {}),
  });

  const authorizeUrl = new URL(authorizationEndpoint);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  if (scopes.length > 0) {
    authorizeUrl.searchParams.set("scope", scopes.join(" "));
  }
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", pkceChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  // Provider-specific extras (e.g. Google's access_type=offline + prompt=consent
  // to mint a refresh_token). Applied last; never overrides the params above.
  for (const [k, v] of Object.entries(provider.authorizeParams ?? {})) {
    if (!authorizeUrl.searchParams.has(k)) authorizeUrl.searchParams.set(k, v);
  }

  return NextResponse.redirect(authorizeUrl.toString(), 302);
}
