import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeWorkspace: vi.fn(),
  getWorkspaceRole: vi.fn(),
  startEvalRun: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock("@/lib/auth-server", () => ({
  authorizeWorkspace: mocks.authorizeWorkspace,
  DENIED_MESSAGE: "Denied.",
}));
vi.mock("@/lib/workspace", () => ({ getWorkspaceRole: mocks.getWorkspaceRole }));
vi.mock("@/lib/agent-evals-run", () => ({ startEvalRun: mocks.startEvalRun }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not found"); } }));

import { runAgentEvalsAction } from "./evals-actions";

function form(runAs?: string, version = "draft") {
  const data = new FormData();
  data.set("workspace", "acme");
  data.set("agent", "example");
  data.set("version", version);
  if (runAs !== undefined) data.set("run_as", runAs);
  return data;
}

function authorize(role = "workspace_admin") {
  mocks.authorizeWorkspace.mockResolvedValue({
    ok: true, workspace: { id: "ws" }, userId: "initiator", role,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  authorize();
  mocks.getWorkspaceRole.mockResolvedValue("operator");
  mocks.startEvalRun.mockResolvedValue({ ok: true, evalRun: { id: "eval" } });
});

describe("eval run-as authorization", () => {
  it.each(["draft", "stable"])("runs %s as a workspace member while retaining the initiator", async (version) => {
    expect(await runAgentEvalsAction({}, form(" member ", version))).toEqual({
      message: `Eval started against the ${version}.`,
    });
    expect(mocks.authorizeWorkspace).toHaveBeenCalledWith("acme", "operator");
    expect(mocks.getWorkspaceRole).toHaveBeenCalledWith("ws", "member");
    expect(mocks.startEvalRun).toHaveBeenCalledWith({
      workspaceId: "ws", userId: "initiator", runAsUserId: "member",
      agent: "example", version, source: "manual",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/acme/agents/example/versions");
  });

  it.each([undefined, "", "initiator"])("lets operators run as themselves (%s)", async (runAs) => {
    authorize("operator");
    await runAgentEvalsAction({}, form(runAs));
    expect(mocks.startEvalRun).toHaveBeenCalledWith(expect.objectContaining({
      userId: "initiator", runAsUserId: "initiator",
    }));
    expect(mocks.getWorkspaceRole).not.toHaveBeenCalled();
  });

  it("rejects an operator's forged run-as selection", async () => {
    authorize("operator");
    expect(await runAgentEvalsAction({}, form("member"))).toEqual({
      error: "Only workspace admins can run as another member.",
    });
    expect(mocks.getWorkspaceRole).not.toHaveBeenCalled();
    expect(mocks.startEvalRun).not.toHaveBeenCalled();
  });

  it("rejects a non-member or removed member", async () => {
    mocks.getWorkspaceRole.mockResolvedValue(null);
    expect(await runAgentEvalsAction({}, form("outsider"))).toEqual({
      error: "That user isn't a member of this workspace.",
    });
    expect(mocks.startEvalRun).not.toHaveBeenCalled();
  });

  it("rejects viewers before resolving the selected identity", async () => {
    mocks.authorizeWorkspace.mockResolvedValue({ ok: false, reason: "denied" });
    expect(await runAgentEvalsAction({}, form("member"))).toEqual({ error: "Denied." });
    expect(mocks.getWorkspaceRole).not.toHaveBeenCalled();
    expect(mocks.startEvalRun).not.toHaveBeenCalled();
  });

  it("returns connection errors without reporting a successful start", async () => {
    mocks.startEvalRun.mockResolvedValue({ ok: false, status: 422, error: "Missing connection" });
    expect(await runAgentEvalsAction({}, form("member"))).toEqual({ error: "Missing connection" });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
