import { afterEach, describe, expect, it, vi } from "vitest";
import { hasFiringInWindow, nextFireAfter, validateCron } from "./cron";

afterEach(() => vi.useRealTimers());

describe("timezone-aware cron", () => {
  it.each([
    ["2026-03-07T12:00:00Z", "2026-03-07T13:10:00.000Z"],
    ["2026-03-08T12:00:00Z", "2026-03-08T12:10:00.000Z"],
    ["2026-10-31T12:00:00Z", "2026-10-31T12:10:00.000Z"],
    ["2026-11-01T12:00:00Z", "2026-11-01T13:10:00.000Z"],
  ])("keeps 8:10 AM Eastern across DST from %s", (now, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const preview = validateCron("10 8 * * *", "America/New_York");
    expect(preview.ok && preview.nextFire.toISOString()).toBe(expected);
    expect(nextFireAfter("10 8 * * *", new Date(now), "America/New_York")?.toISOString()).toBe(expected);
  });

  it.each([
    ["America/Chicago", "2026-11-02T14:10:00.000Z"],
    ["Asia/Kolkata", "2026-11-02T02:40:00.000Z"],
  ])("evaluates weekdays in %s", (timezone, expected) => {
    expect(nextFireAfter("10 8 * * 1-5", new Date("2026-11-01T00:00:00Z"), timezone)?.toISOString()).toBe(expected);
  });

  it("preserves UTC for schedules without a timezone", () => {
    expect(nextFireAfter("10 8 * * *", new Date("2026-11-01T00:00:00Z"))?.toISOString()).toBe("2026-11-01T08:10:00.000Z");
  });

  it("uses an exclusive lower and inclusive upper firing boundary", () => {
    const due = new Date("2026-11-02T13:10:00Z");
    expect(hasFiringInWindow("10 8 * * 1-5", new Date(due.getTime() - 1), due, "America/New_York")).toBe(true);
    expect(hasFiringInWindow("10 8 * * 1-5", due, new Date(due.getTime() + 30_000), "America/New_York")).toBe(false);
  });

  it("moves a nonexistent spring-forward time ahead by the DST gap", () => {
    expect(nextFireAfter("30 2 * * *", new Date("2026-03-08T00:00:00Z"), "America/New_York")?.toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });

  it("does not repeat a daily schedule in the fall-back hour", () => {
    const first = nextFireAfter("30 1 * * *", new Date("2026-11-01T00:00:00Z"), "America/New_York")!;
    expect(first.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(nextFireAfter("30 1 * * *", first, "America/New_York")?.toISOString()).toBe("2026-11-02T06:30:00.000Z");
  });

  it.each(["Not/AZone", ""])("rejects invalid timezone %s", (timezone) => {
    expect(validateCron("0 9 * * *", timezone).ok).toBe(false);
    expect(nextFireAfter("0 9 * * *", new Date(), timezone)).toBeNull();
  });
});
