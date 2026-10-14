import { describe, expect, it } from "vitest";

import {
  draftEvalBlocksPromote,
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
    expect(
      evalSidecarCandidates("agents/pydantic-agentspec/hello-world.yaml"),
    ).toEqual([
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
  it("handles catastrophic-backtracking patterns without blocking", () => {
    expect(
      scoreAssert("a".repeat(100_000) + "!", { regex: "^(a+)+$" }).passed,
    ).toBe(false);
    expect(
      scoreAssert("a".repeat(100_000) + "!", { regex: "(a|aa)+$" }).passed,
    ).toBe(false);
  });

  it.each(["(?=x)x", "(?<=x)y", "(x)\\1", "(", "a".repeat(2001)])(
    "rejects unsupported or oversized patterns: %.30s",
    (regex) => {
      const parsed = parseEvalContent(
        JSON.stringify({
          cases: [{ name: "invalid", input: "x", assert: { regex } }],
        }),
        "json",
      );
      expect(parsed).toMatchObject({ ok: false, error: "invalid-case" });
      // Old queued suites can reach the scorer without being reparsed.
      expect(scoreAssert("xx", { regex }).passed).toBe(false);
    },
  );

  it("retains search, anchor, and character-class semantics", () => {
    expect(
      scoreAssert("prefix status: 123 suffix", { regex: "status:\\s+\\d+" })
        .passed,
    ).toBe(true);
    expect(
      scoreAssert("prefix status: 123", { regex: "^status:" }).passed,
    ).toBe(false);
    expect(scoreAssert("Hello", { regex: "hello" }).passed).toBe(false);
  });
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

describe("draftEvalBlocksPromote", () => {
  const hash = "abc123";

  it("does not block agents without an eval file", () => {
    expect(
      draftEvalBlocksPromote({
        hasEvalFile: false,
        latest: null,
        draftSpecHash: hash,
      }),
    ).toBeNull();
  });

  it("blocks when the draft has not been eval'd", () => {
    expect(
      draftEvalBlocksPromote({
        hasEvalFile: true,
        latest: null,
        draftSpecHash: hash,
      }),
    ).toMatch(/Run evals on this draft/);
  });

  it("blocks a stale passing eval after the draft changes", () => {
    expect(
      draftEvalBlocksPromote({
        hasEvalFile: true,
        latest: {
          status: "passed",
          specHash: "old",
          agentVersionLabel: "draft",
        },
        draftSpecHash: hash,
      }),
    ).toMatch(/Run evals on this draft/);
  });

  it("blocks assertion failures", () => {
    expect(
      draftEvalBlocksPromote({
        hasEvalFile: true,
        latest: {
          status: "failed",
          specHash: hash,
          agentVersionLabel: "draft",
        },
        draftSpecHash: hash,
      }),
    ).toMatch(/assertions failed/);
  });

  it("allows promote when draft assertions passed", () => {
    expect(
      draftEvalBlocksPromote({
        hasEvalFile: true,
        latest: {
          status: "passed",
          specHash: hash,
          agentVersionLabel: "draft",
        },
        draftSpecHash: hash,
      }),
    ).toBeNull();
  });
});
