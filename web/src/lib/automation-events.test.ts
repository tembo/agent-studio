import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: { query } }));

import {
  agentResolutionFailure,
  getAutomationDispatchEvent,
  listAutomationDispatchEvents,
  ORPHANED_AUTOMATION_FAILURE,
  pauseAutomationsWithMissingOwners,
  recordAutomationFailure,
  recordAutomationSuccess,
  runApiFailure,
} from "./automation-events";

beforeEach(() => query.mockReset());

describe("safe automation diagnostics", () => {
  it("does not persist parser detail from an invalid agent definition", () => {
    const failure = agentResolutionFailure({
      kind: "invalid",
      message: "bad yaml near sk-secret-value",
    });

    expect(failure.summary).toBe("The agent definition could not be loaded.");
    expect(JSON.stringify(failure)).not.toContain("sk-secret-value");
  });

  it("stores only the upstream status for run API failures", () => {
    expect(runApiFailure(503)).toEqual(
      expect.objectContaining({
        code: "run_api_error",
        diagnosticDetail: "Run API returned HTTP 503.",
      }),
    );
  });
});

describe("automation dispatch event writes", () => {
  it("appends a failure and points current health at its event", async () => {
    query.mockResolvedValue({ rows: [] });
    const occurredAt = new Date("2026-08-31T02:00:00Z");

    await recordAutomationFailure({
      kind: "schedule",
      id: "automation-1",
      occurredAt,
      advanceFiringFloor: false,
      failure: runApiFailure(500),
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(
        /INSERT INTO automation_dispatch_event[\s\S]*last_fire_event_id = inserted\.id/,
      ),
      [
        "automation-1",
        "schedule",
        occurredAt,
        "run_api_error",
        "The run could not be queued.",
        expect.any(String),
        "Run API returned HTTP 500.",
        false,
      ],
    );
  });

  it("records one recovery when clearing the current failure", async () => {
    query.mockResolvedValue({ rows: [] });
    const occurredAt = new Date("2026-08-31T02:05:00Z");

    await recordAutomationSuccess({
      kind: "webhook",
      id: "webhook-1",
      occurredAt,
      runId: "run-1",
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(
        /outcome = 'failed'[\s\S]*INSERT INTO automation_dispatch_event[\s\S]*'resolved'[\s\S]*last_fire_error = NULL/,
      ),
      ["webhook-1", "webhook", occurredAt, "run-1"],
    );
  });

  it("records durable owner-removal failures while pausing schedules", async () => {
    query.mockResolvedValue({ rows: [{ id: "one" }, { id: "two" }] });

    await expect(pauseAutomationsWithMissingOwners()).resolves.toBe(2);
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(
        /INSERT INTO automation_dispatch_event[\s\S]*enabled = FALSE[\s\S]*last_fire_event_id = inserted\.id/,
      ),
      [
        ORPHANED_AUTOMATION_FAILURE.code,
        ORPHANED_AUTOMATION_FAILURE.summary,
        ORPHANED_AUTOMATION_FAILURE.recommendation,
        null,
      ],
    );
  });
});

describe("workspace-scoped history reads", () => {
  it("does not load diagnostics into the history list", async () => {
    query.mockResolvedValue({ rows: [] });

    await expect(listAutomationDispatchEvents("workspace-1")).resolves.toEqual(
      [],
    );
    expect(query.mock.calls[0]?.[0]).toMatch(
      /NULL::text AS diagnostic_detail/,
    );
  });

  it("requires both workspace and event id", async () => {
    query.mockResolvedValue({ rows: [] });

    await expect(
      getAutomationDispatchEvent("workspace-1", "event-1", false),
    ).resolves.toBeNull();
    expect(query.mock.calls[0]?.[0]).toMatch(
      /WHERE workspace_id = \$1 AND id = \$2/,
    );
    expect(query.mock.calls[0]?.[0]).toMatch(
      /CASE WHEN \$3 THEN diagnostic_detail ELSE NULL END/,
    );
    expect(query.mock.calls[0]?.[1]).toEqual([
      "workspace-1",
      "event-1",
      false,
    ]);
  });
});
