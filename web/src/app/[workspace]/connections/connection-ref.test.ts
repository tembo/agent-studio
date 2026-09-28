import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listSecretConnections: vi.fn(),
  listNativeConnectionsForUser: vi.fn(),
  listConnectionsForUser: vi.fn(),
}));
vi.mock("@/lib/secret-connections", () => ({ listSecretConnections: mocks.listSecretConnections }));
vi.mock("@/lib/connections", () => ({ listNativeConnectionsForUser: mocks.listNativeConnectionsForUser }));
vi.mock("@/lib/composio-connections", () => ({ listConnectionsForUser: mocks.listConnectionsForUser }));

import { listAllConnections, loadConnection } from "./connection-ref";

describe("LinkedIn connection visibility", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.listNativeConnectionsForUser.mockResolvedValue([]);
    mocks.listConnectionsForUser.mockResolvedValue([]);
    mocks.listSecretConnections.mockImplementation(async (_workspaceId, userId) => [
      { id: "legacy", slug: "linkedin_li_at", scope: "workspace" },
      ...(userId === "owner" ? [
        { id: "own", slug: "linkedin_li_at", scope: "personal" },
        { id: "session", slug: "linkedin_jsessionid", scope: "personal" },
        { id: "agent", slug: "linkedin_user_agent", scope: "personal" },
      ] : []),
    ]);
  });

  it("lists the owner's complete personal connection", async () => {
    expect(await listAllConnections("workspace-1", "owner", "owner")).toEqual([
      expect.objectContaining({ kind: "manual-cred", title: "LinkedIn", typeLabel: "Personal credential", statusLabel: "connected" }),
    ]);
  });

  it.each(["other-user", undefined])("hides the connection from %s, including admin view-as", async (userId) => {
    expect(await listAllConnections("workspace-1", "owner", userId)).toEqual([]);
    expect(await loadConnection("workspace-1", "owner", { kind: "manual-cred", key: "linkedin" }, userId)).toBeNull();
  });

  it("loads only personal field previews for the owner", async () => {
    const result = await loadConnection("workspace-1", "owner", { kind: "manual-cred", key: "linkedin" }, "owner");
    expect(result).toMatchObject({ kind: "manual-cred", fields: [
      { preview: { id: "own" } }, { preview: { id: "session" } }, { preview: { id: "agent" } },
    ] });
    expect(mocks.listSecretConnections).toHaveBeenCalledWith("workspace-1", "owner");
  });
});
