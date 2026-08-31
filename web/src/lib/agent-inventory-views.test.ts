import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: { query } }));

import {
  deleteAgentInventoryView,
  listAgentInventoryViews,
  updateAgentInventoryView,
} from "./agent-inventory-views";

describe("agent inventory views", () => {
  beforeEach(() => query.mockReset());

  it("lists the current user's personal views and workspace shared views", async () => {
    query.mockResolvedValue({
      rows: [
        {
          id: "view-1",
          name: "My failing agents",
          visibility: "personal",
          created_by: "user-1",
          filters: { owner: "me", starred: true, status: "error" },
        },
      ],
    });

    await expect(
      listAgentInventoryViews("workspace-1", "user-1"),
    ).resolves.toMatchObject([
      {
        name: "My failing agents",
        filters: { owner: ["me"], starred: [true], status: ["error"] },
      },
    ]);
    expect(query.mock.calls[0]?.[0]).toMatch(
      /visibility = 'shared' OR created_by = \$2/,
    );
    expect(query.mock.calls[0]?.[1]).toEqual(["workspace-1", "user-1"]);
  });

  it("only deletes owned views unless shared-view admin access is granted", async () => {
    query.mockResolvedValue({ rowCount: 1, rows: [] });

    await expect(
      deleteAgentInventoryView({
        workspaceId: "workspace-1",
        userId: "user-1",
        viewId: "view-1",
        canManageShared: false,
      }),
    ).resolves.toBe(true);
    expect(query.mock.calls[0]?.[0]).toMatch(
      /created_by = \$3 OR \(\$4 AND visibility = 'shared'\)/,
    );
    expect(query.mock.calls[0]?.[1]).toEqual([
      "view-1",
      "workspace-1",
      "user-1",
      false,
    ]);
  });

  it("updates owned views and keeps admin edits to others' views shared", async () => {
    query.mockResolvedValue({
      rows: [
        {
          id: "view-1",
          name: "Updated",
          visibility: "shared",
          created_by: "user-2",
          filters: { status: ["error"] },
        },
      ],
    });

    await expect(
      updateAgentInventoryView({
        workspaceId: "workspace-1",
        userId: "user-1",
        viewId: "view-1",
        canManageShared: true,
        name: "Updated",
        visibility: "shared",
        filters: {
          query: "",
          owner: [],
          starred: [],
          status: ["error"],
          promotionOnly: false,
          label: [],
          model: [],
          mcp: [],
          agentType: [],
          orchestrator: [],
          operators: {
            owner: "is",
            starred: "is",
            status: "is",
            promotionOnly: "is",
            label: "is",
            model: "is",
            mcp: "is",
            agentType: "is",
            orchestrator: "is",
          },
          sort: "last-run",
        },
      }),
    ).resolves.toMatchObject({ name: "Updated", visibility: "shared" });
    expect(query.mock.calls[0]?.[0]).toMatch(
      /\$4 AND visibility = 'shared' AND \$5 = 'shared'/,
    );
    expect(query.mock.calls[0]?.[1]?.slice(0, 6)).toEqual([
      "view-1",
      "workspace-1",
      "user-1",
      true,
      "shared",
      "Updated",
    ]);
  });
});
