import { describe, expect, it } from "vitest";
import { parseUsageFilters, usageDays, usageHref } from "./usage-report";

describe("usage report filters", () => {
  const now = new Date("2026-10-15T02:00:00Z");
  it("defaults to 30 inclusive Eastern dates, including today", () => {
    expect(parseUsageFilters({}, now)).toMatchObject({
      from: "2026-09-15",
      to: "2026-10-14",
      view: "agents",
      page: 1,
    });
    expect(parseUsageFilters({ days: "7" }, now).from).toBe("2026-10-08");
  });
  it("rejects invalid, reversed, and excessive date windows", () => {
    for (const [from, to] of [
      ["2026-02-30", "2026-03-03"],
      ["junk", "2026-10-14"],
      ["2026-10-15", "2026-10-14"],
      ["2025-01-01", "2026-10-14"],
    ]) {
      expect(() => parseUsageFilters({ from, to }, now)).toThrow(
        "Choose valid",
      );
    }
  });
  it("keeps calendar days contiguous over DST and leap days", () => {
    expect(usageDays("2026-10-31", "2026-11-02")).toEqual([
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
    expect(usageDays("2024-02-28", "2024-03-01")).toEqual([
      "2024-02-28",
      "2024-02-29",
      "2024-03-01",
    ]);
  });
  it("preserves exact filters in links and resets pagination when changing views", () => {
    const filters = parseUsageFilters(
      { agent: "email & drafter", user: "a/b", page: "3" },
      now,
    );
    const href = usageHref("/demo/dashboard/usage", filters, { view: "runs" });
    const query = new URL(href, "http://localhost").searchParams;
    expect(query.get("agent")).toBe("email & drafter");
    expect(query.get("user")).toBe("a/b");
    expect(query.get("page")).toBeNull();
    expect(query.get("from")).toBe(filters.from);
    expect(
      usageHref("/demo", filters, { user: undefined, page: 4 }),
    ).not.toContain("user=");
    expect(parseUsageFilters({ page: "-1" }, now).page).toBe(1);
  });
});
