import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AgentToolUsage, RunToolCall } from "@/lib/runs-db";

import { AgentDashboard } from "./agent-dashboard";
import { RunSteps } from "./runs/[runId]/run-steps";

function toolUsage(count: number): AgentToolUsage[] {
  return Array.from({ length: count }, (_, index) => ({
    toolName: `tool-${index + 1}`,
    calls: count - index,
    ok: count - index,
    failed: 0,
  }));
}

function toolCalls(count: number): RunToolCall[] {
  return Array.from({ length: count }, (_, index) => ({
    ordinal: index + 1,
    toolName: `tool-${index + 1}`,
    ok: index === count - 1 ? false : true,
    errorMessage: index === count - 1 ? "provider rejected the call" : null,
    stepOrdinal: 1,
  }));
}

describe("long tool lists", () => {
  it("summarizes agent tool usage after a five-item preview", () => {
    const markup = renderToStaticMarkup(
      <AgentDashboard
        stats={{
          totalRuns: 10,
          succeeded: 10,
          failed: 0,
          totalCostUsd: 1,
          avgDurationMs: 1000,
        }}
        daily={[]}
        failures={[]}
        toolUsage={toolUsage(7)}
        workspaceSlug="workspace"
        agentName="agent"
      />,
    );

    expect(markup).toContain("7 tools · 28 calls");
    expect(markup).toContain("Show 2 more tools");
    expect(markup).toMatch(/<details class="group">/);
    expect(markup).not.toMatch(/<details class="group" open=""/);
  });

  it("summarizes excess calls and failures within a run step", () => {
    const markup = renderToStaticMarkup(
      <RunSteps
        model="openai:gpt-5.5"
        steps={[
          {
            ordinal: 1,
            summary: "Calling tools",
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
          },
        ]}
        calls={toolCalls(7)}
      />,
    );

    expect(markup).toContain("Show 2 more of 7 tool calls · 1 failed");
    expect(markup).toMatch(/<details class="group mt-1">/);
    expect(markup).not.toMatch(/<details class="group mt-1" open=""/);
  });
});
