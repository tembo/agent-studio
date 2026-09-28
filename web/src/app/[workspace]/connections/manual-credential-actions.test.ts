import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeWorkspace: vi.fn(),
  listSecretConnections: vi.fn(),
  upsertSecretConnection: vi.fn(),
  deleteSecretConnection: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, notFound: vi.fn() }));
vi.mock("@/lib/auth-server", () => ({ authorizeWorkspace: mocks.authorizeWorkspace, DENIED_MESSAGE: "Denied." }));
vi.mock("@/lib/secret-connections", () => ({
  listSecretConnections: mocks.listSecretConnections,
  upsertSecretConnection: mocks.upsertSecretConnection,
  deleteSecretConnection: mocks.deleteSecretConnection,
}));

import { removeManualCredentialAction, setManualCredentialAction } from "./manual-credential-actions";

function form(withValues = true) {
  const data = new FormData();
  data.set("workspace", "acme");
  data.set("provider", "linkedin");
  data.set("userId", "another-user");
  data.set("scope", "workspace");
  if (withValues) {
    for (const slug of ["linkedin_li_at", "linkedin_jsessionid", "linkedin_user_agent"]) data.set(slug, `own-${slug}`);
  }
  return data;
}

describe("personal LinkedIn setup", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.authorizeWorkspace.mockResolvedValue({ ok: true, workspace: { id: "workspace-1" }, userId: "user-1", role: "operator" });
    mocks.listSecretConnections.mockResolvedValue([]);
    mocks.upsertSecretConnection.mockResolvedValue({ ok: true, rotated: false, id: "secret-1" });
  });

  it.each(["operator", "workspace_admin"])("binds %s credentials to the authenticated user", async (role) => {
    mocks.authorizeWorkspace.mockResolvedValue({ ok: true, workspace: { id: "workspace-1" }, userId: "user-1", role });
    await setManualCredentialAction({}, form());
    expect(mocks.authorizeWorkspace).toHaveBeenCalledWith("acme", "operator");
    expect(mocks.listSecretConnections).toHaveBeenCalledWith("workspace-1", "user-1");
    expect(mocks.upsertSecretConnection).toHaveBeenCalledTimes(3);
    for (const [args] of mocks.upsertSecretConnection.mock.calls) {
      expect(args).toMatchObject({ ownerUserId: "user-1", actorUserId: "user-1" });
    }
  });

  it("does not accept legacy shared fields as an existing personal connection", async () => {
    mocks.listSecretConnections.mockResolvedValue([
      { slug: "linkedin_li_at", scope: "workspace" },
      { slug: "linkedin_jsessionid", scope: "workspace" },
      { slug: "linkedin_user_agent", scope: "workspace" },
    ]);
    expect(await setManualCredentialAction({}, form(false))).toEqual({ error: "li_at cookie is required." });
    expect(mocks.upsertSecretConnection).not.toHaveBeenCalled();
  });

  it("allows blank fields only when the owner already has personal values", async () => {
    mocks.listSecretConnections.mockResolvedValue([
      { slug: "linkedin_li_at", scope: "personal" },
      { slug: "linkedin_jsessionid", scope: "personal" },
      { slug: "linkedin_user_agent", scope: "personal" },
    ]);
    await setManualCredentialAction({}, form(false));
    expect(mocks.upsertSecretConnection).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith("/acme/connections/manual-cred~linkedin");
  });

  it("disconnects only the authenticated user's personal LinkedIn fields", async () => {
    mocks.listSecretConnections.mockResolvedValue([
      { id: "own", slug: "linkedin_li_at", scope: "personal" },
      { id: "legacy", slug: "linkedin_li_at", scope: "workspace" },
      { id: "other-service", slug: "clay", scope: "personal" },
    ]);
    await removeManualCredentialAction({}, form());
    expect(mocks.deleteSecretConnection).toHaveBeenCalledExactlyOnceWith("workspace-1", "own", "user-1");
  });

  it.each([setManualCredentialAction, removeManualCredentialAction])("rejects unauthorized mutations", async (action) => {
    mocks.authorizeWorkspace.mockResolvedValue({ ok: false, reason: "denied" });
    expect(await action({}, form())).toEqual({ error: "Denied." });
    expect(mocks.listSecretConnections).not.toHaveBeenCalled();
    expect(mocks.upsertSecretConnection).not.toHaveBeenCalled();
    expect(mocks.deleteSecretConnection).not.toHaveBeenCalled();
  });
});
