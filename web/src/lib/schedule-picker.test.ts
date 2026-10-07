import { describe, expect, it } from "vitest";

import { nextFireAfter, validateCron } from "./cron";
import { cronToSchedule, DEFAULT_SCHEDULE, HOUR_INTERVALS, scheduleToCron } from "./schedule-picker";

describe("simple schedule creation", () => {
  it.each([
    ["daily", "10 8 * * *"],
    ["weekdays", "10 8 * * 1-5"],
    ["weekly", "10 8 * * 0,2,4"],
    ["monthly", "10 8 15 * *"],
    ["hourly", "0 */2 * * *"],
  ] as const)("creates a valid %s schedule", (frequency, expected) => {
    const cron = scheduleToCron({ ...DEFAULT_SCHEDULE, frequency, time: "08:10", days: [4, 0, 2, 2], dayOfMonth: 15 });
    expect(cron).toBe(expected);
    expect(validateCron(cron, "America/New_York").ok).toBe(true);
  });

  it("requires a time and at least one day for a weekly schedule", () => {
    expect(scheduleToCron({ ...DEFAULT_SCHEDULE, time: "" })).toBe("");
    expect(scheduleToCron({ ...DEFAULT_SCHEDULE, frequency: "weekly", days: [] })).toBe("");
  });

  it("rejects invalid times, days, and uneven hourly intervals", () => {
    expect(scheduleToCron({ ...DEFAULT_SCHEDULE, time: "24:00" })).toBe("");
    expect(scheduleToCron({ ...DEFAULT_SCHEDULE, time: "09:60" })).toBe("");
    expect(scheduleToCron({ ...DEFAULT_SCHEDULE, frequency: "weekly", days: [-1] })).toBe("");
    expect(scheduleToCron({ ...DEFAULT_SCHEDULE, frequency: "monthly", dayOfMonth: 32 })).toBe("");
    expect(scheduleToCron({ ...DEFAULT_SCHEDULE, frequency: "hourly", hourInterval: 5 })).toBe("");
  });

  it.each(HOUR_INTERVALS)("spaces a %i-hour schedule evenly across midnight in UTC", (hourInterval) => {
    const cron = scheduleToCron({ ...DEFAULT_SCHEDULE, frequency: "hourly", hourInterval });
    let previous = new Date("2026-10-07T00:00:00Z");
    for (let i = 0; i < 48 / hourInterval; i++) {
      const next = nextFireAfter(cron, previous)!;
      expect(next.getTime() - previous.getTime()).toBe(hourInterval * 3_600_000);
      previous = next;
    }
  });

  it("skips months without the selected monthly day", () => {
    const cron = scheduleToCron({ ...DEFAULT_SCHEDULE, frequency: "monthly", dayOfMonth: 31 });
    expect(nextFireAfter(cron, new Date("2026-01-31T09:00:00Z"))?.toISOString()).toBe("2026-03-31T09:00:00.000Z");
  });
});

describe("editing existing schedules", () => {
  it.each([
    ["0 0 * * *", "daily"],
    ["10 8 * * 1-5", "weekdays"],
    ["59 23 * * 0", "weekly"],
    ["10 8 * * 5,1,3", "weekly"],
    ["0 9 31 * *", "monthly"],
    ["0 * * * *", "hourly"],
    ["0 */4 * * *", "hourly"],
    ["  05 09 * * *  ", "daily"],
  ])("recognizes %s without changing its firing times", (cron, frequency) => {
    const parsed = cronToSchedule(cron);
    expect(parsed?.frequency).toBe(frequency);
    const generated = scheduleToCron(parsed!);
    let after = new Date("2026-10-01T00:00:00Z");
    for (let i = 0; i < 40; i++) {
      const original = nextFireAfter(cron, after, "America/New_York")!;
      expect(nextFireAfter(generated, after, "America/New_York")).toEqual(original);
      after = original;
    }
  });

  it.each([
    "*/15 * * * *", // Minute intervals.
    "15 */2 * * *", // Hour intervals with a minute offset.
    "0 */5 * * *", // Uneven hour intervals.
    "0 9-17/2 * * 1-5", // Business hours.
    "0 9 1 * 1", // OR semantics for day-of-month and day-of-week.
    "0 9 * 1 1", // Specific month.
    "0 9 * * MON", // Named day.
    "0 9 * * 7", // Sunday alias.
    "0 9 L * *", // Last day of month.
    "0 0 9 * * *", // Seconds field.
    "@daily", // Macro.
    "0 24 * * *",
    "60 9 * * *",
    "0 9 0 * *",
    "0 9 32 * *",
    "",
  ])("leaves %s in Advanced instead of approximating it", (cron) => {
    expect(cronToSchedule(cron)).toBeNull();
  });
});
