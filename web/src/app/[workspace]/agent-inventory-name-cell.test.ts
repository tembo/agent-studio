import { describe, expect, it } from "vitest";

import type { InventoryAgent } from "./agents-inventory";
import { inventoryAgentSearchText } from "./agent-inventory-name-cell";

function liveAgent(description: string | null): InventoryAgent {
  return {
    kind: "live",
    path: "agents/pydantic-agentspec/daily-brief.yaml",
    filename: "daily-brief.yaml",
    name: "daily-brief",
    displayName: "Daily Brief",
    description,
    detailHref: "/workspace/agents/daily-brief",
    frameworkLabel: "Pydantic",
    labels: [],
    mcps: [],
    subMcps: [],
    model: "anthropic:claude-sonnet-5",
    runs30d: 0,
    succeeded30d: 0,
    failed30d: 0,
    avgCostUsd30d: null,
    lastRun: null,
    isStarred: false,
    isMine: true,
  };
}

describe("inventoryAgentSearchText", () => {
  it("includes the agent description", () => {
    const haystack = inventoryAgentSearchText(
      liveAgent("Summarizes project activity for the morning."),
    );

    expect(haystack.toLowerCase()).toContain("project activity");
  });

  it("preserves the existing searchable identity when no description exists", () => {
    expect(inventoryAgentSearchText(liveAgent(null))).toBe(
      "Daily Brief daily-brief daily-brief.yaml",
    );
  });
});
