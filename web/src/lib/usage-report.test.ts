import { describe, expect, it } from "vitest";
import { parseUsageFilters, usageHref, usageMoney } from "./usage-report";

describe("usage report filters", () => {
  it("defaults to 30 Eastern calendar dates even when UTC is the next day", () => {
    expect(parseUsageFilters({}, new Date("2026-10-15T01:00:00Z"))).toMatchObject({
      from: "2026-09-15", to: "2026-10-14", group: "agents", page: 1,
    });
  });
  it("rejects invalid dates, reversed/unbounded ranges and unsupported filters", () => {
    for (const params of [{ to: "bad" }, { from: "2026-02-30" }, { from: "2026-10-15", to: "2026-10-14" },
      { from: "2025-01-01", to: "2026-10-14" }, { group: "sql" }, { page: "-1" }, { page: "1.5" },
      { automation: "not-a-uuid" }, { kind: "other" }, { trigger: "invalid" }]) {
      expect(() => parseUsageFilters(params)).toThrow();
    }
  });
  it("keeps drill-down filters and encoded agent names in paging links", () => {
    const filters = parseUsageFilters({ agent: "A&B/agent", user: "member", from: "2026-10-01", to: "2026-10-14", page: "3" });
    const next = new URL(usageHref("acme", filters, { page: 4 }), "http://local");
    expect(next.searchParams.get("agent")).toBe("A&B/agent");
    expect(next.searchParams.get("user")).toBe("member");
    expect(next.searchParams.get("page")).toBe("4");
    expect(new URL(usageHref("acme", filters, { group: "users" }), "http://local").searchParams.get("page")).toBe("1");
  });
  it("distinguishes missing prices from actual zero costs and retains small estimates", () => {
    expect(usageMoney(null)).toBe("Unavailable");
    expect(usageMoney(0)).toBe("$0.00");
    expect(usageMoney(0.0012)).toBe("$0.0012");
    expect(usageMoney(0.000001)).toBe("<$0.0001");
  });
});
