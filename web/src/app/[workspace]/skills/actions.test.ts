import { zipSync, strToU8 } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  getWorkspaceBySlug: vi.fn(),
  getWorkspaceRole: vi.fn(),
  getWorkspaceSecretPlaintext: vi.fn(),
  installSkillFiles: vi.fn(),
  removeSkill: vi.fn(),
  recordSkillOwner: vi.fn(),
  removeSkillOwner: vi.fn(),
  writeAuditEvent: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  redirect: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ getServerSession: mocks.getServerSession }));
vi.mock("@/lib/workspace", () => ({
  getWorkspaceBySlug: mocks.getWorkspaceBySlug,
  getWorkspaceRole: mocks.getWorkspaceRole,
  getWorkspaceSecretPlaintext: mocks.getWorkspaceSecretPlaintext,
}));
vi.mock("@/lib/workspace-skills", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/workspace-skills")>(),
  installSkillFiles: mocks.installSkillFiles,
  removeSkill: mocks.removeSkill,
}));
vi.mock("@/lib/audit-db", () => ({ writeAuditEvent: mocks.writeAuditEvent }));
vi.mock("@/lib/skill-owners", () => ({
  recordSkillOwner: mocks.recordSkillOwner,
  removeSkillOwner: mocks.removeSkillOwner,
}));

import { DENIED_MESSAGE } from "@/lib/auth-server";
import {
  importFromAnthropicAction,
  installFromGitHubAction,
  installFromSkillsShAction,
  removeSkillAction,
  uploadSkillAction,
} from "./actions";

const skillContent = "---\nname: My Writing Skill\ndescription: Writing guidance\n---\nWrite clearly.";

function uploadForm() {
  const data = new FormData();
  data.set("workspace", "acme");
  const bytes = zipSync({ "writing/SKILL.md": strToU8(skillContent) });
  data.set("bundle", new File([new Uint8Array(bytes)], "writing.zip"));
  return data;
}

describe("skill upload permissions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getServerSession.mockResolvedValue({ user: { id: "user-1" } });
    mocks.getWorkspaceBySlug.mockResolvedValue({ id: "workspace-1" });
    mocks.getWorkspaceRole.mockResolvedValue("operator");
    mocks.installSkillFiles.mockResolvedValue({ ok: true, fileCount: 1 });
  });

  it.each(["operator", "workspace_admin"])("allows %s to upload and records the actor", async (role) => {
    mocks.getWorkspaceRole.mockResolvedValue(role);

    await expect(uploadSkillAction({}, uploadForm())).resolves.toEqual({
      message: 'Installed skill "my-writing-skill" (1 files).',
    });

    expect(mocks.getWorkspaceBySlug).toHaveBeenCalledWith("acme");
    expect(mocks.getWorkspaceRole).toHaveBeenCalledWith("workspace-1", "user-1");
    expect(mocks.installSkillFiles).toHaveBeenCalledWith(
      "workspace-1", "my-writing-skill", { "SKILL.md": skillContent },
    );
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      actorUserId: "user-1",
      kind: "skill.installed",
      payload: { name: "my-writing-skill", source: "upload", fileCount: 1 },
    }));
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/acme/skills");
    expect(mocks.recordSkillOwner).toHaveBeenCalledWith(
      "workspace-1", "my-writing-skill", "user-1",
    );
  });

  it.each(["viewer", null])("denies upload for role %s without side effects", async (role) => {
    mocks.getWorkspaceRole.mockResolvedValue(role);

    await expect(uploadSkillAction({}, uploadForm())).resolves.toEqual({ error: DENIED_MESSAGE });
    expect(mocks.installSkillFiles).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
    expect(mocks.recordSkillOwner).not.toHaveBeenCalled();
  });

  it.each(["no-session", "no-workspace"])("returns not found for %s", async (reason) => {
    if (reason === "no-session") mocks.getServerSession.mockResolvedValue(null);
    else mocks.getWorkspaceBySlug.mockResolvedValue(null);

    await expect(uploadSkillAction({}, uploadForm())).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.installSkillFiles).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
  });

  it("keeps bundle validation for operators", async () => {
    const data = uploadForm();
    data.delete("bundle");

    await expect(uploadSkillAction({}, data)).resolves.toEqual({ error: "Choose a .zip bundle to upload." });
    expect(mocks.installSkillFiles).not.toHaveBeenCalled();
  });

  it("does not record ownership when installation fails", async () => {
    mocks.installSkillFiles.mockResolvedValue({ ok: false, error: "Commit failed." });

    await expect(uploadSkillAction({}, uploadForm())).resolves.toEqual({ error: "Commit failed." });
    expect(mocks.recordSkillOwner).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
  });

  it("clears ownership after successful removal", async () => {
    mocks.getWorkspaceRole.mockResolvedValue("workspace_admin");
    mocks.removeSkill.mockResolvedValue({ ok: true, deleted: 1 });
    const data = uploadForm();
    data.set("name", "my-writing-skill");

    await removeSkillAction({}, data);

    expect(mocks.removeSkillOwner).toHaveBeenCalledWith("workspace-1", "my-writing-skill");
  });

  it("preserves ownership when removal fails", async () => {
    mocks.getWorkspaceRole.mockResolvedValue("workspace_admin");
    mocks.removeSkill.mockResolvedValue({ ok: false, error: "Delete failed." });
    const data = uploadForm();
    data.set("name", "my-writing-skill");

    await expect(removeSkillAction({}, data)).resolves.toEqual({ error: "Delete failed." });
    expect(mocks.removeSkillOwner).not.toHaveBeenCalled();
  });

  it.each([
    installFromGitHubAction,
    installFromSkillsShAction,
    importFromAnthropicAction,
    removeSkillAction,
  ])("keeps other skill mutations admin-only: %s", async (action) => {
    await expect(action({}, uploadForm())).resolves.toEqual({ error: DENIED_MESSAGE });
    expect(mocks.installSkillFiles).not.toHaveBeenCalled();
    expect(mocks.removeSkill).not.toHaveBeenCalled();
    expect(mocks.getWorkspaceSecretPlaintext).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
    expect(mocks.recordSkillOwner).not.toHaveBeenCalled();
    expect(mocks.removeSkillOwner).not.toHaveBeenCalled();
  });
});
