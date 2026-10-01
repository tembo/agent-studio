import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthorizeApiSuccess } from "./api-auth";
import type { ResolvedDispatch } from "./workspace-agents";
vi.mock("@/lib/db", () => ({ db: { query: vi.fn() } }));
import { db } from "./db";
import { buildOutputReuseKey, outputReuseSchema } from "./output-reuse";
const ctx = { ok: true, apiKeyId: "key", surface: "api", workspace: { id: "workspace", name: "Test", slug: "test", createdBy: "user", createdAt: new Date(), updatedAt: new Date(), faviconKind: "default-tembo", commitMode: "pull_request" }, userId: "user", role: "operator", oauthScopes: ["read", "write"] } as AuthorizeApiSuccess;
const dispatch: ResolvedDispatch = { agentName: "reporter", agentPath: "agents/report.yaml", framework: "pydantic-agentspec", model: "model", specContent: "spec", specFormat: "yaml", versionId: "v1", versionLabel: "v1", connections: [] };
beforeEach(() => vi.mocked(db.query).mockResolvedValue({ rows: [{ scope: { member: { role: "operator" }, native: ["connection", "timestamp"] } }] } as never));
describe("output reuse keys", () => {
  it("is stable across scope and skill ordering", async () => {
    const key = await buildOutputReuseKey(ctx, { ...dispatch, skillsContent: { b: "2", a: "1" } }, "input", "report");
    expect(await buildOutputReuseKey({ ...ctx, oauthScopes: ["write", "read"] }, { ...dispatch, skillsContent: { a: "1", b: "2" } }, "input", "report")).toBe(key);
  });
  it("isolates workspace, acting user, role, scopes, input, report and execution contents", async () => {
    const base = await buildOutputReuseKey(ctx, dispatch, "input", "report");
    for (const patch of [{ workspace: { ...ctx.workspace, id: "other" } }, { userId: "other" }, { role: "viewer" as const }, { oauthScopes: ["read"] }]) {
      expect(await buildOutputReuseKey({ ...ctx, ...patch }, dispatch, "input", "report")).not.toBe(base);
    }
    for (const patch of [{ versionId: "v2" }, { agentName: "other" }, { model: "other" }, { specContent: "changed" }, { toolsModuleContent: "changed" }, { skillsContent: { a: "changed" } }]) {
      expect(await buildOutputReuseKey(ctx, { ...dispatch, ...patch }, "input", "report")).not.toBe(base);
    }
    expect(await buildOutputReuseKey(ctx, dispatch, "different", "report")).not.toBe(base);
    expect(await buildOutputReuseKey(ctx, dispatch, "input", "different")).not.toBe(base);
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [{ scope: { member: { role: "operator" }, native: ["connection", "new-timestamp"] } }] } as never);
    expect(await buildOutputReuseKey(ctx, dispatch, "input", "report")).not.toBe(base);
  });
  it.each([{reportType:"r", maxAgeSeconds:-1}, {reportType:"", maxAgeSeconds:1}, {reportType:"r", maxAgeSeconds:604801}, {reportType:"r", maxAgeSeconds:1.5}, {reportType:"r", maxAgeSeconds:10, allowFailed:true}])("rejects invalid policy %j", (policy) => {
    expect(outputReuseSchema.safeParse(policy).success).toBe(false);
  });
});
