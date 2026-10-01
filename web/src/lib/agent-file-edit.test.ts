import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { prepareAgentFileEdit } from "./agent-file-edit";
import { readEvalSuite } from "./agent-evals-run";

vi.mock("./agent-evals-run", () => ({ readEvalSuite: vi.fn() }));

const original = "name: hello\nmodel: anthropic:claude-sonnet-4-5\ninstructions: Say hello\n";
const content = original.replace("Say hello", "Say goodbye");
const args = {
  workspaceId: "ws", agentPath: "agents/pydantic-agentspec/hello.yaml",
  agentName: "hello", framework: "pydantic-agentspec", raw: original,
};
const edit = { kind: "spec" as const, content, originalContent: original };

beforeEach(() => vi.resetAllMocks());

describe("inline file edits", () => {
  it("preserves exact content and supplies a hash for the asynchronous write guard", async () => {
    const result = await prepareAgentFileEdit({ ...args, edit });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = JSON.parse(result.instruction.split("\n").at(-1)!);
    expect(data.path).toBe(args.agentPath);
    expect(data.expectedSha256).toBe(createHash("sha256").update(original).digest("hex"));
    expect(Buffer.from(data.contentBase64, "base64").toString()).toBe(content);
    expect(result.instruction).toContain("Do not promote");
  });

  it.each([
    ["invalid YAML", "["],
    ["invalid spec", "name: hello"],
    ["rename", content.replace("name: hello", "name: renamed")],
    ["empty content", ""],
    ["oversized content", "x".repeat(200_001)],
  ])("rejects %s", async (_, value) => {
    expect((await prepareAgentFileEdit({ ...args, edit: { ...edit, content: value } })).ok).toBe(false);
  });

  it("rejects stale source content", async () => {
    expect(await prepareAgentFileEdit({ ...args, raw: content, edit })).toEqual({
      ok: false, error: expect.stringContaining("changed since"),
    });
  });

  it("rejects no-op saves", async () => {
    expect((await prepareAgentFileEdit({ ...args, edit: { ...edit, content: original } })).ok).toBe(false);
  });

  it("does not create an absent eval file", async () => {
    vi.mocked(readEvalSuite).mockResolvedValue(null);
    expect(await prepareAgentFileEdit({ ...args, edit: { ...edit, kind: "eval" } })).toEqual({
      ok: false, error: "This agent has no eval file to edit.",
    });
  });

  it("allows repairing an invalid existing eval sidecar using its actual extension", async () => {
    vi.mocked(readEvalSuite).mockResolvedValue({
      ok: false, error: "invalid", detail: "invalid", path: "agents/pydantic-agentspec/hello.eval.json", content: "{",
    });
    const evalContent = JSON.stringify({ cases: [{ name: "greeting", input: "Hi", assert: { contains: "hello" } }] });
    const result = await prepareAgentFileEdit({ ...args, edit: { kind: "eval", originalContent: "{", content: evalContent } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.instruction).toContain("hello.eval.json");
    expect((await prepareAgentFileEdit({ ...args, edit: { kind: "eval", originalContent: "{", content: "cases: []" } })).ok).toBe(false);
  });

  it("rejects stale eval content", async () => {
    vi.mocked(readEvalSuite).mockResolvedValue({
      ok: false, error: "invalid", detail: "invalid", path: "hello.eval.yaml", content: "changed",
    });
    const result = await prepareAgentFileEdit({ ...args, edit: {
      kind: "eval", originalContent: "old",
      content: "cases:\n  - name: greeting\n    input: Hi\n    assert:\n      contains: hello\n",
    } });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("changed since") });
  });
});
