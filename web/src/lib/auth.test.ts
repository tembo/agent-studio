import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockAPIError extends Error {
    status: string;

    constructor(status: string, options: { message: string }) {
      super(options.message);
      this.status = status;
    }
  }

  return {
    betterAuth: vi.fn((config: unknown) => ({ config })),
    genericOAuth: vi.fn((options: unknown) => ({
      id: "genericOAuth",
      options,
    })),
    jwt: vi.fn((options: unknown) => ({ id: "jwt", options })),
    oauthProvider: vi.fn((options: unknown) => ({
      id: "oauthProvider",
      options,
    })),
    isInstanceAdmin: vi.fn(),
    getSignupPolicy: vi.fn(),
    getMcpOAuthWorkspaceSelection: vi.fn(),
    hasPendingInvite: vi.fn(),
    resolvePendingInvitesForUser: vi.fn(),
    listWorkspacesForUser: vi.fn(),
    writeAuditEvent: vi.fn(),
    MockAPIError,
  };
});

vi.mock("better-auth", () => ({
  betterAuth: mocks.betterAuth,
}));

vi.mock("better-auth/api", () => ({
  APIError: mocks.MockAPIError,
}));

vi.mock("better-auth/plugins", () => ({
  genericOAuth: mocks.genericOAuth,
  jwt: mocks.jwt,
}));

vi.mock("@better-auth/oauth-provider", () => ({
  oauthProvider: mocks.oauthProvider,
}));

vi.mock("pg", () => ({
  Pool: vi.fn(function Pool() {
    return {};
  }),
}));

vi.mock("@/lib/auth-secret", () => ({
  resolveAuthSecret: () => "test-secret-with-enough-entropy",
}));

vi.mock("@/lib/audit-db", () => ({
  writeAuditEvent: mocks.writeAuditEvent,
}));

vi.mock("@/lib/config", () => ({
  getPublicOrigin: () => "https://tas.example.com",
}));

vi.mock("@/lib/instance-admins", () => ({
  isInstanceAdmin: mocks.isInstanceAdmin,
}));

vi.mock("@/lib/instance-settings", () => ({
  getSignupPolicy: mocks.getSignupPolicy,
}));

vi.mock("@/lib/mcp-oauth-selection", () => ({
  getMcpOAuthWorkspaceSelection: mocks.getMcpOAuthWorkspaceSelection,
}));

vi.mock("@/lib/invitations", () => ({
  hasPendingInvite: mocks.hasPendingInvite,
  resolvePendingInvitesForUser: mocks.resolvePendingInvitesForUser,
}));

vi.mock("@/lib/workspace", () => ({
  listWorkspacesForUser: mocks.listWorkspacesForUser,
}));

type AuthConfig = {
  databaseHooks: {
    user: {
      create: {
        before: (user: TestUser) => Promise<{ data: TestUser }>;
        after: (user: TestUser) => Promise<void>;
      };
    };
  };
  emailAndPassword: { enabled: boolean };
  plugins?: unknown[];
};

type TestUser = {
  id: string;
  email: string;
  name?: string;
  emailVerified?: boolean;
};

const ORIGINAL_ENV = process.env;

function resetProviderEnv() {
  process.env = {
    ...ORIGINAL_ENV,
    BETTER_AUTH_SECRET: "test-secret-with-enough-entropy",
    DATABASE_URL: "postgres://user:pass@localhost:5432/tas_test",
  };
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

async function loadAuthConfig(): Promise<AuthConfig> {
  await import("./auth");
  expect(mocks.betterAuth).toHaveBeenCalledTimes(1);
  return mocks.betterAuth.mock.calls[0][0] as AuthConfig;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  resetProviderEnv();
  mocks.hasPendingInvite.mockResolvedValue(false);
  mocks.resolvePendingInvitesForUser.mockResolvedValue(0);
  mocks.listWorkspacesForUser.mockResolvedValue([]);
  mocks.getMcpOAuthWorkspaceSelection.mockResolvedValue("ws-1");
  mocks.getSignupPolicy.mockResolvedValue({
    policy: "invite_only",
    allowedDomains: [],
  });
});

describe("better-auth account creation hooks", () => {
  it("rejects new OAuth users who are neither instance admins nor invited", async () => {
    mocks.isInstanceAdmin.mockResolvedValue(false);
    mocks.hasPendingInvite.mockResolvedValue(false);
    const config = await loadAuthConfig();

    await expect(
      config.databaseHooks.user.create.before({
        id: "user-1",
        email: "outsider@example.com",
        name: "Outsider",
      }),
    ).rejects.toThrow(
      "This instance is invite-only. Ask an admin to invite your email.",
    );
  });

  it("allows an instance admin account without requiring an invite", async () => {
    mocks.isInstanceAdmin.mockResolvedValue(true);
    const config = await loadAuthConfig();
    const user = {
      id: "user-admin",
      email: "admin@example.com",
      name: "Admin User",
    };

    await expect(config.databaseHooks.user.create.before(user)).resolves.toEqual(
      { data: user },
    );
    expect(mocks.hasPendingInvite).not.toHaveBeenCalled();
  });

  it("allows invited OAuth users and resolves their workspaces after create", async () => {
    mocks.isInstanceAdmin.mockResolvedValue(false);
    mocks.hasPendingInvite.mockResolvedValue(true);
    const config = await loadAuthConfig();
    const user = {
      id: "user-invited",
      email: "invited@example.com",
      name: "Invited User",
    };

    await expect(config.databaseHooks.user.create.before(user)).resolves.toEqual(
      { data: user },
    );
    await config.databaseHooks.user.create.after(user);

    expect(mocks.hasPendingInvite).toHaveBeenCalledWith("invited@example.com");
    expect(mocks.resolvePendingInvitesForUser).toHaveBeenCalledWith(
      "user-invited",
      "invited@example.com",
    );
  });

  it("allows a verified email on the domain allowlist to self-join", async () => {
    mocks.isInstanceAdmin.mockResolvedValue(false);
    mocks.getSignupPolicy.mockResolvedValue({
      policy: "domain_allowlist",
      allowedDomains: ["acme.com"],
    });
    const config = await loadAuthConfig();
    const user = {
      id: "user-domain",
      email: "ada@acme.com",
      name: "Ada",
      emailVerified: true,
    };

    await expect(config.databaseHooks.user.create.before(user)).resolves.toEqual(
      { data: user },
    );
  });

  it("rejects an unverified email even when the domain matches", async () => {
    mocks.isInstanceAdmin.mockResolvedValue(false);
    mocks.getSignupPolicy.mockResolvedValue({
      policy: "domain_allowlist",
      allowedDomains: ["acme.com"],
    });
    const config = await loadAuthConfig();

    await expect(
      config.databaseHooks.user.create.before({
        id: "user-unverified",
        email: "ada@acme.com",
        emailVerified: false,
      }),
    ).rejects.toThrow(/allowed email domains/);
  });

  it("allows anyone with an email when the policy is open", async () => {
    mocks.isInstanceAdmin.mockResolvedValue(false);
    mocks.getSignupPolicy.mockResolvedValue({
      policy: "open",
      allowedDomains: [],
    });
    const config = await loadAuthConfig();
    const user = {
      id: "user-open",
      email: "stranger@example.com",
      emailVerified: false,
    };

    await expect(config.databaseHooks.user.create.before(user)).resolves.toEqual(
      { data: user },
    );
  });
});

describe("better-auth provider wiring", () => {
  it("enables mocked Microsoft and OIDC providers without email/password", async () => {
    process.env.MICROSOFT_CLIENT_ID = "microsoft-id";
    process.env.MICROSOFT_CLIENT_SECRET = "microsoft-secret";
    process.env.OIDC_CLIENT_ID = "oidc-id";
    process.env.OIDC_CLIENT_SECRET = "oidc-secret";
    process.env.OIDC_DISCOVERY_URL =
      "https://idp.example.com/.well-known/openid-configuration";
    const config = await loadAuthConfig();

    expect(config.emailAndPassword).toEqual({ enabled: false });
    expect(mocks.genericOAuth).toHaveBeenCalledWith({
      config: expect.arrayContaining([
        expect.objectContaining({ providerId: "microsoft" }),
        expect.objectContaining({ providerId: "oidc" }),
      ]),
    });
    expect(config.plugins).toHaveLength(3);
  });
});

describe("MCP OAuth provider wiring", () => {
  it("requires workspace selection and binds access-token claims to it", async () => {
    await loadAuthConfig();
    const options = mocks.oauthProvider.mock.calls[0][0] as {
      scopes: string[];
      resources: string[];
      enforcePerClientResources: boolean;
      clientRegistrationDefaultResources: string[];
      clientRegistrationAllowedResources: string[];
      allowDynamicClientRegistration: boolean;
      allowUnauthenticatedClientRegistration: boolean;
      postLogin: {
        shouldRedirect: (input: { scopes: string[] }) => Promise<boolean>;
        consentReferenceId: (input: {
          user: { id: string };
          session: { id: string };
          scopes: string[];
        }) => Promise<string | undefined>;
      };
      customAccessTokenClaims: (input: {
        user?: { id: string };
        referenceId?: string;
      }) => Record<string, unknown>;
    };

    expect(options.resources).toEqual(["https://tas.example.com/mcp"]);
    expect(options.enforcePerClientResources).toBe(false);
    expect(options.clientRegistrationDefaultResources).toEqual([
      "https://tas.example.com/mcp",
    ]);
    expect(options.clientRegistrationAllowedResources).toEqual([
      "https://tas.example.com/mcp",
    ]);
    expect(options.scopes).toEqual([
      "mcp:read",
      "mcp:write",
      "offline_access",
    ]);
    expect(options.allowDynamicClientRegistration).toBe(true);
    expect(options.allowUnauthenticatedClientRegistration).toBe(true);
    await expect(
      options.postLogin.shouldRedirect({ scopes: ["mcp:read"] }),
    ).resolves.toBe(false);
    await expect(
      options.postLogin.consentReferenceId({
        user: { id: "u-1" },
        session: { id: "session-1" },
        scopes: ["mcp:read"],
      }),
    ).resolves.toBe("ws-1");
    expect(mocks.getMcpOAuthWorkspaceSelection).toHaveBeenCalledWith(
      "session-1",
      "u-1",
    );
    expect(
      options.customAccessTokenClaims({
        user: { id: "u-1" },
        referenceId: "ws-1",
      }),
    ).toEqual({ tas_workspace_id: "ws-1" });
  });

  it("fails token creation when an MCP consent has no workspace binding", async () => {
    await loadAuthConfig();
    const options = mocks.oauthProvider.mock.calls[0][0] as {
      customAccessTokenClaims: (input: {
        user?: { id: string };
        referenceId?: string;
      }) => Record<string, unknown>;
    };

    expect(() =>
      options.customAccessTokenClaims({ user: { id: "u-1" } }),
    ).toThrow("must be bound to a TAS workspace");
  });
});
