import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-v1/actions", () => ({
  requestAgentChangeSystem: vi.fn(),
}));
vi.mock("@/lib/automations-api", () => ({
  listEnabledAutomations: vi.fn(),
}));
vi.mock("@/lib/automation-events", () => ({
  agentResolutionFailure: vi.fn((error: { kind: string; message: string }) => ({
    code: error.kind,
    summary: error.message,
    recommendation: "Fix it.",
  })),
  automationServiceConfigurationFailure: vi.fn(),
  pauseAutomationsWithMissingOwners: vi.fn().mockResolvedValue(0),
  recordAutomationFailure: vi.fn(),
  recordAutomationSuccess: vi.fn(),
  runApiFailure: vi.fn(),
  unexpectedDispatchFailure: vi.fn(),
}));
vi.mock("@/lib/agent-learning-api", () => ({
  listDueLearningConfigs: vi.fn().mockResolvedValue([]),
  setAgentLearned: vi.fn(),
}));
vi.mock("@/lib/cron", () => ({
  hasFiringInWindow: vi.fn().mockReturnValue(true),
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
} from "@/lib/automation-events";
import { isAgentCreatePending } from "@/lib/improvements-api";
import { startScheduler, stopScheduler } from "@/lib/scheduler";
import { resolveAgentForDispatch } from "@/lib/workspace-agents";

const mockListEnabled = vi.mocked(listEnabledAutomations);
const mockPauseMissingOwners = vi.mocked(pauseAutomationsWithMissingOwners);
const mockResolveDispatch = vi.mocked(resolveAgentForDispatch);
const mockRecordFailure = vi.mocked(recordAutomationFailure);
const mockIsAgentCreatePending = vi.mocked(isAgentCreatePending);

const automation: Automation = {
  id: "automation-1",
  workspaceId: "ws-1",
  name: "Daily report",
  agentName: "daily-report",
  cron: "0 9 * * *",
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
