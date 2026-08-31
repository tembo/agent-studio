import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("@/lib/auth-server", () => ({
  authorizeWorkspace: vi.fn(),
  DENIED_MESSAGE: "Denied",
}));
vi.mock("@/lib/agent-inventory-views", () => ({
  createAgentInventoryView: vi.fn(),
  deleteAgentInventoryView: vi.fn(),
}));

import {
  deleteAgentInventoryViewAction,
  saveAgentInventoryViewAction,
} from "./agent-inventory-view-actions";
import {
  createAgentInventoryView,
  deleteAgentInventoryView,
} from "@/lib/agent-inventory-views";
import { authorizeWorkspace } from "@/lib/auth-server";

const mockAuthorize = vi.mocked(authorizeWorkspace);
const mockCreate = vi.mocked(createAgentInventoryView);
const mockDelete = vi.mocked(deleteAgentInventoryView);
const viewId = "10000000-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthorize.mockResolvedValue({
    ok: true,
    workspace: {
      id: "workspace-1",
      slug: "demo",
      name: "Demo",
      createdBy: "user-1",
      createdAt: new Date(),
      updatedAt: new Date(),
      faviconKind: "default-tembo",
      commitMode: "pull_request",
    },
    userId: "user-1",
    role: "viewer",
  });
});

describe("agent inventory view actions", () => {
  it("lets a workspace viewer create a normalized shared view", async () => {
    mockCreate.mockImplementation(async (args) => ({
      id: viewId,
      name: args.name,
      visibility: args.visibility,
      createdBy: args.userId,
      filters: args.filters,
    }));

    const result = await saveAgentInventoryViewAction({
      workspaceSlug: "demo",
      name: "  Research team  ",
      visibility: "shared",
      filters: { agentType: "sub-agent", sort: "name" },
    });

    expect(result.ok).toBe(true);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        userId: "user-1",
        name: "Research team",
        visibility: "shared",
        filters: expect.objectContaining({
          agentType: "sub-agent",
          sort: "name",
        }),
      }),
    );
  });

  it("does not let a viewer delete another member's shared view", async () => {
    mockDelete.mockResolvedValue(false);

    await expect(
      deleteAgentInventoryViewAction({ workspaceSlug: "demo", viewId }),
    ).resolves.toEqual({
      ok: false,
      error: "You can’t delete that saved view.",
    });
    expect(mockDelete).toHaveBeenCalledWith(
      expect.objectContaining({ canManageShared: false }),
    );
  });
});
