import { afterEach, describe, expect, it } from "vitest";

import {
  authProviderRedirectUri,
  emailPasswordEnabled,
  genericOAuthConfigs,
  getConfiguredAuthProviders,
  microsoftProviderConfig,
} from "./auth-providers";

const ORIGINAL_ENV = process.env;

function setEnv(env: Record<string, string>) {
  process.env = { ...ORIGINAL_ENV, ...env };
}

function clearProviderEnv() {
  process.env = { ...ORIGINAL_ENV };
  for (const key of [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "MICROSOFT_CLIENT_ID",
    "MICROSOFT_CLIENT_SECRET",
    "MICROSOFT_TENANT_ID",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "OIDC_DISCOVERY_URL",
    "OIDC_PROVIDER_NAME",
    "OIDC_SCOPES",
  ]) {
    delete process.env[key];
  }
}

function unsignedJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.`;
}

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe("auth provider configuration", () => {
  it("renders every configured provider independently", () => {
    clearProviderEnv();
    setEnv({
      GOOGLE_CLIENT_ID: "google-id",
      GOOGLE_CLIENT_SECRET: "google-secret",
      MICROSOFT_CLIENT_ID: "microsoft-id",
      MICROSOFT_CLIENT_SECRET: "microsoft-secret",
      OIDC_CLIENT_ID: "oidc-id",
      OIDC_CLIENT_SECRET: "oidc-secret",
      OIDC_DISCOVERY_URL: "https://idp.example.com/.well-known/openid-configuration",
      OIDC_PROVIDER_NAME: "Acme SSO",
    });

    expect(getConfiguredAuthProviders()).toEqual([
      { id: "google", label: "Google", kind: "social" },
      { id: "microsoft", label: "Microsoft", kind: "oauth2" },
      { id: "oidc", label: "Acme SSO", kind: "oauth2" },
    ]);
    expect(emailPasswordEnabled()).toBe(false);
  });

  it("builds the redirect URIs expected by each provider type", () => {
    expect(
      authProviderRedirectUri(
        { id: "google", kind: "social" },
        "https://tas.example.com/",
      ),
    ).toBe("https://tas.example.com/api/auth/callback/google");
    expect(
      authProviderRedirectUri(
        { id: "microsoft", kind: "oauth2" },
        "https://tas.example.com/",
      ),
    ).toBe("https://tas.example.com/api/auth/oauth2/callback/microsoft");
    expect(
      authProviderRedirectUri(
        { id: "oidc", kind: "oauth2" },
        "https://tas.example.com",
      ),
    ).toBe("https://tas.example.com/api/auth/oauth2/callback/oidc");
  });

  it("configures Microsoft through its built-in provider and OIDC generically", () => {
    clearProviderEnv();
    setEnv({
      MICROSOFT_CLIENT_ID: "microsoft-id",
      MICROSOFT_CLIENT_SECRET: "microsoft-secret",
      MICROSOFT_TENANT_ID: "tenant-123",
      OIDC_CLIENT_ID: "oidc-id",
      OIDC_CLIENT_SECRET: "oidc-secret",
      OIDC_DISCOVERY_URL: "https://idp.example.com/.well-known/openid-configuration",
      OIDC_SCOPES: "openid profile email groups",
      BETTER_AUTH_URL: "https://tas.example.com",
    });

    expect(microsoftProviderConfig()).toMatchObject({
      clientId: "microsoft-id",
      clientSecret: "microsoft-secret",
      tenantId: "tenant-123",
      disableDefaultScope: true,
      scope: ["openid", "profile", "email"],
      redirectURI: "https://tas.example.com/api/auth/oauth2/callback/microsoft",
    });
    expect(genericOAuthConfigs()).toMatchObject([
      {
        providerId: "oidc",
        accountIssuer: "local:oauth:oidc",
        discoveryUrl: "https://idp.example.com/.well-known/openid-configuration",
        clientId: "oidc-id",
        clientSecret: "oidc-secret",
        scopes: ["openid", "profile", "email", "groups"],
        redirectURI: "https://tas.example.com/api/auth/oauth2/callback/oidc",
      },
    ]);
  });

  it("maps Microsoft preferred_username into a verified email", async () => {
    clearProviderEnv();
    setEnv({
      MICROSOFT_CLIENT_ID: "microsoft-id",
      MICROSOFT_CLIENT_SECRET: "microsoft-secret",
    });
    const microsoft = microsoftProviderConfig();
    expect(microsoft).toMatchObject({ tenantId: "common" });

    await expect(
      microsoft?.getUserInfo?.({
        idToken: unsignedJwt({
          sub: "entra-user-1",
          preferred_username: "invited@example.com",
          name: "Invited User",
        }),
      }),
    ).resolves.toMatchObject({
      user: {
        email: "invited@example.com",
        emailVerified: true,
        name: "Invited User",
        image: undefined,
      },
      data: {
        oid: "entra-user-1",
        iss: "local:oauth:microsoft",
      },
    });
  });
});
