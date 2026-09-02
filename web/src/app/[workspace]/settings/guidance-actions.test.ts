import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeWorkspace: vi.fn(),
  getGuidanceRefreshSettings: vi.fn(),
  refreshWorkspaceGuidance: vi.fn(),
  setGuidanceRefreshCadence: vi.fn(),
  writeAuditEvent: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ notFound: vi.fn() }));
vi.mock("@/lib/auth-server", () => ({
  authorizeWorkspace: mocks.authorizeWorkspace,
  DENIED_MESSAGE: "Denied.",
}));
vi.mock("@/lib/guidance-refresh", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/guidance-refresh")>();
  return {
    ...original,
    getGuidanceRefreshSettings: mocks.getGuidanceRefreshSettings,
    refreshWorkspaceGuidance: mocks.refreshWorkspaceGuidance,
    setGuidanceRefreshCadence: mocks.setGuidanceRefreshCadence,
  };
});
vi.mock("@/lib/audit-db", () => ({
  writeAuditEvent: mocks.writeAuditEvent,
}));

import {
  setGuidanceRefreshCadenceAction,
  syncGuidanceAction,
} from "./guidance-actions";

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

describe("guidance settings actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeWorkspace.mockResolvedValue({
      ok: true,
      workspace: { id: "workspace-1" },
      userId: "user-1",
      role: "workspace_admin",
    });
    mocks.refreshWorkspaceGuidance.mockResolvedValue({ ok: true });
    mocks.getGuidanceRefreshSettings.mockResolvedValue({
      cadence: "off",
      refreshedAt: null,
    });
  });

  it("uses the shared refresh path for a manual sync", async () => {
    await expect(
      syncGuidanceAction({}, form({ workspace: "acme" })),
    ).resolves.toEqual(expect.objectContaining({ message: expect.any(String) }));

    expect(mocks.refreshWorkspaceGuidance).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      actorUserId: "user-1",
      source: "human_action",
      trigger: "manual",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      "/acme/settings/repository",
    );
  });

  it("rejects an unknown cadence before authorization", async () => {
    await expect(
      setGuidanceRefreshCadenceAction(
        {},
        form({ workspace: "acme", cadence: "hourly" }),
      ),
    ).resolves.toEqual({ error: "Choose Off, Daily, or Weekly." });

    expect(mocks.authorizeWorkspace).not.toHaveBeenCalled();
  });

  it("persists and audits a cadence change", async () => {
    await expect(
      setGuidanceRefreshCadenceAction(
        {},
        form({ workspace: "acme", cadence: "daily" }),
      ),
    ).resolves.toEqual({ message: "Agent guidance will refresh daily." });

    expect(mocks.setGuidanceRefreshCadence).toHaveBeenCalledWith(
      "workspace-1",
      "daily",
    );
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "guidance.cadence_changed",
        source: "policy_change",
        payload: { from: "off", to: "daily" },
      }),
    );
  });
});
