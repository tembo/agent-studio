import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), search: vi.fn() }));
vi.mock("@/lib/auth-server", () => ({ authorizeWorkspace: mocks.authorize, DENIED_MESSAGE: "Denied" }));
vi.mock("@/lib/workspace-member-search", () => ({ searchWorkspaceMembers: mocks.search }));
import { searchMembersAction } from "./member-search-actions";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue({ ok: true, workspace: { id: "authorized-workspace" } });
  mocks.search.mockResolvedValue({ members: [], hasMore: false });
});
describe("member selector authorization", () => {
  it.each(["denied", "no-session", "no-workspace"])("rejects %s before searching", async (reason) => {
    mocks.authorize.mockResolvedValue({ ok: false, reason });
    expect(await searchMembersAction("acme", "alice")).toMatchObject({ error: "Denied", members: [] });
    expect(mocks.search).not.toHaveBeenCalled();
  });
  it("uses the authorized workspace ID and operator boundary", async () => {
    await searchMembersAction("acme", "alice");
    expect(mocks.authorize).toHaveBeenCalledWith("acme", "operator");
    expect(mocks.search).toHaveBeenCalledWith("authorized-workspace", "alice");
  });
  it("rejects oversized input without querying", async () => {
    expect(await searchMembersAction("acme", "x".repeat(201))).toHaveProperty("error");
    expect(mocks.search).not.toHaveBeenCalled();
  });
});
