import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { query } }));

import { changeSkillOwner, listSkillOwners, recordSkillOwner, removeSkillOwner } from "./skill-owners";

describe("skill ownership storage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    query.mockResolvedValue({ rows: [], rowCount: 1 });
  });

  it("reads owner display names scoped to a workspace", async () => {
    query.mockResolvedValue({ rows: [{ skill_name: "writing", user_id: "user-1", name: "Alex" }] });
    expect(await listSkillOwners("workspace-1")).toEqual(new Map([
      ["writing", { userId: "user-1", name: "Alex" }],
    ]));
    expect(query).toHaveBeenCalledWith(expect.stringContaining("WHERE so.workspace_id = $1"), ["workspace-1"]);
  });

  it("preserves an existing owner on reinstall", async () => {
    await recordSkillOwner("workspace-1", "writing", "user-2");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("WHERE skill_owner.owner_user_id IS NULL"), ["workspace-1", "writing", "user-2"]);
  });

  it("removes only the matching workspace's ownership", async () => {
    await removeSkillOwner("workspace-1", "writing");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("WHERE workspace_id = $1 AND skill_name = $2"), ["workspace-1", "writing"]);
  });

  it("checks recipient membership and current ownership in the write", async () => {
    expect(await changeSkillOwner({ workspaceId: "workspace-1", skillName: "writing", actorUserId: "user-1", isAdmin: false, ownerUserId: "user-2" })).toBe(true);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("workspace_member WHERE workspace_id = $1 AND user_id = $3"), ["workspace-1", "writing", "user-2", false, "user-1"]);
    expect(query.mock.calls[0][0]).toContain("WHERE $4 OR (skill_owner.owner_user_id = $5 AND $3 <> $5)");
  });

  it("reports denied or stale transfers", async () => {
    query.mockResolvedValue({ rowCount: 0, rows: [] });
    expect(await changeSkillOwner({ workspaceId: "workspace-1", skillName: "writing", actorUserId: "user-1", isAdmin: false, ownerUserId: "user-2" })).toBe(false);
  });
});
