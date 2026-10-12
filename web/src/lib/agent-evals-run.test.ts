import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveAgentForDispatch: vi.fn(),
  findMissingConnections: vi.fn(),
  insertEvalRun: vi.fn(),
  finishEvalRun: vi.fn(),
  getEvalRun: vi.fn(),
  markEvalRunning: vi.fn(),
  createRun: vi.fn(),
  getRun: vi.fn(),
}));
vi.mock("@/lib/workspace-agents", () => ({ resolveAgentForDispatch: mocks.resolveAgentForDispatch }));
vi.mock("@/lib/agent-source", () => ({ resolveAgentReader: vi.fn() }));
vi.mock("@/lib/agent-evals-judge", () => ({ scoreJudge: vi.fn() }));
vi.mock("@/lib/github", () => ({ postCommitStatus: vi.fn() }));
vi.mock("@/lib/workspace", () => ({
  getWorkspaceById: vi.fn(), getWorkspaceRepo: vi.fn(), getWorkspaceSecretPlaintext: vi.fn(),
}));
vi.mock("@/lib/connection-checks", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/connection-checks")>(),
  findMissingConnections: mocks.findMissingConnections,
}));
vi.mock("@/lib/agent-evals-db", () => ({
  insertEvalRun: mocks.insertEvalRun, finishEvalRun: mocks.finishEvalRun,
  getEvalRun: mocks.getEvalRun, markEvalRunning: mocks.markEvalRunning,
}));
vi.mock("@/lib/runs-api", () => ({ createRun: mocks.createRun, getRun: mocks.getRun }));

import { startEvalRun } from "./agent-evals-run";

const connections = [{ source: "native-mcp", toolkit: "github", name: "default" }];
const input = {
  workspaceId: "ws", userId: "initiator", agent: "example", source: "manual" as const,
  eval: JSON.stringify({ cases: [
    { name: "first", input: "hello", assert: { contains: "hello" } },
    { name: "second", input: "hello again", assert: { contains: "hello" } },
  ] }),
  evalFormat: "json" as const,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolveAgentForDispatch.mockResolvedValue({ ok: true, resolved: {
    agentName: "example", agentPath: "agents/example.yaml", framework: "pydantic-agentspec",
    model: "openai:gpt-5.5", specContent: "name: example", specFormat: "yaml",
    versionId: null, versionLabel: "draft", connections,
  } });
  mocks.findMissingConnections.mockResolvedValue([]);
  mocks.insertEvalRun.mockResolvedValue({ id: "eval" });
  mocks.createRun.mockResolvedValue({ runId: "run" });
  mocks.getRun.mockResolvedValue({ status: "succeeded", output: "hello" });
  mocks.getEvalRun.mockResolvedValue(null);
});

describe("eval credential identity", () => {
  it.each([undefined, "member"])("uses the selected identity (%s) for preflight and every case", async (runAsUserId) => {
    const result = await startEvalRun({ ...input, runAsUserId });
    expect(result.ok).toBe(true);
    expect(mocks.findMissingConnections).toHaveBeenCalledWith("ws", runAsUserId ?? "initiator", connections);
    expect(mocks.insertEvalRun).toHaveBeenCalledWith(expect.objectContaining({ createdBy: "initiator" }));
    await vi.waitFor(() => expect(mocks.finishEvalRun).toHaveBeenCalledWith(expect.objectContaining({
      status: "passed", passedCount: 2, failedCount: 0,
    })));
    expect(mocks.createRun).toHaveBeenCalledTimes(2);
    for (const [run] of mocks.createRun.mock.calls) {
      expect(run).toMatchObject({ workspaceId: "ws", userId: runAsUserId ?? "initiator", trigger: "eval" });
    }
  });

  it.each([
    [undefined, "You haven't connected"],
    ["member", "The selected member hasn't connected"],
  ])("reports missing connections for the correct identity (%s)", async (runAsUserId, subject) => {
    mocks.findMissingConnections.mockResolvedValue([
      { source: "native-mcp", toolkit: "github", name: "default", label: "GitHub" },
    ]);
    const result = await startEvalRun({ ...input, runAsUserId });
    expect(result).toEqual({ ok: false, status: 422, error: `${subject}: GitHub. Authorize under Connections, then run again.` });
    expect(mocks.insertEvalRun).not.toHaveBeenCalled();
    expect(mocks.createRun).not.toHaveBeenCalled();
  });
});
