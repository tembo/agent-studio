import { describe, expect, it } from "vitest";

import { parseRunListQuery, runListQueryKey } from "./run-list-query";

describe("parseRunListQuery", () => {
  it("parses shareable combined filters", () => {
    expect(
      parseRunListQuery({
        status: ["failed,running", "unknown"],
        trigger: "manual,event",
        environment: "production,development,unknown",
        agent: " digest ",
        q: " Ada Lovelace ",
      }),
    ).toEqual({
      statuses: ["failed", "running"],
      triggers: ["manual", "event"],
      environments: ["production", "development"],
      agentName: "digest",
      search: "Ada Lovelace",
    });
  });

  it("uses the first scalar value and caps search length", () => {
    const parsed = parseRunListQuery({ q: ["x".repeat(250), "ignored"] });

    expect(parsed.search).toHaveLength(200);
    expect(parsed.statuses).toEqual([]);
    expect(parsed.triggers).toEqual([]);
    expect(parsed.environments).toEqual([]);
  });

  it("produces distinct remount keys for distinct URL filters", () => {
    const base = parseRunListQuery({});
    const searched = parseRunListQuery({ q: "run-id" });

    expect(runListQueryKey(base)).not.toBe(runListQueryKey(searched));
  });
});
