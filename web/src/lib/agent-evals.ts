import YAML from "yaml";

// Sidecar eval suites live next to the agent spec as `<name>.eval.yaml`.
// They are not agent files — listAgents must skip them.

const EVAL_SIDECAR_RE = /\.eval\.(ya?ml|json)$/i;
const MAX_CASES = 20;
const MAX_NAME = 80;
const MAX_INPUT = 8000;
const MAX_RUBRIC = 4000;

export function isEvalSidecarFilename(filename: string): boolean {
  return EVAL_SIDECAR_RE.test(filename);
}

export function evalSidecarCandidates(agentPath: string): string[] {
  const stripped = agentPath.replace(/\.(ya?ml|json)$/i, "");
  return [
    `${stripped}.eval.yaml`,
    `${stripped}.eval.yml`,
    `${stripped}.eval.json`,
  ];
}

export type EvalAssert = {
  contains?: string[];
  notContains?: string[];
  regex?: string;
  equals?: string;
  maxChars?: number;
};

export type EvalJudge = {
  rubric: string;
};

export type EvalCase = {
  name: string;
  input: string;
  assert?: EvalAssert;
  judge?: EvalJudge;
};

export type EvalSuite = {
  cases: EvalCase[];
};

export type ParseEvalError =
  | "invalid-yaml"
  | "invalid-json"
  | "not-an-object"
  | "missing-cases"
  | "invalid-case";

export type ParseEvalResult =
  | { ok: true; suite: EvalSuite; format: "yaml" | "json" }
  | { ok: false; error: ParseEvalError; detail: string };

export function detectEvalFormat(
  filename: string,
): "yaml" | "json" | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".json")) return "json";
  return null;
}

export function parseEvalContent(
  content: string,
  format: "yaml" | "json",
): ParseEvalResult {
  let parsed: unknown;
  try {
    parsed = format === "yaml" ? YAML.parse(content) : JSON.parse(content);
  } catch (err) {
    return {
      ok: false,
      error: format === "yaml" ? "invalid-yaml" : "invalid-json",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "not-an-object", detail: "Eval file must be an object." };
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.cases)) {
    return {
      ok: false,
      error: "missing-cases",
      detail: "`cases` must be a non-empty array.",
    };
  }
  if (obj.cases.length === 0) {
    return {
      ok: false,
      error: "missing-cases",
      detail: "`cases` must be a non-empty array.",
    };
  }
  if (obj.cases.length > MAX_CASES) {
    return {
      ok: false,
      error: "invalid-case",
      detail: `At most ${MAX_CASES} eval cases are allowed.`,
    };
  }

  const cases: EvalCase[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < obj.cases.length; i++) {
    const raw = obj.cases[i];
    const parsedCase = parseCase(raw, i);
    if (!parsedCase.ok) return parsedCase;
    if (seen.has(parsedCase.case.name)) {
      return {
        ok: false,
        error: "invalid-case",
        detail: `Duplicate case name "${parsedCase.case.name}".`,
      };
    }
    seen.add(parsedCase.case.name);
    cases.push(parsedCase.case);
  }
  return { ok: true, suite: { cases }, format };
}

export function parseEvalFile(filename: string, content: string): ParseEvalResult {
  const format = detectEvalFormat(filename);
  if (!format) {
    return {
      ok: false,
      error: "invalid-yaml",
      detail: "Eval files must end in .yaml, .yml, or .json.",
    };
  }
  return parseEvalContent(content, format);
}

type ParseCaseResult =
  | { ok: true; case: EvalCase }
  | { ok: false; error: ParseEvalError; detail: string };

function parseCase(raw: unknown, index: number): ParseCaseResult {
  const prefix = `cases[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      error: "invalid-case",
      detail: `${prefix} must be an object.`,
    };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== "string" || !obj.name.trim()) {
    return {
      ok: false,
      error: "invalid-case",
      detail: `${prefix}.name must be a non-empty string.`,
    };
  }
  const name = obj.name.trim();
  if (name.length > MAX_NAME) {
    return {
      ok: false,
      error: "invalid-case",
      detail: `${prefix}.name is too long.`,
    };
  }
  if (typeof obj.input !== "string") {
    return {
      ok: false,
      error: "invalid-case",
      detail: `${prefix}.input must be a string.`,
    };
  }
  const input = obj.input;
  if (input.length > MAX_INPUT) {
    return {
      ok: false,
      error: "invalid-case",
      detail: `${prefix}.input is too long.`,
    };
  }
  const parsedAssert = parseAssert(obj.assert, prefix);
  if (!parsedAssert.ok) return parsedAssert;
  const parsedJudge = parseJudge(obj.judge, prefix);
  if (!parsedJudge.ok) return parsedJudge;
  if (!parsedAssert.assert && !parsedJudge.judge) {
    return {
      ok: false,
      error: "invalid-case",
      detail: `${prefix} needs \`assert\` or \`judge\`.`,
    };
  }
  return {
    ok: true,
    case: {
      name,
      input,
      assert: parsedAssert.assert,
      judge: parsedJudge.judge,
    },
  };
}

type ParseAssertResult =
  | { ok: true; assert?: EvalAssert }
  | { ok: false; error: ParseEvalError; detail: string };

function parseAssert(raw: unknown, prefix: string): ParseAssertResult {
  if (raw === undefined || raw === null) return { ok: true };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      error: "invalid-case",
      detail: `${prefix}.assert must be an object.`,
    };
  }
  const obj = raw as Record<string, unknown>;
  const result: EvalAssert = {};
  const contains = stringList(obj.contains);
  if (contains === false) {
    return {
      ok: false,
      error: "invalid-case",
      detail: `${prefix}.assert.contains must be a string or string array.`,
    };
  }
  if (contains) result.contains = contains;
  const notContains = stringList(obj.not_contains ?? obj.notContains);
  if (notContains === false) {
    return {
      ok: false,
      error: "invalid-case",
      detail: `${prefix}.assert.not_contains must be a string or string array.`,
    };
  }
  if (notContains) result.notContains = notContains;
  if (obj.regex !== undefined) {
    if (typeof obj.regex !== "string" || !obj.regex) {
      return {
        ok: false,
        error: "invalid-case",
        detail: `${prefix}.assert.regex must be a non-empty string.`,
      };
    }
    try {
      new RegExp(obj.regex);
    } catch {
      return {
        ok: false,
        error: "invalid-case",
        detail: `${prefix}.assert.regex is not a valid regular expression.`,
      };
    }
    result.regex = obj.regex;
  }
  if (obj.equals !== undefined) {
    if (typeof obj.equals !== "string") {
      return {
        ok: false,
        error: "invalid-case",
        detail: `${prefix}.assert.equals must be a string.`,
      };
    }
    result.equals = obj.equals;
  }
  const maxRaw = obj.max_chars ?? obj.maxChars;
  if (maxRaw !== undefined) {
    if (typeof maxRaw !== "number" || !Number.isInteger(maxRaw) || maxRaw < 1) {
      return {
        ok: false,
        error: "invalid-case",
        detail: `${prefix}.assert.max_chars must be a positive integer.`,
      };
    }
    result.maxChars = maxRaw;
  }
  if (
    !result.contains &&
    !result.notContains &&
    !result.regex &&
    result.equals === undefined &&
    result.maxChars === undefined
  ) {
    return {
      ok: false,
      error: "invalid-case",
      detail: `${prefix}.assert needs at least one check.`,
    };
  }
  return { ok: true, assert: result };
}

type ParseJudgeResult =
  | { ok: true; judge?: EvalJudge }
  | { ok: false; error: ParseEvalError; detail: string };

function parseJudge(raw: unknown, prefix: string): ParseJudgeResult {
  if (raw === undefined || raw === null) return { ok: true };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      error: "invalid-case",
      detail: `${prefix}.judge must be an object.`,
    };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.rubric !== "string" || !obj.rubric.trim()) {
    return {
      ok: false,
      error: "invalid-case",
      detail: `${prefix}.judge.rubric must be a non-empty string.`,
    };
  }
  const rubric = obj.rubric.trim();
  if (rubric.length > MAX_RUBRIC) {
    return {
      ok: false,
      error: "invalid-case",
      detail: `${prefix}.judge.rubric is too long.`,
    };
  }
  return { ok: true, judge: { rubric } };
}

function stringList(raw: unknown): string[] | undefined | false {
  if (raw === undefined) return undefined;
  if (typeof raw === "string") {
    const v = raw.trim();
    return v ? [v] : false;
  }
  if (Array.isArray(raw) && raw.every((v) => typeof v === "string")) {
    const values = raw.map((v) => v.trim()).filter(Boolean);
    return values.length ? values : false;
  }
  return false;
}

export function scoreAssert(
  output: string,
  assert: EvalAssert,
): { passed: boolean; reason: string } {
  const reasons: string[] = [];
  if (assert.contains) {
    for (const needle of assert.contains) {
      if (!output.toLowerCase().includes(needle.toLowerCase())) {
        reasons.push(`missing "${needle}"`);
      }
    }
  }
  if (assert.notContains) {
    for (const needle of assert.notContains) {
      if (output.toLowerCase().includes(needle.toLowerCase())) {
        reasons.push(`contained forbidden "${needle}"`);
      }
    }
  }
  if (assert.regex) {
    if (!new RegExp(assert.regex).test(output)) {
      reasons.push(`did not match /${assert.regex}/`);
    }
  }
  if (assert.equals !== undefined) {
    if (output.trim() !== assert.equals.trim()) {
      reasons.push("output did not equal the expected string");
    }
  }
  if (assert.maxChars !== undefined) {
    if (output.length > assert.maxChars) {
      reasons.push(`output is ${output.length} chars (max ${assert.maxChars})`);
    }
  }
  if (reasons.length > 0) {
    return { passed: false, reason: reasons.join("; ") };
  }
  return { passed: true, reason: "assertions passed" };
}
