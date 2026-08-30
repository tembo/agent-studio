import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: { query } }));

import { listChatRunsForAgent } from "./chat-runs-db";

describe("listChatRunsForAgent", () => {
  beforeEach(() => query.mockReset());

  it("limits the newest runs and returns them chronologically", async () => {
    query.mockResolvedValue({
      rows: [
        {
          id: "new",
          agent_name: "agent",
          status: "succeeded",
          user_message: "new message",
          output: "new response",
          failure_summary: null,
          created_at: new Date("2026-08-30T12:02:00Z"),
          completed_at: new Date("2026-08-30T12:02:10Z"),
        },
        {
          id: "old",
          agent_name: "agent",
          status: "succeeded",
          user_message: "old message",
          output: "old response",
          failure_summary: null,
          created_at: new Date("2026-08-30T12:01:00Z"),
          completed_at: new Date("2026-08-30T12:01:10Z"),
        },
      ],
    });

    const runs = await listChatRunsForAgent("workspace", "agent", 2);

    expect(query.mock.calls[0]?.[0]).toMatch(/ORDER BY created_at DESC/);
    expect(query.mock.calls[0]?.[1]).toEqual(["workspace", "agent", 2]);
    expect(runs.map((run) => run.id)).toEqual(["old", "new"]);
  });
});
