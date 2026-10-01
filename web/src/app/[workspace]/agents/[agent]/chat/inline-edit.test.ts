import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-server", () => ({ authorizeWorkspace: vi.fn(), DENIED_MESSAGE: "Denied" }));
vi.mock("@/lib/agent-lock", () => ({ isAgentLocked: vi.fn() }));
vi.mock("@/lib/agent-evals-run", () => ({ readEvalSuite: vi.fn() }));
vi.mock("@/lib/workspace-agents", () => ({ getAgentByName: vi.fn() }));
vi.mock("@/lib/workspace", () => ({ getWorkspaceRepo: vi.fn() }));
vi.mock("@/lib/tembo-credentials", () => ({ resolveTemboCredential: vi.fn() }));
vi.mock("@/lib/improvements-api", () => ({
  createImprovement: vi.fn(), improvementMarker: () => "marker",
  setImprovementCommitted: vi.fn(), setImprovementTask: vi.fn(),
}));
vi.mock("@/lib/prompt-connections", () => ({ buildPromptConnectionContext: vi.fn().mockResolvedValue({}) }));
vi.mock("@/lib/connection-checks", () => ({}));
vi.mock("@/lib/runs-api", () => ({}));
vi.mock("@/lib/cap-api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/cap-api")>(), createTemboTask: vi.fn(),
}));

import { chatSubmitAction } from "./actions";
import { authorizeWorkspace } from "@/lib/auth-server";
import { isAgentLocked } from "@/lib/agent-lock";
import { getAgentByName } from "@/lib/workspace-agents";
import { getWorkspaceRepo } from "@/lib/workspace";
import { resolveTemboCredential } from "@/lib/tembo-credentials";
import { createImprovement, setImprovementCommitted, setImprovementTask } from "@/lib/improvements-api";
import { createTemboTask } from "@/lib/cap-api";
import { parseAgentFile } from "@/lib/agent-format";

const raw = "name: hello\nmodel: anthropic:claude-sonnet-4-5\ninstructions: Say hello\n";
const path = "agents/pydantic-agentspec/hello.yaml";
const input = {
  workspaceSlug: "ws", agentName: "hello", message: "Inline spec file edit from Versions",
  fileEdit: { kind: "spec" as const, originalContent: raw, content: raw.replace("Say hello", "Say goodbye") },
};

beforeEach(() => {
  vi.clearAllMocks();
  // Only the fields read by this action are needed in these boundary tests.
  vi.mocked(authorizeWorkspace).mockResolvedValue({
    ok: true, workspace: { id: "ws", commitMode: "pull_request" }, userId: "user",
  } as Awaited<ReturnType<typeof authorizeWorkspace>>);
  vi.mocked(isAgentLocked).mockResolvedValue(false);
  vi.mocked(getAgentByName).mockResolvedValue({ agent: { ...parseAgentFile(path, raw), path }, raw } as Awaited<ReturnType<typeof getAgentByName>>);
  vi.mocked(getWorkspaceRepo).mockResolvedValue({ owner: "acme", name: "agents", defaultBranch: "main" } as Awaited<ReturnType<typeof getWorkspaceRepo>>);
  vi.mocked(resolveTemboCredential).mockResolvedValue({ apiKey: "key" } as Awaited<ReturnType<typeof resolveTemboCredential>>);
  vi.mocked(createImprovement).mockResolvedValue({ id: "edit" } as Awaited<ReturnType<typeof createImprovement>>);
  vi.mocked(createTemboTask).mockResolvedValue({ ok: true, result: { taskId: "task", title: "Inline edit", htmlUrl: "https://example.com/task", status: "queued" } });
});

describe("inline edit submission", () => {
  it("requires operator access before looking up or submitting a file", async () => {
    vi.mocked(authorizeWorkspace).mockResolvedValue({ ok: false, reason: "denied", actual: "viewer" });
    expect(await chatSubmitAction(input)).toEqual({ ok: false, error: "Denied" });
    expect(authorizeWorkspace).toHaveBeenCalledWith("ws", "operator");
    expect(getAgentByName).not.toHaveBeenCalled();
    expect(createTemboTask).not.toHaveBeenCalled();
  });

  it("blocks locked agents", async () => {
    vi.mocked(isAgentLocked).mockResolvedValue(true);
    expect(await chatSubmitAction(input)).toEqual({ ok: false, error: "This agent is locked." });
    expect(createImprovement).not.toHaveBeenCalled();
    expect(createTemboTask).not.toHaveBeenCalled();
  });

  it("does not submit invalid content", async () => {
    expect((await chatSubmitAction({ ...input, fileEdit: { ...input.fileEdit, content: "[" } })).ok).toBe(false);
    expect(createImprovement).not.toHaveBeenCalled();
    expect(createTemboTask).not.toHaveBeenCalled();
  });

  it("uses chat delivery and tracking for the validated draft edit", async () => {
    expect((await chatSubmitAction(input)).ok).toBe(true);
    expect(createImprovement).toHaveBeenCalledWith(expect.objectContaining({ delivery: "pull_request", agentPath: path }));
    expect(createTemboTask).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({
      targetBranch: "main", prompt: expect.stringContaining("contentBase64"),
    }) }));
    expect(setImprovementTask).toHaveBeenCalled();
    expect(setImprovementCommitted).not.toHaveBeenCalled();
  });

  it("honors direct delivery and tracks the submitted task", async () => {
    vi.mocked(authorizeWorkspace).mockResolvedValue({
      ok: true, workspace: { id: "ws", commitMode: "direct" }, userId: "user",
    } as Awaited<ReturnType<typeof authorizeWorkspace>>);
    expect((await chatSubmitAction(input)).ok).toBe(true);
    expect(createImprovement).toHaveBeenCalledWith(expect.objectContaining({ delivery: "direct" }));
    expect(setImprovementCommitted).toHaveBeenCalled();
    expect(setImprovementTask).not.toHaveBeenCalled();
  });

  it("returns a submission failure without reporting success", async () => {
    vi.mocked(createTemboTask).mockResolvedValue({ ok: false, error: { kind: "network", message: "offline" } });
    expect(await chatSubmitAction(input)).toEqual({ ok: false, error: expect.stringContaining("offline") });
    expect(setImprovementTask).not.toHaveBeenCalled();
    expect(setImprovementCommitted).not.toHaveBeenCalled();
  });

});
