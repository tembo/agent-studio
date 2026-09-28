import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  encryptSecret: vi.fn(() => Buffer.from("ciphertext")),
  decryptSecret: vi.fn(),
  last4: vi.fn(() => "last"),
}));

vi.mock("@/lib/db", () => ({ db: { query: mocks.query } }));
vi.mock("@/lib/crypto", () => ({
  encryptSecret: mocks.encryptSecret,
  decryptSecret: mocks.decryptSecret,
  last4: mocks.last4,
}));

import {
  getSecretConnectionById,
  getPersonalSecretConnectionValue,
  listSecretConnections,
  updateSecretConnection,
  upsertSecretConnection,
} from "./secret-connections";

describe("secret connection scoping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists only shared and the acting user's personal metadata", async () => {
    mocks.query.mockResolvedValue({ rows: [] });

    await listSecretConnections("workspace-1", "user-1");

    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("user_id IS NULL OR user_id = $2"),
      ["workspace-1", "user-1", ["linkedin_li_at", "linkedin_jsessionid", "linkedin_user_agent"]],
    );
  });

  it("does not expose personal metadata when no acting user is supplied", async () => {
    mocks.query.mockResolvedValue({ rows: [] });

    await getSecretConnectionById("workspace-1", "secret-1");

    expect(mocks.query).toHaveBeenCalledWith(expect.any(String), [
      "workspace-1",
      "secret-1",
      null,
      ["linkedin_li_at", "linkedin_jsessionid", "linkedin_user_agent"],
    ]);
  });

  it("binds personal ciphertext to the owner and targets personal uniqueness", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "secret-1" }] });

    await expect(
      upsertSecretConnection({
        workspaceId: "workspace-1",
        slug: "clay",
        value: "personal-value",
        description: null,
        actorUserId: "user-1",
        ownerUserId: "user-1",
      }),
    ).resolves.toEqual({ ok: true, rotated: false, id: "secret-1" });

    expect(mocks.encryptSecret).toHaveBeenCalledWith(
      "personal-value",
      "secret_connection\u{1f}workspace-1\u{1f}clay\u{1f}user-1",
    );
    expect(mocks.query.mock.calls[1][0]).toContain(
      "(workspace_id, user_id, slug) WHERE user_id IS NOT NULL",
    );
  });

  it("keeps workspace-shared AAD byte-identical", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "secret-2" }] });

    await upsertSecretConnection({
      workspaceId: "workspace-1",
      slug: "clay",
      value: "shared-value",
      description: null,
      actorUserId: "admin-1",
      ownerUserId: null,
    });

    expect(mocks.encryptSecret).toHaveBeenCalledWith(
      "shared-value",
      "secret_connection\u{1f}workspace-1\u{1f}clay",
    );
  });

  it.each(["linkedin_li_at", "linkedin_jsessionid", "linkedin_user_agent"])("rejects workspace-shared %s", async (slug) => {
    await expect(upsertSecretConnection({
      workspaceId: "workspace-1", slug, value: "secret", description: null,
      actorUserId: "admin", ownerUserId: null,
    })).resolves.toEqual({ ok: false, error: "personal-only" });
    await expect(updateSecretConnection({
      workspaceId: "workspace-1", id: "legacy", slug, value: "secret",
      description: null, ownerUserId: null,
    })).resolves.toBe(false);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("loads personal plaintext with the owner's AAD and no shared fallback", async () => {
    const ciphertext = Buffer.from("encrypted");
    mocks.query.mockResolvedValue({ rows: [{ ciphertext }] });
    mocks.decryptSecret.mockReturnValue("personal-session");
    await expect(getPersonalSecretConnectionValue("workspace-1", "linkedin_li_at", "user-1")).resolves.toBe("personal-session");
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("user_id = $3"), ["workspace-1", "linkedin_li_at", "user-1"]);
    expect(mocks.decryptSecret).toHaveBeenCalledWith(ciphertext, "secret_connection\u001fworkspace-1\u001flinkedin_li_at\u001fuser-1");
  });
});
