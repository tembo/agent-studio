import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  getWorkspaceBySlug: vi.fn(),
  getWorkspaceRole: vi.fn(),
  listSkillOwners: vi.fn(),
  changeSkillOwner: vi.fn(),
  readInstalledSkill: vi.fn(),
  writeAuditEvent: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));
vi.mock("@/lib/session", () => ({ getServerSession: mocks.getServerSession }));
vi.mock("@/lib/workspace", () => ({
  getWorkspaceBySlug: mocks.getWorkspaceBySlug,
  getWorkspaceRole: mocks.getWorkspaceRole,
}));
vi.mock("@/lib/skill-owners", () => ({
  listSkillOwners: mocks.listSkillOwners,
  changeSkillOwner: mocks.changeSkillOwner,
}));
vi.mock("@/lib/workspace-skills", () => ({ readInstalledSkill: mocks.readInstalledSkill }));
vi.mock("@/lib/audit-db", () => ({ writeAuditEvent: mocks.writeAuditEvent }));

import { DENIED_MESSAGE } from "@/lib/auth-server";
import { changeSkillOwnerAction } from "./owner-actions";

function transferForm(ownerUserId = "user-2") {
  const data = new FormData();
  data.set("workspace", "acme");
  data.set("name", "writing");
  data.set("ownerUserId", ownerUserId);
  return data;
}

describe("skill ownership transfer", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getServerSession.mockResolvedValue({ user: { id: "user-1" } });
    mocks.getWorkspaceBySlug.mockResolvedValue({ id: "workspace-1" });
    mocks.getWorkspaceRole.mockResolvedValue("operator");
    mocks.listSkillOwners.mockResolvedValue(new Map([
      ["writing", { userId: "user-1", name: "Owner" }],
    ]));
    mocks.readInstalledSkill.mockResolvedValue({ name: "writing" });
    mocks.changeSkillOwner.mockResolvedValue(true);
  });

  it.each(["operator", "viewer"])("allows a %s owner to transfer to another member", async (role) => {
    mocks.getWorkspaceRole.mockResolvedValue(role);
    await expect(changeSkillOwnerAction({}, transferForm())).resolves.toEqual({ message: "Skill owner updated." });
    expect(mocks.changeSkillOwner).toHaveBeenCalledWith({
      workspaceId: "workspace-1", skillName: "writing", actorUserId: "user-1",
      isAdmin: false, ownerUserId: "user-2",
    });
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1", actorUserId: "user-1", kind: "skill.owner_changed",
      targetId: "writing", payload: { ownerUserId: "user-2" },
    }));
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/acme/skills");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/acme/skills/writing");
  });

  it.each(["user-1", "user-2"])("allows an admin to assign %s without being the owner", async (ownerUserId) => {
    mocks.getWorkspaceRole.mockResolvedValue("workspace_admin");
    mocks.listSkillOwners.mockResolvedValue(new Map());
    await expect(changeSkillOwnerAction({}, transferForm(ownerUserId))).resolves.toEqual({ message: "Skill owner updated." });
    expect(mocks.changeSkillOwner).toHaveBeenCalledWith(expect.objectContaining({ isAdmin: true, ownerUserId }));
  });

  it("rejects self-assignment by a non-admin owner", async () => {
    await expect(changeSkillOwnerAction({}, transferForm("user-1"))).resolves.toEqual({
      error: "Choose another workspace member to transfer ownership to.",
    });
    expect(mocks.changeSkillOwner).not.toHaveBeenCalled();
  });

  it.each(["operator", "viewer"])("rejects a %s who does not own the skill", async (role) => {
    mocks.getWorkspaceRole.mockResolvedValue(role);
    mocks.listSkillOwners.mockResolvedValue(new Map([
      ["writing", { userId: "user-3", name: "Other owner" }],
    ]));
    await expect(changeSkillOwnerAction({}, transferForm())).resolves.toEqual({ error: DENIED_MESSAGE });
    expect(mocks.changeSkillOwner).not.toHaveBeenCalled();
    expect(mocks.readInstalledSkill).not.toHaveBeenCalled();
  });

  it("does not let a non-admin claim an unassigned skill", async () => {
    mocks.listSkillOwners.mockResolvedValue(new Map());
    await expect(changeSkillOwnerAction({}, transferForm())).resolves.toEqual({ error: DENIED_MESSAGE });
    expect(mocks.changeSkillOwner).not.toHaveBeenCalled();
  });

  it("denies callers outside the workspace", async () => {
    mocks.getWorkspaceRole.mockResolvedValue(null);
    await expect(changeSkillOwnerAction({}, transferForm())).resolves.toEqual({ error: DENIED_MESSAGE });
    expect(mocks.listSkillOwners).not.toHaveBeenCalled();
    expect(mocks.changeSkillOwner).not.toHaveBeenCalled();
  });

  it("rejects missing skills", async () => {
    mocks.readInstalledSkill.mockResolvedValue(null);
    await expect(changeSkillOwnerAction({}, transferForm())).resolves.toEqual({ error: "Skill not found." });
    expect(mocks.changeSkillOwner).not.toHaveBeenCalled();
  });

  it("handles changed ownership or a recipient outside the workspace without auditing success", async () => {
    mocks.changeSkillOwner.mockResolvedValue(false);
    await expect(changeSkillOwnerAction({}, transferForm())).resolves.toEqual({
      error: "Ownership could not be changed. Refresh and choose a current workspace member.",
    });
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(["", "../writing"])("rejects invalid skill name %s", async (name) => {
    const data = transferForm();
    data.set("name", name);
    await expect(changeSkillOwnerAction({}, data)).resolves.toEqual({ error: "Choose a skill and a new owner." });
    expect(mocks.changeSkillOwner).not.toHaveBeenCalled();
  });
});
