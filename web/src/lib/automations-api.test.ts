import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: { query } }));

import {
  listEnabledAutomations,
  ORPHANED_AUTOMATION_ERROR,
  pauseAutomationsWithMissingOwners,
} from "./automations-api";

describe("automation owner membership", () => {
  beforeEach(() => query.mockReset());

  it("pauses enabled automations whose owner is no longer a member", async () => {
    query.mockResolvedValue({ rows: [{ id: "one" }, { id: "two" }] });

    await expect(pauseAutomationsWithMissingOwners()).resolves.toBe(2);
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(
        /UPDATE automation[\s\S]*enabled = FALSE[\s\S]*NOT EXISTS[\s\S]*workspace_member/,
      ),
      [ORPHANED_AUTOMATION_ERROR],
    );
  });

  it("only returns enabled automations whose owner is still a member", async () => {
    query.mockResolvedValue({ rows: [] });

    await expect(listEnabledAutomations()).resolves.toEqual([]);
    expect(query.mock.calls[0]?.[0]).toMatch(
      /a\.enabled = TRUE[\s\S]*EXISTS[\s\S]*workspace_member/,
    );
  });
});
