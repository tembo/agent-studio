// Best-effort natural-language → 5-field cron, used to suggest a schedule when
// someone describes a new agent that "runs every morning" etc. (see
// agents/new/actions.ts). Deliberately CONSERVATIVE: it only returns a cron
// when the text contains an unambiguous recurrence cue ("every <unit>",
// "daily", a weekday name, …). Prose that merely mentions a time of day
// ("reply within 9 hours", "the 9am report") must return null — a false
// positive would present a misleading suggestion.
//
// Cron is interpreted in UTC everywhere in this codebase (see cron.ts /
// migration 0015), so the spoken hour is taken as a UTC hour. The suggestion
// helper validates the result with validateCron() before presenting it.

import { validateCron } from "./cron";

export type ParsedSchedule = {
  /** 5-field cron (minute hour day-of-month month day-of-week), UTC. */
  cron: string;
};

export type ScheduleSuggestion = ParsedSchedule & {
  humanReadable: string;
};

// Named times of day → 24h hour. Used when a frequency is given without an
// explicit clock time ("every morning", "nightly").
const NAMED_TIMES: Record<string, number> = {
  morning: 9,
  noon: 12,
  midday: 12,
  afternoon: 14,
  evening: 18,
  night: 21,
  midnight: 0,
};

const DOW: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

// Default fire time when a frequency is named but no time is ("every weekday"
// → 9:00). Mirrors the automations form's default of "0 9 * * …".
const DEFAULT_HOUR = 9;

type Time = { h: number; m: number };

// Pull the first explicit clock time out of the text: "9am", "9:30 am",
// "14:00", "9 pm". Returns null if none — the caller falls back to a named
// time or DEFAULT_HOUR. Bare integers ("at 9") are accepted only with a
// leading "at" to avoid matching counts elsewhere in the sentence.
function extractClockTime(text: string): Time | null {
  // h[:mm] am/pm
  const ampm = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const m = ampm[2] ? parseInt(ampm[2], 10) : 0;
    const pm = ampm[3] === "pm";
    if (h >= 1 && h <= 12 && m <= 59) {
      if (pm && h !== 12) h += 12;
      if (!pm && h === 12) h = 0; // 12am = midnight
      return { h, m };
    }
  }
  // 24h "14:00" / "09:30"
  const hhmm = text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (hhmm) {
    const h = parseInt(hhmm[1], 10);
    const m = parseInt(hhmm[2], 10);
    if (h <= 23 && m <= 59) return { h, m };
  }
  // "at 9" (no minutes, no am/pm) — require the "at" so we don't grab a stray
  // number. Treated as a 24h hour.
  const at = text.match(/\bat\s+(\d{1,2})\b(?!\s*(?:am|pm|:))/);
  if (at) {
    const h = parseInt(at[1], 10);
    if (h <= 23) return { h, m: 0 };
  }
  return null;
}

// Resolve the fire time: explicit clock time wins, else a named time present
// in the text ("nightly" → 21:00), else DEFAULT_HOUR.
function resolveTime(text: string): Time {
  const explicit = extractClockTime(text);
  if (explicit) return explicit;
  // "nightly" implies evening even though it doesn't contain the bare word
  // "night" (\bnight\b won't match the -ly form).
  if (/\bnightly\b/.test(text)) return { h: NAMED_TIMES.night, m: 0 };
  for (const [word, h] of Object.entries(NAMED_TIMES)) {
    if (new RegExp(`\\b${word}\\b`).test(text)) return { h, m: 0 };
  }
  return { h: DEFAULT_HOUR, m: 0 };
}

// Day-of-week list ("every monday and thursday" → "1,4"; weekdays → "1-5";
// weekends → "0,6"). Returns null when the text names no day group.
function extractDow(text: string): string | null {
  if (/\b(weekdays?|business days?|workdays?)\b/.test(text)) return "1-5";
  if (/\bweekends?\b/.test(text)) return "0,6";
  const days = new Set<number>();
  for (const [name, n] of Object.entries(DOW)) {
    if (new RegExp(`\\b${name}s?\\b`).test(text)) days.add(n);
  }
  if (days.size === 0) return null;
  return [...days].sort((a, b) => a - b).join(",");
}

/**
 * Parse a free-text description into a cron schedule, or null when there's no
 * clear recurrence cue. Order matters: the most specific intervals (every N
 * minutes/hours) are matched before the day-of-week and daily/weekly/monthly
 * cases.
 */
export function parseScheduleToCron(input: string): ParsedSchedule | null {
  const text = input.toLowerCase();

  // every N minutes → */N * * * *
  const everyMin = text.match(/\bevery\s+(\d{1,3})\s*(?:minutes?|mins?)\b/);
  if (everyMin) {
    const n = parseInt(everyMin[1], 10);
    if (n >= 1 && n <= 59) return { cron: `*/${n} * * * *` };
  }

  // every N hours → 0 */N * * *
  const everyHr = text.match(/\bevery\s+(\d{1,2})\s*(?:hours?|hrs?)\b/);
  if (everyHr) {
    const n = parseInt(everyHr[1], 10);
    if (n >= 1 && n <= 23) return { cron: `0 */${n} * * *` };
  }

  // hourly / every hour → 0 * * * *
  if (/\b(hourly|every\s+hour|each\s+hour)\b/.test(text)) {
    return { cron: "0 * * * *" };
  }

  // Specific weekday(s), with optional time: "every monday at 8am",
  // "on weekdays", "each friday". Require a scheduling cue near the day so we
  // don't match an incidental "due Friday".
  const dow = extractDow(text);
  if (
    dow &&
    /\b(every|each|on|weekly|weekdays?|weekends?|business days?)\b/.test(text)
  ) {
    const { h, m } = resolveTime(text);
    return { cron: `${m} ${h} * * ${dow}` };
  }

  // Monthly → first of the month. "monthly", "every month", "first of the
  // month". (Day-of-month beyond the 1st is out of scope.)
  if (/\b(monthly|every\s+month|each\s+month|first of (?:the|each) month)\b/.test(text)) {
    const { h, m } = resolveTime(text);
    return { cron: `${m} ${h} 1 * *` };
  }

  // Daily: "daily", "every day", "each day", "nightly", "every morning",
  // "every evening/afternoon/night".
  if (
    /\b(daily|nightly|every\s+day|each\s+day|every\s+(?:morning|afternoon|evening|night)|every\s+24\s*hours?)\b/.test(
      text,
    )
  ) {
    const { h, m } = resolveTime(text);
    return { cron: `${m} ${h} * * *` };
  }

  // Bare "weekly" / "every week" with no named day → Monday at the resolved
  // time. Checked after the day-of-week case so "weekly on Tuesday" already won.
  if (/\b(weekly|every\s+week|each\s+week)\b/.test(text)) {
    const { h, m } = resolveTime(text);
    return { cron: `${m} ${h} * * 1` };
  }

  return null;
}

/**
 * Turn recurring language into display-ready guidance without creating an
 * automation. The user must test the agent and explicitly create the schedule.
 */
export function suggestScheduleFromDescription(
  input: string,
): ScheduleSuggestion | null {
  const parsed = parseScheduleToCron(input);
  if (!parsed) return null;

  const validation = validateCron(parsed.cron);
  if (!validation.ok) return null;

  return {
    cron: parsed.cron,
    humanReadable: validation.humanReadable,
  };
}
