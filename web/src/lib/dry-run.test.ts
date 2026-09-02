import { describe, expect, it } from "vitest";

import {
  composioUsesLooseRouter,
  dryRunBlockedTools,
  dryRunUnavailableReason,
} from "./dry-run";

describe("dryRunBlockedTools", () => {
  it("collects inbox and named tool-call destinations", () => {
    expect(
      dryRunBlockedTools({
        destinations: [
          { evidence: { type: "inbox_item" } },
          { evidence: { type: "tool_call", tool: "GMAIL_SEND_EMAIL" } },
        ],
      }),
    ).toEqual(["GMAIL_SEND_EMAIL", "produce_inbox_item"]);
  });
});

describe("composioUsesLooseRouter", () => {
  it("treats bare toolkit slugs as loose Composio", () => {
    expect(composioUsesLooseRouter(["gmail"])).toBe(true);
  });

  it("treats narrowed tool lists as safe", () => {
    expect(composioUsesLooseRouter([{ gmail: ["GMAIL_SEND_EMAIL"] }])).toBe(
      false,
    );
  });

  it("ignores native MCP and secrets", () => {
    expect(
      composioUsesLooseRouter([
        { attio: { source: "native-mcp" } },
        { type: "openai", source: "secret" },
      ]),
    ).toBe(false);
  });
});

describe("dryRunUnavailableReason", () => {
  const delivery = {
    destinations: [{ evidence: { type: "inbox_item" as const } }],
  };

  it("refuses Cargo AI", () => {
    expect(
      dryRunUnavailableReason({ framework: "cargo-ai", delivery }),
    ).toMatch(/Cargo AI/);
  });

  it("refuses missing delivery", () => {
    expect(
      dryRunUnavailableReason({ framework: "pydantic-agentspec" }),
    ).toMatch(/delivery/);
  });

  it("refuses loose Composio when delivery is a tool call", () => {
    expect(
      dryRunUnavailableReason({
        framework: "pydantic-agentspec",
        delivery: {
          destinations: [
            { evidence: { type: "tool_call", tool: "GMAIL_SEND_EMAIL" } },
          ],
        },
        connections: ["gmail"],
      }),
    ).toMatch(/tool router/);
  });

  it("allows inbox-only delivery even with loose Composio", () => {
    expect(
      dryRunUnavailableReason({
        framework: "pydantic-agentspec",
        delivery,
        connections: ["gmail"],
      }),
    ).toBeNull();
  });
});
