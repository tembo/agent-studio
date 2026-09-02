import "server-only";

import { getPublicOrigin } from "@/lib/config";

// Configured sign-in providers, derived from env (each provider is
// enabled by the presence of its credentials, like Google has always
// been). Google is a built-in better-auth social provider; Microsoft
// (Entra ID) and a generic OIDC provider both go through the
// genericOAuth plugin (Microsoft = a known Entra discovery URL).
//
// Pure env reads, server-only. The login page calls
// getConfiguredAuthProviders() and passes the plain list to the client
// button component (so the client never imports this module).

export type AuthProviderKind = "social" | "oauth2";

export type AuthProvider = {
  /** better-auth provider id / genericOAuth providerId. */
  id: string;
  label: string;
  /** Selects the provider's registered callback URI shape. */
  kind: AuthProviderKind;
};

function googleConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
  );
}

function microsoftConfigured(): boolean {
  return Boolean(
    process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET,
  );
}

function oidcConfigured(): boolean {
  return Boolean(
    process.env.OIDC_CLIENT_ID &&
      process.env.OIDC_CLIENT_SECRET &&
      process.env.OIDC_DISCOVERY_URL,
  );
}

/** Entra ID OIDC discovery URL for the configured tenant. */
export function microsoftDiscoveryUrl(): string {
  const tenant = process.env.MICROSOFT_TENANT_ID?.trim() || "common";
  return `https://login.microsoftonline.com/${tenant}/v2.0/.well-known/openid-configuration`;
}

export function getConfiguredAuthProviders(): AuthProvider[] {
  const out: AuthProvider[] = [];
  if (googleConfigured()) {
    out.push({ id: "google", label: "Google", kind: "social" });
  }
  if (microsoftConfigured()) {
    out.push({ id: "microsoft", label: "Microsoft", kind: "oauth2" });
  }
  if (oidcConfigured()) {
    out.push({
      id: "oidc",
      label: process.env.OIDC_PROVIDER_NAME?.trim() || "SSO",
      kind: "oauth2",
    });
  }
  return out;
}

export function authProviderRedirectUri(
  provider: Pick<AuthProvider, "id" | "kind">,
  origin: string,
): string {
  const base = origin.replace(/\/$/, "");
  return provider.kind === "social"
    ? `${base}/api/auth/callback/${provider.id}`
    : `${base}/api/auth/oauth2/callback/${provider.id}`;
}

export function isAnyAuthConfigured(): boolean {
  return getConfiguredAuthProviders().length > 0;
}

/**
 * Email + password is the zero-config quickstart: it auto-enables when NO OAuth
 * provider (Google / Microsoft / OIDC) is configured, so a fresh instance is
 * reachable without setting up an OAuth app. Configure any OAuth provider and
 * this turns off — OAuth becomes the path. The instance sign-up policy
 * (invite-only by default) still governs who may create an account.
 */
export function emailPasswordEnabled(): boolean {
  return !isAnyAuthConfigured();
}

type OAuthUserInfo = {
  id: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  image?: string;
};

export type GenericOAuthProviderConfig = {
  providerId: string;
  accountIssuer: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  redirectURI: string;
  getUserInfo?: (tokens: {
    idToken?: string;
  }) => Promise<OAuthUserInfo | null>;
};

/**
 * Microsoft Entra commonly omits the `email` claim from both the
 * id_token and the userinfo endpoint — the address instead rides in
 * `preferred_username` (or `upn`). better-auth's default getUserInfo
 * discards the id_token entirely when it lacks `email`, then falls
 * through to the userinfo endpoint, which doesn't carry those fields
 * either — so sign-in dies with `email_is_missing`. Decode the id_token
 * ourselves and synthesize the email from the first claim that actually
 * looks like one. The token was just exchanged over TLS using our client
 * secret, so reading the (unverified) payload here is safe.
 */
async function microsoftGetUserInfo(tokens: {
  idToken?: string;
}): Promise<OAuthUserInfo | null> {
  const idToken = tokens.idToken;
  if (!idToken) return null;
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const sub = typeof claims.sub === "string" ? claims.sub : undefined;
  // Prefer a real `email`, then the UPN-style claims, and only accept a
  // value that looks like an address (Entra's preferred_username can be
  // a GUID for some account types).
  const email = [claims.email, claims.preferred_username, claims.upn].find(
    (v): v is string => typeof v === "string" && v.includes("@"),
  );
  if (!sub || !email) return null;
  const name =
    (typeof claims.name === "string" && claims.name) ||
    (typeof claims.preferred_username === "string" &&
      claims.preferred_username) ||
    email;
  return {
    id: sub,
    email,
    // Entra authenticated the user against the org directory; treat the
    // address as verified so gating / account-linking behave normally.
    emailVerified: true,
    name,
    image: typeof claims.picture === "string" ? claims.picture : undefined,
  };
}

/** genericOAuth plugin config entries (Microsoft + generic OIDC). */
export function genericOAuthConfigs(): GenericOAuthProviderConfig[] {
  const configs: GenericOAuthProviderConfig[] = [];
  if (microsoftConfigured()) {
    configs.push({
      providerId: "microsoft",
      // Keep account identity provider-scoped, as it was in Better Auth 1.6.
      // Discovery still verifies the token's real issuer independently.
      accountIssuer: "local:oauth:microsoft",
      discoveryUrl: microsoftDiscoveryUrl(),
      clientId: process.env.MICROSOFT_CLIENT_ID!,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET!,
      scopes: ["openid", "profile", "email"],
      redirectURI: authProviderRedirectUri(
        { id: "microsoft", kind: "oauth2" },
        getPublicOrigin(),
      ),
      getUserInfo: microsoftGetUserInfo,
    });
  }
  if (oidcConfigured()) {
    configs.push({
      providerId: "oidc",
      accountIssuer: "local:oauth:oidc",
      discoveryUrl: process.env.OIDC_DISCOVERY_URL!,
      clientId: process.env.OIDC_CLIENT_ID!,
      clientSecret: process.env.OIDC_CLIENT_SECRET!,
      scopes: (process.env.OIDC_SCOPES?.trim() || "openid profile email").split(
        /\s+/,
      ),
      redirectURI: authProviderRedirectUri(
        { id: "oidc", kind: "oauth2" },
        getPublicOrigin(),
      ),
    });
  }
  return configs;
}
