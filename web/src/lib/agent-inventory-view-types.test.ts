import { describe, expect, it } from "vitest";

import {
  matchesAgentRelationshipFilters,
  normalizeAgentInventoryFilters,
} from "./agent-inventory-view-types";

describe("agent inventory saved-view filters", () => {
  it("keeps the supported filter fields", () => {
    expect(
      normalizeAgentInventoryFilters({
        query: "  daily reports  ",
        membership: "mine",
        status: "error",
        promotionOnly: true,
        label: "finance",
        model: "openai:gpt-5",
        mcp: "github",
        agentType: "sub-agent",
        orchestrator: "daily-briefing",
        sort: "cost",
      }),
    ).toEqual({
      query: "daily reports",
      membership: "mine",
      status: "error",
      promotionOnly: true,
      label: "finance",
      model: "openai:gpt-5",
      mcp: "github",
      agentType: "sub-agent",
      orchestrator: "daily-briefing",
      sort: "cost",
    });
  });

  it("drops unsupported and malformed values", () => {
    expect(
      normalizeAgentInventoryFilters({
        membership: "team",
        status: "broken",
        promotionOnly: "yes",
        agentType: "operator",
        sort: "expensive",
      }),
    ).toMatchObject({
      membership: "all",
      status: null,
      promotionOnly: false,
      agentType: "",
      sort: "last-run",
    });
  });
});

describe("agent inventory relationship filters", () => {
  const nestedAgent = {
    kind: "live",
    subAgentNames: ["writer"],
    orchestratorNames: ["daily-briefing"],
  };

  it("lets a nested agent match both derived roles", () => {
    expect(matchesAgentRelationshipFilters(nestedAgent, "orchestrator", "")).toBe(
      true,
    );
    expect(matchesAgentRelationshipFilters(nestedAgent, "sub-agent", "")).toBe(
      true,
    );
  });

  it("scopes sub-agents to the selected orchestrator", () => {
    expect(
      matchesAgentRelationshipFilters(nestedAgent, "", "daily-briefing"),
    ).toBe(true);
    expect(matchesAgentRelationshipFilters(nestedAgent, "", "other")).toBe(
      false,
    );
  });

  it("excludes non-live inventory rows from relationship views", () => {
    expect(
      matchesAgentRelationshipFilters({ kind: "pending-create" }, "sub-agent", ""),
    ).toBe(false);
  });
});
