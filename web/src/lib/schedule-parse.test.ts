import { describe, expect, it } from "vitest";

import {
  parseScheduleToCron,
  suggestScheduleFromDescription,
} from "./schedule-parse";
import { validateCron } from "./cron";

// Every cron the parser emits must be one the scheduler accepts.
function expectCron(text: string, cron: string) {
  const parsed = parseScheduleToCron(text);
  expect(parsed, `expected a schedule for: ${text}`).not.toBeNull();
  expect(parsed!.cron).toBe(cron);
  expect(validateCron(parsed!.cron).ok, `invalid cron ${cron}`).toBe(true);
}

describe("parseScheduleToCron — daily", () => {
  it("every day at a 12h time", () => {
    expectCron("Summarize new leads every day at 9am", "0 9 * * *");
  });
  it("daily with pm", () => {
    expectCron("Post a daily digest at 5pm", "0 17 * * *");
  });
  it("every morning → default 9am", () => {
    expectCron("Send me a recap every morning", "0 9 * * *");
  });
  it("nightly → 21:00", () => {
    expectCron("Run a nightly backup check", "0 21 * * *");
  });
  it("24h time with minutes", () => {
    expectCron("every day at 14:30 do the thing", "30 14 * * *");
  });
  it("midnight", () => {
    expectCron("every day at midnight", "0 0 * * *");
  });
  it("12am is midnight", () => {
    expectCron("daily at 12am", "0 0 * * *");
  });
  it("12pm is noon", () => {
    expectCron("daily at 12pm", "0 12 * * *");
  });
});

describe("parseScheduleToCron — weekdays / days of week", () => {
  it("every weekday at a time", () => {
    expectCron("Check the queue every weekday at 9am", "0 9 * * 1-5");
  });
  it("business days", () => {
    expectCron("On business days, summarize tickets at 8am", "0 8 * * 1-5");
  });
  it("a single named day", () => {
    expectCron("Every Monday at 8am send the plan", "0 8 * * 1");
  });
  it("multiple named days, sorted + deduped", () => {
    expectCron("every monday and thursday at 7am", "0 7 * * 1,4");
  });
  it("weekends", () => {
    expectCron("every weekend at 10am", "0 10 * * 0,6");
  });
  it("named day without a time → default 9am", () => {
    expectCron("post a recap every friday", "0 9 * * 5");
  });
});

describe("parseScheduleToCron — intervals", () => {
  it("every N minutes", () => {
    expectCron("poll the inbox every 15 minutes", "*/15 * * * *");
  });
  it("every N hours", () => {
    expectCron("sync every 4 hours", "0 */4 * * *");
  });
  it("hourly", () => {
    expectCron("refresh the cache hourly", "0 * * * *");
  });
  it("every hour", () => {
    expectCron("check status every hour", "0 * * * *");
  });
});

describe("parseScheduleToCron — weekly / monthly", () => {
  it("bare weekly → Monday", () => {
    expectCron("send a weekly report at 9am", "0 9 * * 1");
  });
  it("monthly → first of month", () => {
    expectCron("monthly invoice run at 6am", "0 6 1 * *");
  });
});

describe("parseScheduleToCron — no false positives", () => {
  const noSchedule = [
    "Read incoming customer emails and classify each one.",
    "Reply to billing emails with a link to the help center.",
    "Escalate anything that needs a response within 9 hours.", // mentions hours, no "every"
    "Summarize the 9am standup notes.", // a time, no recurrence
    "Triage every email that arrives in the support inbox.", // "every email", not a time unit
    "Notify every customer who churned.", // "every customer"
    "Handle the Friday release checklist.", // a day, but no scheduling cue
  ];
  for (const text of noSchedule) {
    it(`returns null: ${text}`, () => {
      expect(parseScheduleToCron(text)).toBeNull();
    });
  }
});

describe("suggestScheduleFromDescription", () => {
  it("returns display-ready guidance without creating an automation", () => {
    expect(
      suggestScheduleFromDescription("Check the queue every weekday at 9am"),
    ).toEqual({
      cron: "0 9 * * 1-5",
      humanReadable: "At 09:00, Monday through Friday",
    });
  });

  it("returns null when the description has no recurring schedule", () => {
    expect(
      suggestScheduleFromDescription("Summarize the 9am standup notes"),
    ).toBeNull();
  });
});
