import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: { query } }));

import {
  isAgentCreatePending,
  listImprovementsForAgent,
} from "./improvements-api";

function row(id: string, createdAt: string) {
  return {
    id,
    workspace_id: "workspace",
    run_id: null,
    agent_name: "agent",
    agent_path: "agents/agent.yaml",
    improvement_text: `${id} request`,
    kind: "edit",
    source: "chat",
    tembo_task_id: null,
    tembo_task_html_url: null,
    pr_url: null,
    pr_number: null,
    pr_state: null,
    status: "submitted",
    delivery: "pr",
    commit_sha: null,
    commit_url: null,
    created_by: "user",
    created_by_name: "User",
    created_by_email: "user@example.com",
    created_at: new Date(createdAt),
    updated_at: new Date(createdAt),
  };
}

describe("listImprovementsForAgent", () => {
  beforeEach(() => query.mockReset());

  it("limits the newest requests and returns them chronologically", async () => {
    query.mockResolvedValue({
      rows: [
        row("new", "2026-08-30T12:02:00Z"),
        row("old", "2026-08-30T12:01:00Z"),
      ],
    });

    const improvements = await listImprovementsForAgent(
      "workspace",
      "agent",
      2,
    );

    expect(query.mock.calls[0]?.[0]).toMatch(/ORDER BY i\.created_at DESC/);
    expect(query.mock.calls[0]?.[1]).toEqual(["workspace", "agent", 2]);
    expect(improvements.map((improvement) => improvement.id)).toEqual([
      "old",
      "new",
    ]);
  });
});

describe("isAgentCreatePending", () => {
  beforeEach(() => query.mockReset());

  it("matches an in-flight create for the workspace agent", async () => {
    query.mockResolvedValue({ rows: [{ pending: true }] });

    await expect(
      isAgentCreatePending("workspace", "daily-report"),
    ).resolves.toBe(true);

    expect(query.mock.calls[0]?.[0]).toMatch(
      /kind = 'create'[\s\S]*status IN \('submitted', 'pr_opened'\)/,
    );
    expect(query.mock.calls[0]?.[1]).toEqual(["workspace", "daily-report"]);
  });
});
