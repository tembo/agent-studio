import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/api-auth", () => ({ authorizeApiRequest: mocks.auth }));
vi.mock("@/lib/api-v1/actions", () => ({ triggerRun: vi.fn() }));
vi.mock("@/lib/runs-db", () => ({ listRunsForWorkspace: mocks.list }));
vi.mock("@/lib/api-v1/serializers", () => ({ serializeRunListItem: (row: { id: string }) => ({ id: row.id }) }));

import { GET } from "./route";
import { encodeRunCursor } from "@/lib/run-list-cursor";
const cursor = encodeRunCursor("2026-10-01T12:00:00.123456", "00000000-0000-0000-0000-000000000001");
const request = (query = "") => new NextRequest(`http://localhost/api/v1/runs${query}`);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ ok: true, workspace: { id: "acme" } });
  mocks.list.mockResolvedValue([]);
});

describe("run list cursors", () => {
  it("requires authorization before fetching runs", async () => {
    mocks.auth.mockResolvedValue({ ok: false, status: 401, error: "Unauthorized" });
    expect((await GET(request())).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it.each(["?cursor=bad", "?cursor=", `?cursor=${cursor}&before=2026-10-01`])("rejects invalid or conflicting cursor input %s", async (query) => {
    expect((await GET(request(query))).status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("passes an opaque cursor unchanged and returns the next cursor", async () => {
    mocks.list.mockResolvedValue([{ id: "run-1", cursor }]);
    const response = await GET(request(`?cursor=${cursor}&limit=25`));
    expect(mocks.list).toHaveBeenCalledWith("acme", {}, { cursor, limit: 25 });
    expect(await response.json()).toEqual({ runs: [{ id: "run-1" }], next_cursor: cursor });
  });
  it("returns null after the final page", async () => {
    expect(await (await GET(request())).json()).toEqual({ runs: [], next_cursor: null });
  });
  it("continues to accept the existing before filter", async () => {
    expect((await GET(request("?before=2026-10-01T00:00:00Z"))).status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith("acme", {}, { before: new Date("2026-10-01T00:00:00Z") });
  });
});
