import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirror of auth-server.test.ts but for the API-key path. We mock the three
// dependency boundaries (key lookup + match, workspace lookup, role lookup) so
// the test isolates the policy decision from Postgres. Subject-under-test is
// server-only and pulls these in at module-evaluation time, so the mocks must
// register before the import is evaluated (vi.mock is hoisted).
vi.mock("@/lib/api-keys-db", () => ({
  getApiKeyByToken: vi.fn(),
  apiKeyTokenMatches: vi.fn(),
  touchApiKeyLastUsed: vi.fn(),
}));
vi.mock("@/lib/workspace", () => ({
  getWorkspaceById: vi.fn(),
  getWorkspaceRole: vi.fn(),
}));

import { authorizeApiRequest, authorizeOAuthMcpClaims } from "./api-auth";
import {
  apiKeyTokenMatches,
  getApiKeyByToken,
  touchApiKeyLastUsed,
} from "@/lib/api-keys-db";
import { getWorkspaceById, getWorkspaceRole } from "@/lib/workspace";

const mockGetKey = vi.mocked(getApiKeyByToken);
const mockMatch = vi.mocked(apiKeyTokenMatches);
const mockTouch = vi.mocked(touchApiKeyLastUsed);
const mockGetWs = vi.mocked(getWorkspaceById);
const mockGetRole = vi.mocked(getWorkspaceRole);

const fakeWorkspace = {
  id: "ws-1",
  slug: "demo",
  name: "Demo",
  createdBy: "u-1",
  createdAt: new Date(),
  updatedAt: new Date(),
  faviconKind: "default-tembo" as const,
  commitMode: "pull_request" as const,
};

const fakeKeyRow = {
  id: "key-1",
  workspaceId: "ws-1",
  userId: "u-1",
  name: "Claude Code",
  tokenLast4: "abcd",
  enabled: true,
  lastUsedAt: null,
  createdBy: "u-1",
  createdAt: new Date(),
  tokenCiphertext: Buffer.from("x"),
};

function req(auth?: string): Request {
  return new Request("http://localhost/api/v1/agents", {
    headers: auth ? { authorization: auth } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetKey.mockResolvedValue(fakeKeyRow);
  mockMatch.mockReturnValue(true);
  mockGetWs.mockResolvedValue(fakeWorkspace);
  mockGetRole.mockResolvedValue("operator");
});

describe("authorizeApiRequest — reject", () => {
  it("no Authorization header → 401, no key lookup", async () => {
    const r = await authorizeApiRequest(req());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
    expect(mockGetKey).not.toHaveBeenCalled();
  });

  it("non-tas bearer → 401, no key lookup (don't probe other token spaces)", async () => {
    const r = await authorizeApiRequest(req("Bearer whk_something"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
    expect(mockGetKey).not.toHaveBeenCalled();
  });

  it("unknown token → 401", async () => {
    mockGetKey.mockResolvedValue(null);
    const r = await authorizeApiRequest(req("Bearer tas_unknown"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it("disabled key → 401 (and never constant-time compares)", async () => {
    mockGetKey.mockResolvedValue({ ...fakeKeyRow, enabled: false });
    const r = await authorizeApiRequest(req("Bearer tas_disabled"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it("token hash collision but ciphertext mismatch → 401", async () => {
    mockMatch.mockReturnValue(false);
    const r = await authorizeApiRequest(req("Bearer tas_wrong"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it("viewer user denied an operator-only action → 403", async () => {
    mockGetRole.mockResolvedValue("viewer");
    const r = await authorizeApiRequest(req("Bearer tas_ok"), "operator");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it("non-member user → 403", async () => {
    mockGetRole.mockResolvedValue(null);
    const r = await authorizeApiRequest(req("Bearer tas_ok"), "viewer");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });
});

describe("authorizeApiRequest — admit", () => {
  it("operator key admitted to an operator action, returns resolved ctx", async () => {
    const r = await authorizeApiRequest(req("Bearer tas_ok"), "operator");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.userId).toBe("u-1");
      expect(r.role).toBe("operator");
      expect(r.workspace.id).toBe("ws-1");
      expect(r.apiKeyId).toBe("key-1");
    }
    expect(mockTouch).toHaveBeenCalledWith("key-1");
  });

  it("default minRole is viewer (omitted second arg)", async () => {
    mockGetRole.mockResolvedValue("viewer");
    const r = await authorizeApiRequest(req("Bearer tas_ok"));
    expect(r.ok).toBe(true);
  });
});

describe("authorizeOAuthMcpClaims", () => {
  it("binds valid OAuth claims to the selected workspace and live role", async () => {
    const r = await authorizeOAuthMcpClaims({
      sub: "u-1",
      azp: "claude-client",
      scope: "mcp:read mcp:write offline_access",
      tas_workspace_id: "ws-1",
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.workspace.id).toBe("ws-1");
      expect(r.userId).toBe("u-1");
      expect(r.apiKeyId).toBe("oauth:claude-client");
      expect(r.oauthScopes).toEqual([
        "mcp:read",
        "mcp:write",
        "offline_access",
      ]);
    }
  });

  it("rejects tokens without a workspace binding or read scope", async () => {
    const noWorkspace = await authorizeOAuthMcpClaims({
      sub: "u-1",
      azp: "claude-client",
      scope: "mcp:read",
    });
    const noRead = await authorizeOAuthMcpClaims({
      sub: "u-1",
      azp: "claude-client",
      scope: "mcp:write",
      tas_workspace_id: "ws-1",
    });
    expect(noWorkspace).toMatchObject({ ok: false, status: 401 });
    expect(noRead).toMatchObject({ ok: false, status: 401 });
    expect(mockGetWs).not.toHaveBeenCalled();
  });

  it("rejects a token after the user loses workspace membership", async () => {
    mockGetRole.mockResolvedValue(null);
    const r = await authorizeOAuthMcpClaims({
      sub: "u-1",
      azp: "claude-client",
      scope: "mcp:read",
      tas_workspace_id: "ws-1",
    });
    expect(r).toMatchObject({ ok: false, status: 403 });
  });
});
