import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: { query } }));

import { listRunsForWorkspace } from "./run-list-db";

const runRow = {
  // PostgreSQL accepts UUID-shaped IDs that do not encode RFC version or
  // variant bits, and fixtures/local runs use them.
  id: "00000000-0000-0000-0000-000000004273",
  agent_name: "daily-digest",
  status: "succeeded",
  trigger: "manual",
  automation_id: null,
  created_at: new Date("2026-08-30T12:00:00Z"),
  started_at: new Date("2026-08-30T12:00:01Z"),
  completed_at: new Date("2026-08-30T12:00:02Z"),
  user_message: "Summarize this morning's updates",
  failure_summary: null,
  cost_usd: "0.0125",
  created_by_name: "Ada Lovelace",
  created_by_email: "ada@example.com",
  slack_app_name: null,
  slack_user_id: null,
  slack_permalink: null,
  slack_channel: null,
  agent_version_label: "v3",
};

describe("listRunsForWorkspace", () => {
  beforeEach(() => query.mockReset());

  it("uses one query when no search text is present and maps the row", async () => {
    query.mockResolvedValueOnce({ rows: [runRow] });

    await expect(
      listRunsForWorkspace("workspace-1", { statuses: ["succeeded"] }),
    ).resolves.toMatchObject([
      {
        id: runRow.id,
        agentName: "daily-digest",
        userMessagePreview: "Summarize this morning's updates",
        costUsd: 0.0125,
        createdByName: "Ada Lovelace",
      },
    ]);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([
      "workspace-1",
      ["succeeded"],
      50,
    ]);
  });

  it("combines indexed text and matching Run as identities", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: "user-ada" }] })
      .mockResolvedValueOnce({ rows: [] });

    await listRunsForWorkspace(
      "workspace-1",
      {
        statuses: ["failed"],
        agentName: "daily-digest",
        triggers: ["schedule"],
        search: "Ada",
      },
      { before: new Date("2026-08-31T00:00:00Z") },
    );

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toMatch(
      /name ILIKE \$1[\s\S]*email ILIKE \$1/,
    );
    expect(query.mock.calls[0]?.[1]).toEqual(["%Ada%"]);

    const [sql, params] = query.mock.calls[1] ?? [];
    expect(sql).toContain(`r.agent_name || E'\n'`);
    expect(sql).toContain("COALESCE(r.output, '')");
    expect(sql).toContain("r.created_by = ANY($6::text[])");
    expect(params).toEqual([
      "workspace-1",
      ["failed"],
      "daily-digest",
      ["schedule"],
      "%Ada%",
      ["user-ada"],
      new Date("2026-08-31T00:00:00Z"),
      50,
    ]);
  });

  it("matches a full run UUID exactly in addition to searchable text", async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await listRunsForWorkspace("workspace-1", { search: runRow.id });

    expect(query.mock.calls[1]?.[0]).toContain("r.id = $3::uuid");
    expect(query.mock.calls[1]?.[1]).toEqual([
      "workspace-1",
      `%${runRow.id}%`,
      runRow.id,
      50,
    ]);
  });

  it("escapes LIKE wildcards for identity and run-text searches", async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await listRunsForWorkspace("workspace-1", { search: String.raw`50%_off\now` });

    const escaped = String.raw`%50\%\_off\\now%`;
    expect(query.mock.calls[0]?.[1]).toEqual([escaped]);
    expect(query.mock.calls[1]?.[1]).toEqual(["workspace-1", escaped, 50]);
    expect(query.mock.calls[1]?.[0]).toContain("ESCAPE '\\'");
  });
});
