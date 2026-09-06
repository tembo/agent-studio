import { describe, expect, it } from "vitest";

import {
  extractJson,
  matchExplicitAgent,
  parseAgentMessage,
} from "./message-router";

describe("parseAgentMessage", () => {
  it("splits the first token as the agent, rest as input", () => {
    expect(parseAgentMessage("report generate the weekly summary")).toEqual({
      agentName: "report",
      input: "generate the weekly summary",
    });
  });

  it("handles an agent with no input", () => {
    expect(parseAgentMessage("report")).toEqual({ agentName: "report", input: "" });
    expect(parseAgentMessage("report   ")).toEqual({
      agentName: "report",
      input: "",
    });
  });

  it("returns an empty agent for blank text", () => {
    expect(parseAgentMessage("")).toEqual({ agentName: "", input: "" });
    expect(parseAgentMessage("   ")).toEqual({ agentName: "", input: "" });
  });

  it("preserves multi-line input", () => {
    expect(parseAgentMessage("triage line one\nline two")).toEqual({
      agentName: "triage",
      input: "line one\nline two",
    });
  });

  it("trims leading whitespace before the agent", () => {
    expect(parseAgentMessage("   support help")).toEqual({
      agentName: "support",
      input: "help",
    });
  });
});

describe("extractJson", () => {
  it("parses a bare JSON object", () => {
    expect(extractJson('{"agent":"report","input":"do it"}')).toEqual({
      agent: "report",
      input: "do it",
    });
  });

  it("parses JSON wrapped in prose / code fences", () => {
    const text = 'Sure! Here you go:\n```json\n{"agent":"triage","input":"x"}\n```';
    expect(extractJson(text)).toEqual({ agent: "triage", input: "x" });
  });

  it("returns null when there is no object", () => {
    expect(extractJson("no json here")).toBeNull();
    expect(extractJson("")).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(extractJson('{"agent": ,}')).toBeNull();
  });
});

describe("matchExplicitAgent", () => {
  const agents = [{ name: "weekly-report" }, { name: "support-triage" }];

  it("matches an agent name and removes it from the input", () => {
    expect(matchExplicitAgent(agents, "weekly-report summarize sales")).toEqual({
      agentName: "weekly-report",
      input: "summarize sales",
    });
  });

  it("matches case-insensitively for phone keyboard capitalization", () => {
    expect(matchExplicitAgent(agents, "Support-Triage ticket 42")).toEqual({
      agentName: "support-triage",
      input: "ticket 42",
    });
  });

  it("returns null when the first token is not an agent", () => {
    expect(matchExplicitAgent(agents, "summarize the latest tickets")).toBeNull();
  });
});
