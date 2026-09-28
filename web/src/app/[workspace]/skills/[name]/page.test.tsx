import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  getWorkspaceBySlug: vi.fn(),
  getWorkspaceRole: vi.fn(),
  listWorkspaceMembers: vi.fn(),
  listSkillOwners: vi.fn(),
  getSkillInstallSource: vi.fn(),
  readInstalledSkill: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));
vi.mock("@/lib/session", () => ({ getServerSession: mocks.getServerSession }));
vi.mock("@/lib/workspace", () => ({
  getWorkspaceBySlug: mocks.getWorkspaceBySlug,
  getWorkspaceRole: mocks.getWorkspaceRole,
  listWorkspaceMembers: mocks.listWorkspaceMembers,
}));
vi.mock("@/lib/skill-owners", () => ({ listSkillOwners: mocks.listSkillOwners }));
vi.mock("@/lib/workspace-skills", () => ({
  getSkillInstallSource: mocks.getSkillInstallSource,
  readInstalledSkill: mocks.readInstalledSkill,
}));
vi.mock("../skills-forms", () => ({ RemoveSkillForm: () => null }));
vi.mock("../owner-actions", () => ({ changeSkillOwnerAction: vi.fn() }));

import SkillDetailPage from "./page";

async function markup() {
  return renderToStaticMarkup(await SkillDetailPage({
    params: Promise.resolve({ workspace: "acme", name: "writing" }),
  }));
}

describe("skill owner controls", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getServerSession.mockResolvedValue({ user: { id: "user-1" } });
    mocks.getWorkspaceBySlug.mockResolvedValue({ id: "workspace-1", slug: "acme" });
    mocks.getWorkspaceRole.mockResolvedValue("operator");
    mocks.listSkillOwners.mockResolvedValue(new Map([
      ["writing", { userId: "user-1", name: "Alex" }],
    ]));
    mocks.listWorkspaceMembers.mockResolvedValue([
      { userId: "user-1", name: "Alex", email: "alex@example.test" },
      { userId: "user-2", name: "Blair", email: "blair@example.test" },
    ]);
    mocks.readInstalledSkill.mockResolvedValue({
      name: "writing", description: null, path: "skills/writing", skillMd: "", fileCount: 1,
    });
  });

  it.each(["operator", "viewer"])("offers only other members to a %s owner", async (role) => {
    mocks.getWorkspaceRole.mockResolvedValue(role);
    const html = await markup();
    expect(html).toContain("Change owner");
    expect(html).toContain('value="user-2"');
    expect(html).not.toContain('value="user-1"');
  });

  it("lets admins assign an unowned skill, including to themselves", async () => {
    mocks.getWorkspaceRole.mockResolvedValue("workspace_admin");
    mocks.listSkillOwners.mockResolvedValue(new Map());
    const html = await markup();
    expect(html).toContain("Unassigned");
    expect(html).toContain('value="user-1"');
    expect(html).toContain('value="user-2"');
  });

  it("hides reassignment from other members", async () => {
    mocks.listSkillOwners.mockResolvedValue(new Map([
      ["writing", { userId: "user-2", name: "Blair" }],
    ]));
    expect(await markup()).not.toContain("Change owner");
    expect(mocks.listWorkspaceMembers).not.toHaveBeenCalled();
  });

  it("disables transfer when no other members are available", async () => {
    mocks.listWorkspaceMembers.mockResolvedValue([
      { userId: "user-1", name: "Alex", email: "alex@example.test" },
    ]);
    const html = await markup();
    expect(html).toContain("No other workspace members are available.");
    expect(html).toMatch(/<select[^>]*disabled/);
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  it("does not render details for a nonmember", async () => {
    mocks.getWorkspaceRole.mockResolvedValue(null);
    await expect(markup()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
