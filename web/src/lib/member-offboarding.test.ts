import { beforeEach, describe, expect, it, vi } from "vitest";

const { clientQuery, connect, poolQuery, release } = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  connect: vi.fn(),
  poolQuery: vi.fn(),
  release: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { connect, query: poolQuery },
}));
vi.mock("@/lib/automations-api", () => ({
  ORPHANED_AUTOMATION_ERROR:
    "Paused because the Run as owner is no longer a workspace member.",
}));

import {
  listAutomationOwnershipCounts,
  offboardWorkspaceMember,
} from "./member-offboarding";

const target = {
  role: "operator",
  name: "Former Owner",
  email: "former@example.com",
};

beforeEach(() => {
  vi.clearAllMocks();
  connect.mockResolvedValue({ query: clientQuery, release });
  clientQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT m.role")) return { rows: [target] };
    if (sql.includes("SELECT user_id")) return { rows: [{ user_id: "replacement" }] };
    if (sql.includes("SELECT id, enabled")) {
      return {
        rows: [
          { id: "automation-1", enabled: true },
          { id: "automation-2", enabled: false },
        ],
      };
    }
    return { rows: [] };
  });
});

describe("listAutomationOwnershipCounts", () => {
  it("returns a count keyed by owner", async () => {
    poolQuery.mockResolvedValue({
      rows: [
        { owner_user_id: "owner-1", count: "3" },
        { owner_user_id: "owner-2", count: "1" },
      ],
    });

    await expect(listAutomationOwnershipCounts("workspace")).resolves.toEqual({
      "owner-1": 3,
      "owner-2": 1,
    });
  });
});

describe("offboardWorkspaceMember", () => {
  it("reassigns every owned automation before removing the member", async () => {
    const result = await offboardWorkspaceMember(
      "workspace",
      "former-owner",
      "replacement",
    );

    expect(result).toMatchObject({
      ok: true,
      automationCount: 2,
      reassignedAutomationCount: 2,
      pausedAutomationCount: 0,
      replacementUserId: "replacement",
    });
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringMatching(/SET owner_user_id = \$3/),
      ["workspace", "former-owner", "replacement"],
    );
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringMatching(/DELETE FROM workspace_member/),
      ["workspace", "former-owner"],
    );
    expect(clientQuery).toHaveBeenCalledWith("COMMIT");
  });

  it("pauses enabled schedules when no replacement is selected", async () => {
    const result = await offboardWorkspaceMember(
      "workspace",
      "former-owner",
      null,
    );

    expect(result).toMatchObject({
      ok: true,
      automationCount: 2,
      reassignedAutomationCount: 0,
      pausedAutomationCount: 1,
      replacementUserId: null,
    });
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringMatching(/SET enabled = FALSE/),
      [
        "workspace",
        "former-owner",
        "Paused because the Run as owner is no longer a workspace member.",
      ],
    );
  });

  it("rejects a replacement who is no longer a workspace member", async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT m.role")) return { rows: [target] };
      if (sql.includes("SELECT user_id")) return { rows: [] };
      return { rows: [] };
    });

    await expect(
      offboardWorkspaceMember("workspace", "former-owner", "missing-user"),
    ).resolves.toEqual({ ok: false, error: "invalid-replacement" });
    expect(clientQuery).toHaveBeenCalledWith("ROLLBACK");
    expect(clientQuery).not.toHaveBeenCalledWith(
      expect.stringMatching(/DELETE FROM workspace_member/),
      expect.anything(),
    );
  });

  it("preserves the last-admin guard", async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT m.role")) {
        return { rows: [{ ...target, role: "workspace_admin" }] };
      }
      if (sql.includes("COUNT(*)")) return { rows: [{ count: "1" }] };
      return { rows: [] };
    });

    await expect(
      offboardWorkspaceMember("workspace", "last-admin", null),
    ).resolves.toEqual({ ok: false, error: "last-admin" });
    expect(clientQuery).toHaveBeenCalledWith("ROLLBACK");
    expect(clientQuery).not.toHaveBeenCalledWith(
      expect.stringMatching(/DELETE FROM workspace_member/),
      expect.anything(),
    );
  });
});
