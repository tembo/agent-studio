import { describe, expect, it } from "vitest";

import {
  defaultAgentInventoryFilterOperators,
  matchesAgentInventoryValues,
  matchesAgentOwnershipFilters,
  matchesAgentRelationshipFilters,
  normalizeAgentInventoryFilters,
} from "./agent-inventory-view-types";

describe("agent inventory saved-view filters", () => {
  it("keeps the supported filter fields", () => {
    expect(
      normalizeAgentInventoryFilters({
        query: "  daily reports  ",
        owner: ["me", "others", "me"],
        starred: [false, true],
        status: ["error", "idle"],
        promotionOnly: true,
        label: ["finance", "research"],
        model: ["openai:gpt-5", "anthropic:claude-sonnet-5"],
        mcp: ["github", "slack"],
        agentType: ["sub-agent", "orchestrator"],
        orchestrator: ["daily-briefing", "weekly-review"],
        operators: { status: "is-not", label: "unsupported" },
        sort: "cost",
      }),
    ).toEqual({
      query: "daily reports",
      owner: ["me", "others"],
      starred: [false, true],
      status: ["error", "idle"],
      promotionOnly: true,
      label: ["finance", "research"],
      model: ["openai:gpt-5", "anthropic:claude-sonnet-5"],
      mcp: ["github", "slack"],
      agentType: ["sub-agent", "orchestrator"],
      orchestrator: ["daily-briefing", "weekly-review"],
      operators: {
        ...defaultAgentInventoryFilterOperators(),
        status: "is-not",
      },
      sort: "cost",
    });
  });

  it("drops unsupported and malformed values", () => {
    expect(
      normalizeAgentInventoryFilters({
        owner: "team",
        starred: "yes",
        status: "broken",
        promotionOnly: "yes",
        agentType: "operator",
        sort: "expensive",
      }),
    ).toMatchObject({
      owner: [],
      starred: [],
      status: [],
      promotionOnly: false,
      agentType: [],
      sort: "last-run",
    });
  });

  it("upgrades scalar values from existing saved views", () => {
    expect(
      normalizeAgentInventoryFilters({
        owner: "me",
        starred: false,
        status: "error",
        label: "finance",
        agentType: "sub-agent",
      }),
    ).toMatchObject({
      owner: ["me"],
      starred: [false],
      status: ["error"],
      label: ["finance"],
      agentType: ["sub-agent"],
    });
  });
});

describe("agent inventory multi-value operators", () => {
  it("matches any selected value for is", () => {
    expect(matchesAgentInventoryValues(["idle"], ["active", "idle"], "is"))
      .toBe(true);
    expect(matchesAgentInventoryValues(["error"], ["active", "idle"], "is"))
      .toBe(false);
  });

  it("excludes any selected value for is not", () => {
    expect(
      matchesAgentInventoryValues(["finance"], ["finance", "legal"], "is-not"),
    ).toBe(false);
    expect(
      matchesAgentInventoryValues(["research"], ["finance", "legal"], "is-not"),
    ).toBe(true);
  });
});

describe("agent inventory owner and star filters", () => {
  const mine = { kind: "live", isMine: true, isStarred: false };
  const theirs = { kind: "live", isMine: false, isStarred: true };

  it("filters ownership and stars independently", () => {
    const operators = { owner: "is" as const, starred: "is" as const };
    expect(matchesAgentOwnershipFilters(mine, ["me"], [], operators)).toBe(true);
    expect(matchesAgentOwnershipFilters(theirs, ["me"], [], operators)).toBe(
      false,
    );
    expect(
      matchesAgentOwnershipFilters(theirs, ["others"], [true], operators),
    ).toBe(true);
    expect(
      matchesAgentOwnershipFilters(theirs, ["others"], [false], operators),
    ).toBe(false);
  });

  it("supports multiselect and is not independently", () => {
    expect(
      matchesAgentOwnershipFilters(mine, ["me", "others"], [], {
        owner: "is",
        starred: "is",
      }),
    ).toBe(true);
    expect(
      matchesAgentOwnershipFilters(theirs, ["me"], [], {
        owner: "is-not",
        starred: "is",
      }),
    ).toBe(true);
  });

  it("excludes non-live rows when either filter is active", () => {
    expect(
      matchesAgentOwnershipFilters({ kind: "invalid" }, ["me"], [], {
        owner: "is",
        starred: "is",
      }),
    ).toBe(false);
    expect(
      matchesAgentOwnershipFilters({ kind: "pending-create" }, [], [false], {
        owner: "is",
        starred: "is",
      }),
    ).toBe(false);
  });
});

describe("agent inventory relationship filters", () => {
  const nestedAgent = {
    kind: "live",
    subAgentNames: ["writer"],
    orchestratorNames: ["daily-briefing"],
  };

  it("lets a nested agent match both derived roles", () => {
    const operators = { agentType: "is" as const, orchestrator: "is" as const };
    expect(
      matchesAgentRelationshipFilters(
        nestedAgent,
        ["orchestrator"],
        [],
        operators,
      ),
    ).toBe(true);
    expect(
      matchesAgentRelationshipFilters(nestedAgent, ["sub-agent"], [], operators),
    ).toBe(true);
  });

  it("scopes sub-agents to the selected orchestrator", () => {
    expect(
      matchesAgentRelationshipFilters(nestedAgent, [], ["daily-briefing"], {
        agentType: "is",
        orchestrator: "is",
      }),
    ).toBe(true);
    expect(
      matchesAgentRelationshipFilters(nestedAgent, [], ["other"], {
        agentType: "is",
        orchestrator: "is",
      }),
    ).toBe(false);

    expect(
      matchesAgentRelationshipFilters(nestedAgent, [], ["other"], {
        agentType: "is",
        orchestrator: "is-not",
      }),
    ).toBe(true);
  });

  it("excludes non-live inventory rows from relationship views", () => {
    expect(
      matchesAgentRelationshipFilters(
        { kind: "pending-create" },
        ["sub-agent"],
        [],
        { agentType: "is", orchestrator: "is" },
      ),
    ).toBe(false);
  });
});
