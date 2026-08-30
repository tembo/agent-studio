import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-v1/actions", () => ({
  requestAgentChangeSystem: vi.fn(),
}));
vi.mock("@/lib/automations-api", () => ({
  listEnabledAutomations: vi.fn(),
  setAutomationFired: vi.fn(),
  setAutomationRetrying: vi.fn(),
  setAutomationSkipped: vi.fn(),
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
vi.mock("@/lib/tool-reconcile", () => ({
  maybeReconcileToolCaches: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/workspace-agents", () => ({
  resolveAgentForDispatch: vi.fn(),
}));

import {
  listEnabledAutomations,
  setAutomationRetrying,
  setAutomationSkipped,
  type Automation,
} from "@/lib/automations-api";
import { startScheduler, stopScheduler } from "@/lib/scheduler";
import { resolveAgentForDispatch } from "@/lib/workspace-agents";

const mockListEnabled = vi.mocked(listEnabledAutomations);
const mockResolveDispatch = vi.mocked(resolveAgentForDispatch);
const mockSetRetrying = vi.mocked(setAutomationRetrying);
const mockSetSkipped = vi.mocked(setAutomationSkipped);

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
  mockListEnabled.mockResolvedValue([automation]);
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

    await vi.waitFor(() => expect(mockSetRetrying).toHaveBeenCalledOnce());
    expect(mockSetRetrying).toHaveBeenCalledWith({
      id: automation.id,
      error:
        "Could not read the connected agent repository: GitHub rate-limited the request.",
    });
    expect(mockSetSkipped).not.toHaveBeenCalled();
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

    await vi.waitFor(() => expect(mockSetSkipped).toHaveBeenCalledOnce());
    expect(mockSetRetrying).not.toHaveBeenCalled();
  });
});
