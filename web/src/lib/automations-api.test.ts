import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: { query } }));

import { listEnabledAutomations, updateAutomation } from "./automations-api";

describe("automation owner membership", () => {
  beforeEach(() => query.mockReset());

  it("only returns enabled automations whose owner is still a member", async () => {
    query.mockResolvedValue({ rows: [] });

    await expect(listEnabledAutomations()).resolves.toEqual([]);
    expect(query.mock.calls[0]?.[0]).toMatch(
      /a\.enabled = TRUE[\s\S]*EXISTS[\s\S]*workspace_member/,
    );
  });

  it("does not clear current failure health when an automation is edited", async () => {
    query.mockResolvedValue({
      rows: [
        {
          id: "automation-1",
          workspace_id: "workspace-1",
          name: "Daily report",
          agent_name: "daily-report",
          cron: "0 9 * * *",
          input_message: "",
          enabled: true,
          last_fired_at: null,
          last_fire_error: "The run could not be queued.",
          last_fire_event_id: "event-1",
          created_by: "user-1",
          created_by_name: null,
          created_by_email: null,
          owner_user_id: "user-1",
          owner_user_name: null,
          owner_user_email: null,
          use_draft: false,
          created_at: new Date("2026-08-31T00:00:00Z"),
          updated_at: new Date("2026-08-31T00:00:00Z"),
        },
      ],
    });

    const updated = await updateAutomation({
      id: "automation-1",
      name: "Daily report",
      agentName: "daily-report",
      cron: "0 9 * * *",
      inputMessage: "",
      enabled: true,
      ownerUserId: "user-1",
    });

    expect(query.mock.calls[0]?.[0]).not.toMatch(/last_fire_error\s*=\s*NULL/);
    expect(updated.lastFireError).toBe("The run could not be queued.");
    expect(updated.lastFireEventId).toBe("event-1");
  });
});
