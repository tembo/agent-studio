import { readFileSync } from "node:fs";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import catalog from "./model-capabilities.json";
import { effortSupport, effortLabel, readModelEffort, setModelEffort } from "./model-effort";

const source = `# keep this comment
name: example-agent
model: anthropic:claude-sonnet-5
instructions: Be helpful.
model_settings:
  max_tokens: 4096 # keep this budget
  temperature: 0.2
`;

describe("effort catalog", () => {
  it("keeps canonical and web catalogs identical and model IDs unique", () => {
    expect(catalog).toEqual(JSON.parse(readFileSync(new URL("../../../api/src/model-capabilities.json", import.meta.url), "utf8")));
    const names = catalog.effort.flatMap((r) => r.models);
    expect(new Set(names).size).toBe(names.length);
    for (const row of catalog.effort) {
      expect(row.levels).toContain(row.default);
      expect(new Set(row.levels).size).toBe(row.levels.length);
      expect(row.source).toMatch(/^https:\/\/(platform\.claude\.com|developers\.openai\.com)\//);
    }
  });
  it("does not infer effort support from family names", () => {
    expect(effortSupport("anthropic:claude-sonnet-6")).toBeNull();
    expect(effortSupport("openai:gpt-5.5-pro")).toBeNull();
    expect(effortSupport("anthropic:claude-sonnet-4-6")?.levels).toEqual(["low", "medium", "high", "max"]);
    expect(effortSupport("anthropic:claude-sonnet-5")?.levels).toContain("xhigh");
    expect(effortSupport("openai:gpt-5.1")?.levels).not.toContain("xhigh");
  });
  it("includes Haiku 5.5 with five effort levels and the Medium default", () => {
    const haiku = effortSupport("anthropic:claude-haiku-5-5");
    expect(haiku?.levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(haiku?.default).toBe("medium");
  });
});

describe("effort edits", () => {
  it("preserves YAML comments and unrelated settings", () => {
    const edited = setModelEffort(source, "yaml", "medium");
    expect(edited).toContain("# keep this comment");
    expect(edited).toContain("# keep this budget");
    const spec = YAML.parse(edited);
    expect(spec.model_settings).toEqual({ max_tokens: 4096, temperature: 0.2, anthropic_effort: "medium" });
    expect(spec.instructions).toBe("Be helpful.");
  });
  it("uses the OpenAI key and preserves JSON output", () => {
    const spec = { name: "example-agent", model: "openai:gpt-5.5", instructions: "Hello", model_settings: { max_tokens: 4096 } };
    const edited = JSON.parse(setModelEffort(JSON.stringify(spec), "json", "xhigh"));
    expect(edited.model_settings).toEqual({ max_tokens: 4096, openai_reasoning_effort: "xhigh" });
  });
  it("provider default removes only the explicit effort override", () => {
    const edited = setModelEffort(setModelEffort(source, "yaml", "low"), "yaml", "");
    expect(YAML.parse(edited).model_settings).toEqual({ max_tokens: 4096, temperature: 0.2 });
    expect(effortLabel(YAML.parse(edited))).toBe("Provider default (High)");
  });
  it("distinguishes none from provider default", () => {
    const spec = { model: "openai:gpt-5.5", instructions: "Hello", model_settings: { openai_reasoning_effort: "none" } };
    expect(effortLabel(spec)).toBe("None");
    expect(effortLabel({ model: spec.model })).toBe("Provider default (Medium)");
  });
  it("can add settings when no map exists", () => {
    expect(YAML.parse(setModelEffort("name: example-agent\nmodel: anthropic:claude-sonnet-5\ninstructions: Hello\n", "yaml", "high")).model_settings).toEqual({ anthropic_effort: "high" });
    expect(YAML.parse(setModelEffort("name: example-agent\nmodel: anthropic:claude-sonnet-5\ninstructions: Hello\nmodel_settings: null\n", "yaml", "low")).model_settings).toEqual({ anthropic_effort: "low" });
  });
  it.each([
    { thinking: "high" },
    { anthropic_effort: "future-value" },
    { anthropic_thinking: { type: "disabled" } },
    { extra_body: { output_config: { effort: "low" } } },
    { extra_body: { reasoning: { effort: "low" } } },
  ])("preserves advanced settings and refuses to override them: %j", (model_settings) => {
    const spec = { model: "anthropic:claude-sonnet-5", instructions: "Hello", model_settings };
    expect(readModelEffort(spec).custom).toBe(true);
    expect(() => setModelEffort(JSON.stringify(spec), "json", "medium")).toThrow(/custom thinking/);
  });
  it("rejects an unsupported effort without generating an invalid spec", () => {
    expect(() => setModelEffort(source.replace("claude-sonnet-5", "claude-sonnet-4-6"), "yaml", "xhigh")).toThrow(/not supported/);
    expect(() => setModelEffort(source.replace("claude-sonnet-5", "claude-sonnet-unknown"), "yaml", "high")).toThrow(/No verified/);
  });
});
