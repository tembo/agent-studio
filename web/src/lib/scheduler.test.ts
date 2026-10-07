import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-v1/actions", () => ({
  requestAgentChangeSystem: vi.fn(),
}));
vi.mock("@/lib/automations-api", () => ({
  listEnabledAutomations: vi.fn(),
}));
vi.mock("@/lib/automation-events", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/automation-events")>(),
  agentResolutionFailure: vi.fn((error: { kind: string; message: string }) => ({
    code: error.kind,
    summary: error.message,
    recommendation: "Fix it.",
  })),
  pauseAutomationsWithMissingOwners: vi.fn().mockResolvedValue(0),
  recordAutomationFailure: vi.fn(),
  recordAutomationSuccess: vi.fn(),
}));
vi.mock("@/lib/agent-learning-api", () => ({
  listDueLearningConfigs: vi.fn().mockResolvedValue([]),
  setAgentLearned: vi.fn(),
}));
vi.mock("@/lib/guidance-refresh", () => ({
  runDueGuidanceRefreshes: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/inbox-api", () => ({
  listUnconsumedSignalsForAgent: vi.fn(),
  markSignalsConsumed: vi.fn(),
}));
vi.mock("@/lib/improvements-api", () => ({
  isAgentCreatePending: vi.fn(),
}));
vi.mock("@/lib/tool-reconcile", () => ({
  maybeReconcileToolCaches: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/workspace-agents", () => ({
  resolveAgentForDispatch: vi.fn(),
}));

import { listEnabledAutomations, type Automation } from "@/lib/automations-api";
import {
  pauseAutomationsWithMissingOwners,
  recordAutomationFailure,
  recordAutomationSuccess,
} from "@/lib/automation-events";
import { isAgentCreatePending } from "@/lib/improvements-api";
import { runDueGuidanceRefreshes } from "@/lib/guidance-refresh";
import { startScheduler, stopScheduler } from "@/lib/scheduler";
import { resolveAgentForDispatch } from "@/lib/workspace-agents";

const mockListEnabled = vi.mocked(listEnabledAutomations);
const mockPauseMissingOwners = vi.mocked(pauseAutomationsWithMissingOwners);
const mockResolveDispatch = vi.mocked(resolveAgentForDispatch);
const mockRecordFailure = vi.mocked(recordAutomationFailure);
const mockIsAgentCreatePending = vi.mocked(isAgentCreatePending);
const mockRunDueGuidanceRefreshes = vi.mocked(runDueGuidanceRefreshes);

const automation: Automation = {
  id: "automation-1",
  workspaceId: "ws-1",
  name: "Daily report",
  agentName: "daily-report",
  cron: "0 9 * * *",
  timezone: "UTC",
  inputMessage: "",
  enabled: true,
  lastFiredAt: null,
  lastFireError: null,
  lastFireEventId: null,
  createdBy: "user-1",
  createdByName: null,
  createdByEmail: null,
  ownerUserId: "user-1",
  ownerUserName: null,
  ownerUserEmail: null,
  useDraft: false,
  createdAt: new Date("2026-08-30T08:00:00Z"),
  updatedAt: new Date("2026-08-30T08:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPauseMissingOwners.mockResolvedValue(0);
  mockListEnabled.mockResolvedValue([automation]);
  mockIsAgentCreatePending.mockResolvedValue(false);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  stopScheduler();
  vi.restoreAllMocks();
});

describe("scheduler agent-source failures", () => {
  it("keeps the firing window due while retrying a transient failure", async () => {
    mockResolveDispatch.mockResolvedValue({
      ok: false,
      error: {
        kind: "source-unavailable",
        message:
          "Could not read the connected agent repository: GitHub rate-limited the request.",
        sourceError: "rate-limited",
        retryable: true,
      },
    });

    startScheduler();

    await vi.waitFor(() => expect(mockRecordFailure).toHaveBeenCalledOnce());
    expect(mockRecordFailure).toHaveBeenCalledWith({
      kind: "schedule",
      id: automation.id,
      occurredAt: expect.any(Date),
      failure: expect.objectContaining({ code: "source-unavailable" }),
      advanceFiringFloor: false,
    });
  });

  it("advances the firing floor for a genuinely missing agent", async () => {
    mockResolveDispatch.mockResolvedValue({
      ok: false,
      error: {
        kind: "not-found",
        message: 'Agent "daily-report" is no longer in the connected repo.',
      },
    });

    startScheduler();

    await vi.waitFor(() => expect(mockRecordFailure).toHaveBeenCalledOnce());
    expect(mockRecordFailure).toHaveBeenCalledWith({
      kind: "schedule",
      id: automation.id,
      occurredAt: expect.any(Date),
      failure: expect.objectContaining({ code: "not-found" }),
    });
  });

  it("keeps the firing window due while the agent is being created", async () => {
    mockResolveDispatch.mockResolvedValue({
      ok: false,
      error: {
        kind: "not-found",
        message: 'Agent "daily-report" is no longer in the connected repo.',
      },
    });
    mockIsAgentCreatePending.mockResolvedValue(true);

    startScheduler();

    await vi.waitFor(() =>
      expect(mockIsAgentCreatePending).toHaveBeenCalledWith(
        automation.workspaceId,
        automation.agentName,
      ),
    );
    expect(mockRecordFailure).not.toHaveBeenCalled();
  });
});

describe("scheduler owner membership", () => {
  it("pauses orphaned schedules before listing runnable automations", async () => {
    mockPauseMissingOwners.mockResolvedValue(1);
    mockListEnabled.mockResolvedValue([]);

    startScheduler();

    await vi.waitFor(() => expect(mockListEnabled).toHaveBeenCalledOnce());
    expect(mockPauseMissingOwners).toHaveBeenCalledOnce();
    expect(mockPauseMissingOwners.mock.invocationCallOrder[0]).toBeLessThan(
      mockListEnabled.mock.invocationCallOrder[0],
    );
  });
});

describe("scheduler guidance refresh", () => {
  it("checks due workspace guidance on startup", async () => {
    mockListEnabled.mockResolvedValue([]);

    startScheduler();

    await vi.waitFor(() =>
      expect(mockRunDueGuidanceRefreshes).toHaveBeenCalledOnce(),
    );
  });
});

describe("scheduler dispatch recovery", () => {
  let current: Automation;
  const request = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T09:00:00Z"));
    vi.stubEnv("INTERNAL_API_TOKEN", "test-token");
    vi.stubGlobal("fetch", request);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    request.mockReset().mockImplementation(async () => Response.json({ run_id: "run-1" }));
    current = { ...automation };
    mockListEnabled.mockImplementation(async () => [{ ...current }]);
    mockResolveDispatch.mockResolvedValue({
      ok: true,
      resolved: {
        agentName: "daily-report", agentPath: "agents/daily-report.yaml",
        framework: "pydantic-agentspec", model: "test:model", specContent: "name: daily-report",
        specFormat: "yaml", versionId: null, versionLabel: "draft", connections: [],
      },
    });
    mockRecordFailure.mockImplementation(async (input) => {
      current.lastFireError = input.failure.summary;
      if (input.advanceFiringFloor !== false) current.lastFiredAt = input.occurredAt!;
    });
    vi.mocked(recordAutomationSuccess).mockImplementation(async (input) => {
      current.lastFiredAt = input.occurredAt!;
      current.lastFireError = null;
    });
  });

  afterEach(() => {
    stopScheduler();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([
    ["2026-10-30T12:10:00Z", "2026-11-02T13:09:30Z"],
    ["2026-03-06T13:10:00Z", "2026-03-09T12:09:30Z"],
  ])("dispatches at 8:10 Eastern after the DST change from %s", async (lastFire, beforeDue) => {
    current.cron = "10 8 * * 1-5";
    current.timezone = "America/New_York";
    current.lastFiredAt = new Date(lastFire);
    vi.setSystemTime(new Date(beforeDue));
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([429, 500, 502, 503, 504])("recovers from HTTP %s without waiting for the next daily window", async (status) => {
    request.mockResolvedValueOnce(new Response(null, { status }));
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);

    expect(current.lastFiredAt).toBeNull();
    expect(current.enabled).toBe(true);
    expect(mockRecordFailure).toHaveBeenCalledWith(expect.objectContaining({
      advanceFiringFloor: false,
      failure: expect.objectContaining({
        code: "run_api_error", recommendation: expect.stringContaining("retry automatically"),
      }),
    }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(current.lastFireError).toBeNull();
    expect(recordAutomationSuccess).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1" }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("backs off repeated service failures up to fifteen minutes", async () => {
    request.mockImplementation(async () => new Response(null, { status: 503 }));
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    let attempts = 1;
    for (const delay of [30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000]) {
      await vi.advanceTimersByTimeAsync(delay - 30_000);
      expect(request).toHaveBeenCalledTimes(attempts);
      await vi.advanceTimersByTimeAsync(30_000);
      attempts++;
      expect(request).toHaveBeenCalledTimes(attempts);
    }
    expect(current.lastFiredAt).toBeNull();
    expect(current.enabled).toBe(true);
  });

  it("retains a due firing across a scheduler restart", async () => {
    request.mockResolvedValueOnce(new Response(null, { status: 503 }));
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    stopScheduler();
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(2);
    expect(current.lastFireError).toBeNull();
  });

  it("does not rapidly retry configuration failures and still fires the next day", async () => {
    request.mockResolvedValueOnce(new Response(null, { status: 401 }));
    startScheduler();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledOnce();
    expect(current.enabled).toBe(true);
    expect(current.lastFireError).not.toBeNull();
    vi.setSystemTime(new Date("2026-08-31T08:59:30Z"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(current.lastFireError).toBeNull();
  });

  it("retries transport failures at the next cron window rather than replaying an ambiguous POST", async () => {
    request.mockRejectedValueOnce(new TypeError("fetch failed"));
    startScheduler();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledOnce();
    expect(mockRecordFailure).toHaveBeenCalledWith(expect.objectContaining({
      failure: expect.objectContaining({ code: "run_api_unavailable" }),
    }));
    expect(current.enabled).toBe(true);
    vi.setSystemTime(new Date("2026-08-31T08:59:30Z"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(current.lastFireError).toBeNull();
  });

  it("keeps an errored automation scheduled across future cron windows", async () => {
    current.lastFiredAt = new Date("2026-08-29T09:00:00Z");
    current.lastFireError = "The previous scheduled dispatch failed.";
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledOnce();
    vi.setSystemTime(new Date("2026-08-31T08:59:30Z"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(current.enabled).toBe(true);
  });
});
