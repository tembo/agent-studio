import { describe, expect, it } from "vitest";

import {
  evalSidecarCandidates,
  isEvalSidecarFilename,
  parseEvalContent,
  scoreAssert,
} from "@/lib/agent-evals";

describe("eval sidecar filenames", () => {
  it("recognizes colocated eval files", () => {
    expect(isEvalSidecarFilename("hello-world.eval.yaml")).toBe(true);
    expect(isEvalSidecarFilename("hello-world.eval.yml")).toBe(true);
    expect(isEvalSidecarFilename("hello-world.eval.json")).toBe(true);
    expect(isEvalSidecarFilename("hello-world.yaml")).toBe(false);
    expect(isEvalSidecarFilename("AGENT_GUIDE.md")).toBe(false);
  });

  it("maps an agent path to sidecar candidates", () => {
    expect(evalSidecarCandidates("agents/pydantic-agentspec/hello-world.yaml")).toEqual([
      "agents/pydantic-agentspec/hello-world.eval.yaml",
      "agents/pydantic-agentspec/hello-world.eval.yml",
      "agents/pydantic-agentspec/hello-world.eval.json",
    ]);
  });
});

describe("parseEvalContent", () => {
  it("parses assertion and judge cases", () => {
    const r = parseEvalContent(
      `cases:
  - name: greets
    input: Hello
    assert:
      contains: hello
      not_contains: [bye]
      max_chars: 400
  - name: tone
    input: Hey
    judge:
      rubric: Friendly greeting.
`,
      "yaml",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suite.cases).toEqual([
      {
        name: "greets",
        input: "Hello",
        assert: {
          contains: ["hello"],
          notContains: ["bye"],
          maxChars: 400,
        },
        judge: undefined,
      },
      {
        name: "tone",
        input: "Hey",
        assert: undefined,
        judge: { rubric: "Friendly greeting." },
      },
    ]);
  });

  it("rejects a case with neither assert nor judge", () => {
    const r = parseEvalContent(
      `cases:
  - name: noop
    input: hi
`,
      "yaml",
    );
    expect(r).toMatchObject({ ok: false, error: "invalid-case" });
  });

  it("rejects duplicate case names", () => {
    const r = parseEvalContent(
      `cases:
  - name: greets
    input: a
    assert:
      contains: a
  - name: greets
    input: b
    assert:
      contains: b
`,
      "yaml",
    );
    expect(r).toMatchObject({ ok: false, error: "invalid-case" });
  });

  it("rejects an invalid regex", () => {
    const r = parseEvalContent(
      `cases:
  - name: bad
    input: x
    assert:
      regex: "("
`,
      "yaml",
    );
    expect(r).toMatchObject({ ok: false, error: "invalid-case" });
  });
});

describe("scoreAssert", () => {
  it("passes when all checks hold", () => {
    expect(
      scoreAssert("Hello there", {
        contains: ["hello"],
        notContains: ["bye"],
        maxChars: 20,
      }),
    ).toEqual({ passed: true, reason: "assertions passed" });
  });

  it("fails with combined reasons", () => {
    const r = scoreAssert("Goodbye friend", {
      contains: ["hello"],
      notContains: ["bye"],
    });
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('missing "hello"');
    expect(r.reason).toContain('contained forbidden "bye"');
  });

  it("matches regex and equals", () => {
    expect(scoreAssert("Hi\n", { equals: "Hi" }).passed).toBe(true);
    expect(scoreAssert("status: ok", { regex: "status:\\s+ok" }).passed).toBe(
      true,
    );
    expect(scoreAssert("nope", { regex: "status:\\s+ok" }).passed).toBe(false);
  });
});
