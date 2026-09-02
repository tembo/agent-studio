import { afterEach, describe, expect, it, vi } from "vitest";

import { inviteResolutionAllowed } from "./invitations";

// invitations.ts pulls in audit-db/db (pg) transitively; neither is touched
// by the pure gate under test, but mock them so importing the module never
// opens a connection pool.
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/audit-db", () => ({ writeAuditEvent: vi.fn() }));

const ORIGINAL_ENV = process.env;

function setOAuthConfigured(configured: boolean) {
  process.env = { ...ORIGINAL_ENV };
  for (const key of [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "MICROSOFT_CLIENT_ID",
    "MICROSOFT_CLIENT_SECRET",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "OIDC_DISCOVERY_URL",
  ]) {
    delete process.env[key];
  }
  if (configured) {
    process.env.GOOGLE_CLIENT_ID = "google-id";
    process.env.GOOGLE_CLIENT_SECRET = "google-secret";
  }
}

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe("inviteResolutionAllowed", () => {
  it("requires a verified email when an OAuth IdP is configured", () => {
    setOAuthConfigured(true);
    expect(inviteResolutionAllowed(true)).toBe(true);
    expect(inviteResolutionAllowed(false)).toBe(false);
  });

  it("resolves invites for unverified emails on an email/password instance", () => {
    // No OAuth provider → email/password sign-in, where emailVerified is
    // always false and the sign-up gate is the authorization.
    setOAuthConfigured(false);
    expect(inviteResolutionAllowed(false)).toBe(true);
    expect(inviteResolutionAllowed(true)).toBe(true);
  });
});
