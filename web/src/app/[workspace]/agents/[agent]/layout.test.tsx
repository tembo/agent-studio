import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ member: vi.fn(), role: vi.fn() }));
vi.mock("./agent-page-context", () => ({ loadAgentContext: async () => ({
  session: { user: { id: "actor", name: "Actor", email: "actor@example.com" } },
  workspace: { id: "acme", slug: "acme" }, repo: null,
  agent: { ok: false, path: "agents/broken.yaml", filename: "broken.yaml", error: "invalid" },
  raw: "", canonicalName: "broken", locked: false,
}) }));
vi.mock("@/lib/workspace", () => ({
  getWorkspaceRole: mocks.role,
  listWorkspaceMembers: () => { throw new Error("Detail header must not load the member directory"); },
}));
vi.mock("@/lib/tembo-credentials", () => ({ isTemboConfiguredForUser: async () => false }));
vi.mock("@/lib/agent-versions", () => ({ getStableVersion: async () => null, getAgentOwner: async () => ({ ownerUserId: "owner" }) }));
vi.mock("@/lib/workspace-member-search", () => ({ getWorkspaceMemberChoice: mocks.member }));
vi.mock("./run-now-button", () => ({ RunNowButton: () => null }));
vi.mock("./fork-agent-button", () => ({ ForkAgentButton: () => null }));
vi.mock("./draft-changes-banner", () => ({ DraftChangesBanner: () => null }));
import AgentLayout from "./layout";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.member.mockResolvedValue({ id: "owner", label: "Owner (owner@example.com)" });
});
it.each(["viewer", "operator", "workspace_admin"])("resolves only the displayed owner for %s", async (role) => {
  mocks.role.mockResolvedValue(role);
  await AgentLayout({ params: Promise.resolve({ workspace: "acme", agent: "broken" }), children: null });
  expect(mocks.member).toHaveBeenCalledExactlyOnceWith("acme", "owner");
});
