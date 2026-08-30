import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: { query } }));

import {
  getRunExecutionIdentity,
  listRecentRunsForAutomation,
} from "./run-history-db";
import { listChildRuns } from "./runs-db";

describe("run history identities", () => {
  beforeEach(() => query.mockReset());

  it("maps the effective identity for automation runs", async () => {
    query.mockResolvedValue({
      rows: [
        {
          id: "run-1",
          agent_name: "Digest",
          status: "succeeded",
          created_at: new Date("2026-08-30T12:00:00Z"),
          completed_at: new Date("2026-08-30T12:01:00Z"),
          trigger: "schedule",
          automation_id: "automation-1",
          created_by_name: "Ada",
          created_by_email: "ada@example.com",
        },
      ],
    });

    await expect(
      listRecentRunsForAutomation("workspace-1", "automation-1", 5),
    ).resolves.toMatchObject([
      {
        id: "run-1",
        createdByName: "Ada",
        createdByEmail: "ada@example.com",
      },
    ]);
    expect(query.mock.calls[0]?.[0]).toMatch(
      /r\.workspace_id = \$1 AND r\.automation_id = \$2/,
    );
    expect(query.mock.calls[0]?.[1]).toEqual([
      "workspace-1",
      "automation-1",
      5,
    ]);
  });

  it("resolves detail identity through a workspace-scoped run", async () => {
    query.mockResolvedValue({ rows: [] });

    await expect(
      getRunExecutionIdentity("workspace-1", "run-1"),
    ).resolves.toEqual({ name: null, email: null });
    expect(query.mock.calls[0]?.[0]).toMatch(
      /r\.workspace_id = \$1 AND r\.id = \$2/,
    );
    expect(query.mock.calls[0]?.[1]).toEqual(["workspace-1", "run-1"]);
  });

  it("keeps child run identities scoped through the parent workspace", async () => {
    query.mockResolvedValue({
      rows: [
        {
          id: "child-1",
          agent_name: "Researcher",
          status: "succeeded",
          cost_usd: "0.01",
          tokens_input: 100,
          tokens_output: 20,
          created_at: new Date("2026-08-30T12:00:00Z"),
          created_by_name: null,
          created_by_email: "operator@example.com",
        },
      ],
    });

    await expect(listChildRuns("workspace-1", "parent-1")).resolves.toMatchObject(
      [
        {
          id: "child-1",
          createdByName: null,
          createdByEmail: "operator@example.com",
        },
      ],
    );
    expect(query.mock.calls[0]?.[0]).toMatch(
      /r\.workspace_id = \$1 AND r\.parent_run_id = \$2/,
    );
    expect(query.mock.calls[0]?.[1]).toEqual(["workspace-1", "parent-1"]);
  });
});
