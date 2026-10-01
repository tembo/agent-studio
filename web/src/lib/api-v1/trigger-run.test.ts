import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiCtx } from "./actions";
vi.mock("@/lib/workspace-agents", () => ({ resolveAgentForDispatch: vi.fn() }));
vi.mock("@/lib/connection-checks", () => ({ findMissingConnections: vi.fn(), missingConnectionsMessage: () => "Connect account" }));
vi.mock("@/lib/runs-api", () => ({ createRun: vi.fn() }));
vi.mock("@/lib/output-reuse", async (original) => ({ ...await original<typeof import("@/lib/output-reuse")>(), buildOutputReuseKey: vi.fn() }));
import { triggerRun } from "./trigger-run";
import { resolveAgentForDispatch } from "@/lib/workspace-agents";
import { findMissingConnections } from "@/lib/connection-checks";
import { createRun } from "@/lib/runs-api";
import { buildOutputReuseKey } from "@/lib/output-reuse";
const ctx = { workspace: { id: "workspace" }, userId: "user" } as ApiCtx;
const resolved = { agentName: "reporter", agentPath: "agent.yaml", framework: "pydantic-agentspec" as const, model: "model", specContent: "spec", specFormat: "yaml" as const, versionId: "version", versionLabel: "v1", connections: [] };
const outputReuse = { reportType: "report", maxAgeSeconds: 300 };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveAgentForDispatch).mockResolvedValue({ ok: true, resolved });
  vi.mocked(findMissingConnections).mockResolvedValue([]);
  vi.mocked(buildOutputReuseKey).mockResolvedValue("a".repeat(64));
  vi.mocked(createRun).mockResolvedValue({ runId: "child", reusedFromRunId: "original" });
});
describe("triggerRun reuse", () => {
  it("passes policy and parent to the runtime and returns original provenance", async () => {
    expect(await triggerRun(ctx, { agent: "reporter", message: "input", orchestratorRunId: "parent", outputReuse })).toEqual({ ok: true, runId: "child", reusedFromRunId: "original" });
    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({ userId: "user", workspaceId: "workspace", orchestratorRunId: "parent", outputReuse: { key: "a".repeat(64), ...outputReuse } }));
  });
  it("forces fresh execution without changing the cache key", async () => {
    await triggerRun(ctx, { agent: "reporter", outputReuse: { ...outputReuse, requireFresh: true } });
    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({ outputReuse: expect.objectContaining({ maxAgeSeconds: 0 }) }));
  });
  it("keeps normal calls opt-out", async () => {
    await triggerRun(ctx, { agent: "reporter" });
    expect(buildOutputReuseKey).not.toHaveBeenCalled();
    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({ outputReuse: undefined }));
  });
  it("never enables reuse for draft versions", async () => {
    vi.mocked(resolveAgentForDispatch).mockResolvedValue({ ok: true, resolved: { ...resolved, versionId: null, versionLabel: "draft" } });
    await triggerRun(ctx, { agent: "reporter", outputReuse });
    expect(buildOutputReuseKey).not.toHaveBeenCalled();
  });
  it("falls back to normal execution if authorization snapshot fails", async () => {
    vi.mocked(buildOutputReuseKey).mockRejectedValue(new Error("DB unavailable"));
    await triggerRun(ctx, { agent: "reporter", outputReuse });
    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({ outputReuse: undefined }));
  });
  it("checks current connections before any reuse", async () => {
    vi.mocked(findMissingConnections).mockResolvedValue([{ toolkit: "slack", name: "default" }] as never);
    expect(await triggerRun(ctx, { agent: "reporter", outputReuse })).toMatchObject({ ok: false, status: 422 });
    expect(buildOutputReuseKey).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
  });
});
