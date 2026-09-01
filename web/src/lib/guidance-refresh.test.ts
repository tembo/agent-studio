import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  refreshAllGuidanceFiles: vi.fn(),
  writeAuditEvent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { query: mocks.query } }));
vi.mock("@/lib/workspace-agents", () => ({
  refreshAllGuidanceFiles: mocks.refreshAllGuidanceFiles,
}));
vi.mock("@/lib/audit-db", () => ({
  writeAuditEvent: mocks.writeAuditEvent,
}));

import {
  claimDueGuidanceRefreshes,
  getGuidanceRefreshSettings,
  isGuidanceRefreshCadence,
  refreshWorkspaceGuidance,
  runDueGuidanceRefreshes,
} from "./guidance-refresh";

describe("guidance refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.refreshAllGuidanceFiles.mockResolvedValue({ ok: true });
    mocks.writeAuditEvent.mockResolvedValue({});
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("accepts only the persisted cadence values", () => {
    expect(isGuidanceRefreshCadence("off")).toBe(true);
    expect(isGuidanceRefreshCadence("daily")).toBe(true);
    expect(isGuidanceRefreshCadence("weekly")).toBe(true);
    expect(isGuidanceRefreshCadence("hourly")).toBe(false);
  });

  it("reads cadence and the last refresh floor", async () => {
    const refreshedAt = new Date("2026-09-01T12:00:00Z");
    mocks.query.mockResolvedValue({
      rows: [
        {
          id: "workspace-1",
          guidance_refresh_cadence: "weekly",
          guidance_refreshed_at: refreshedAt,
        },
      ],
    });

    await expect(getGuidanceRefreshSettings("workspace-1")).resolves.toEqual({
      cadence: "weekly",
      refreshedAt,
    });
  });

  it("atomically claims only due workspaces with connected repositories", async () => {
    mocks.query.mockResolvedValue({
      rows: [
        {
          id: "workspace-1",
          guidance_refresh_cadence: "daily",
          guidance_refreshed_at: null,
        },
        {
          id: "workspace-2",
          guidance_refresh_cadence: "weekly",
          guidance_refreshed_at: null,
        },
      ],
    });

    await expect(
      claimDueGuidanceRefreshes(new Date("2026-09-01T12:00:00Z")),
    ).resolves.toEqual([
      { workspaceId: "workspace-1", cadence: "daily" },
      { workspaceId: "workspace-2", cadence: "weekly" },
    ]);
    expect(mocks.query.mock.calls[0]?.[0]).toMatch(
      /JOIN workspace_repo[\s\S]*INTERVAL '1 day'[\s\S]*INTERVAL '7 days'[\s\S]*guidance_refresh_claimed_at < \$1::timestamptz - INTERVAL '15 minutes'[\s\S]*FOR UPDATE OF w SKIP LOCKED[\s\S]*SET guidance_refresh_claimed_at = \$1/,
    );
  });

  it("records a manual refresh floor and audit event", async () => {
    const at = new Date("2026-09-01T12:00:00Z");

    await expect(
      refreshWorkspaceGuidance({
        workspaceId: "workspace-1",
        actorUserId: "user-1",
        source: "human_action",
        trigger: "manual",
        at,
      }),
    ).resolves.toEqual({ ok: true });

    expect(mocks.refreshAllGuidanceFiles).toHaveBeenCalledWith("workspace-1");
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringMatching(/SET guidance_refreshed_at = \$2/),
      ["workspace-1", at],
    );
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        actorUserId: "user-1",
        source: "human_action",
        kind: "guidance.synced",
        payload: { trigger: "manual" },
      }),
    );
  });

  it("keeps a retry lease without advancing the refresh floor on failure", async () => {
    const at = new Date("2026-09-01T12:00:00Z");
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "workspace-1",
            guidance_refresh_cadence: "daily",
            guidance_refreshed_at: null,
          },
        ],
      })
      .mockResolvedValue({ rows: [] });
    mocks.refreshAllGuidanceFiles.mockResolvedValue({
      ok: false,
      error: "github unavailable",
    });

    await runDueGuidanceRefreshes(at);

    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringMatching(/SET guidance_refreshed_at = \$2/),
      expect.anything(),
    );
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
  });

  it("runs due refreshes as auditable system work", async () => {
    const at = new Date("2026-09-01T12:00:00Z");
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "workspace-1",
            guidance_refresh_cadence: "daily",
            guidance_refreshed_at: null,
          },
        ],
      })
      .mockResolvedValue({ rows: [] });

    await runDueGuidanceRefreshes(at);

    expect(mocks.refreshAllGuidanceFiles).toHaveBeenCalledWith("workspace-1");
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: null,
        source: "system",
        payload: { trigger: "schedule", cadence: "daily" },
      }),
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringMatching(
        /SET guidance_refreshed_at = \$2,[\s\S]*guidance_refresh_claimed_at = CASE/,
      ),
      ["workspace-1", at, at],
    );
  });

  it("does not advance or audit a refresh when no repository is connected", async () => {
    mocks.refreshAllGuidanceFiles.mockResolvedValue({
      ok: false,
      error: "no-repo",
    });

    await expect(
      refreshWorkspaceGuidance({
        workspaceId: "workspace-1",
        actorUserId: "user-1",
        source: "human_action",
        trigger: "manual",
      }),
    ).resolves.toEqual({ ok: false, error: "no-repo" });

    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
  });
});
