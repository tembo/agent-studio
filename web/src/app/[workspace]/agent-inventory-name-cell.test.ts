import { describe, expect, it } from "vitest";

import type { InventoryAgent } from "./agents-inventory";
import { inventoryAgentSearchText } from "./agent-inventory-name-cell";

function liveAgent(
  description: string | null,
): Extract<InventoryAgent, { kind: "live" }> {
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
    pendingPromotion: null,
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
    expect(inventoryAgentSearchText(liveAgent(null))).toContain(
      "Daily Brief daily-brief daily-brief.yaml",
    );
  });

  it("makes pending drafts discoverable by promotion terms", () => {
    const agent = liveAgent(null);
    agent.pendingPromotion = {
      href: "/workspace/agents/daily-brief/versions",
      stableVersionNumber: 2,
      stableChangedAtIso: "2026-08-20T12:00:00.000Z",
      draftChangedAtIso: "2026-08-30T12:00:00.000Z",
      addedLines: 3,
      removedLines: 1,
    };

    expect(inventoryAgentSearchText(agent)).toContain(
      "unpromoted draft needs promotion",
    );
  });

  it("includes labels, model, and direct and inherited connections", () => {
    const agent = liveAgent(null);
    agent.labels = ["sales", "read-only"];
    agent.mcps = [{ slug: "attio", label: "Attio" }];
    agent.subMcps = [{ slug: "slack", label: "Slack" }];

    const haystack = inventoryAgentSearchText(agent).toLowerCase();

    expect(haystack).toContain("sales");
    expect(haystack).toContain("claude-sonnet-5");
    expect(haystack).toContain("attio");
    expect(haystack).toContain("slack");
  });
});
