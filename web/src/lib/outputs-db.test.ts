import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: { query } }));

import {
  decodeOutputCursor,
  getOutputForWorkspace,
  listOutputsForWorkspace,
  outputExcerpt,
} from "./outputs-db";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "10000000-0000-0000-0000-000000000001",
    workspace_id: "workspace-1",
    agent_name: "researcher",
    agent_path: "agents/researcher.yaml",
    model: "anthropic:claude-sonnet-5",
    trigger: "schedule",
    output: "# Daily report\nOnly this output contains the search term.",
    output_preview: "# Daily report\nOnly this output contains the search term.",
    created_by: "user-1",
    created_by_name: "Ada",
    created_by_email: "ada@example.com",
    created_at: new Date("2026-08-30T11:59:00Z"),
    started_at: new Date("2026-08-30T11:59:05Z"),
    completed_at: new Date("2026-08-30T12:00:00Z"),
    agent_version_id: "version-1",
    agent_version_label: "v3",
    operator_run_id: "operator-run-1",
    operator_name: "daily-operator",
    output_delivery: null,
    delivery_evidence: null,
    delivery_status: "undeclared",
    ...overrides,
  };
}

describe("outputs read model", () => {
  beforeEach(() => query.mockReset());

  it("uses full-text output search and a stable timestamp/id cursor", async () => {
    query.mockResolvedValue({ rows: [row()] });
    const cursor = Buffer.from(
      JSON.stringify({
        completedAt: "2026-08-30T12:00:00.000Z",
        id: "10000000-0000-0000-0000-000000000099",
      }),
    ).toString("base64url");

    await listOutputsForWorkspace("workspace-1", {
      search: "search term",
      cursor,
    });

    expect(query.mock.calls[0]?.[0]).toMatch(/r\.output_search @@ websearch_to_tsquery/);
    expect(query.mock.calls[0]?.[0]).toMatch(
      /\(r\.completed_at, r\.id\) < \(\$3, \$4::uuid\)/,
    );
    expect(query.mock.calls[0]?.[0]).toMatch(/r\.workspace_id = \$1/);
    expect(query.mock.calls[0]?.[1]).toEqual([
      "workspace-1",
      "search term",
      new Date("2026-08-30T12:00:00.000Z"),
      "10000000-0000-0000-0000-000000000099",
      31,
    ]);
  });

  it("rejects malformed cursors", () => {
    expect(decodeOutputCursor("not-a-cursor")).toBeNull();
  });

  it("carries the id in the next cursor when completion times tie", async () => {
    query.mockResolvedValue({
      rows: [
        row({ id: "10000000-0000-0000-0000-000000000002" }),
        row({ id: "10000000-0000-0000-0000-000000000001" }),
      ],
    });

    const page = await listOutputsForWorkspace("workspace-1", {}, 1);
    expect(page.items).toHaveLength(1);
    expect(decodeOutputCursor(page.nextCursor ?? undefined)).toEqual({
      completedAt: new Date("2026-08-30T12:00:00Z"),
      id: "10000000-0000-0000-0000-000000000002",
    });
  });

  it("turns Markdown into a readable list excerpt", () => {
    expect(
      outputExcerpt("# Daily report\n\n- Review the [renewal](https://example.com)."),
    ).toBe("Daily report Review the renewal.");
  });

  it("scopes detail lookup and every ancestor hop to the workspace", async () => {
    query.mockResolvedValue({ rows: [] });
    await expect(
      getOutputForWorkspace("workspace-1", "run-1"),
    ).resolves.toBeNull();

    expect(query.mock.calls[0]?.[0]).toMatch(/r\.workspace_id = \$1/);
    expect(query.mock.calls[0]?.[0]).toMatch(/parent\.workspace_id = \$1/);
    expect(query.mock.calls[0]?.[1]).toEqual(["workspace-1", "run-1"]);
  });

  it("keeps exact output and root-operator provenance on detail", async () => {
    query.mockResolvedValue({ rows: [row()] });

    await expect(
      getOutputForWorkspace("workspace-1", "run-1"),
    ).resolves.toMatchObject({
      output: "# Daily report\nOnly this output contains the search term.",
      agentName: "researcher",
      operatorName: "daily-operator",
      agentVersionLabel: "v3",
    });
  });
});
