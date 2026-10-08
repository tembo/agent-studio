export type ScheduleFrequency = "daily" | "weekdays" | "weekly" | "monthly" | "hourly" | "business-hours";

export type SimpleSchedule = {
  frequency: ScheduleFrequency;
  time: string;
  days: number[];
  dayOfMonth: number;
  hourInterval: number;
  startHour: number;
  endHour: number;
};

// Only offer intervals that divide a day evenly; */5 would restart at midnight.
export const HOUR_INTERVALS = [1, 2, 3, 4, 6, 8, 12] as const;

export const DEFAULT_SCHEDULE: SimpleSchedule = {
  frequency: "weekdays",
  time: "09:00",
  days: [1, 2, 3, 4, 5],
  dayOfMonth: 1,
  hourInterval: 2,
  startHour: 9,
  endHour: 17,
};

export function scheduleToCron(schedule: SimpleSchedule): string {
  if (schedule.frequency === "business-hours") {
    const days = [...new Set(schedule.days)].sort((a, b) => a - b);
    if (!days.length || days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) return "";
    if (!HOUR_INTERVALS.some((n) => n === schedule.hourInterval)) return "";
    if (!Number.isInteger(schedule.startHour) || !Number.isInteger(schedule.endHour)
      || schedule.startHour < 0 || schedule.endHour > 23 || schedule.startHour >= schedule.endHour) return "";
    return `0 ${schedule.startHour}-${schedule.endHour}/${schedule.hourInterval} * * ${days.join(",")}`;
  }
  if (schedule.frequency === "hourly") {
    if (!HOUR_INTERVALS.some((n) => n === schedule.hourInterval)) return "";
    return schedule.hourInterval === 1 ? "0 * * * *" : `0 */${schedule.hourInterval} * * *`;
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) return "";
  const [hour, minute] = schedule.time.split(":").map(Number);
  switch (schedule.frequency) {
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly": {
      const days = [...new Set(schedule.days)].sort((a, b) => a - b);
      if (!days.length || days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) return "";
      return `${minute} ${hour} * * ${days.join(",")}`;
    }
    case "monthly":
      if (!Number.isInteger(schedule.dayOfMonth) || schedule.dayOfMonth < 1 || schedule.dayOfMonth > 31) return "";
      return `${minute} ${hour} ${schedule.dayOfMonth} * *`;
  }
}

// Recognize only expressions the controls can represent exactly. Never simplify
// arbitrary cron (especially combined day-of-month/day-of-week, which use OR).
export function cronToSchedule(cron: string): SimpleSchedule | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, days] = fields;
  if (month !== "*") return null;

  const window = /^(\d{1,2})-(\d{1,2})(?:\/(\d+))?$/.exec(hour);
  if (minute === "0" && dayOfMonth === "*" && window) {
    const selectedDays = days === "*" ? [0, 1, 2, 3, 4, 5, 6]
      : days === "1-5" ? [1, 2, 3, 4, 5]
      : /^[0-6](,[0-6])*$/.test(days) ? [...new Set(days.split(",").map(Number))] : null;
    if (!selectedDays) return null;
    const schedule: SimpleSchedule = {
      ...DEFAULT_SCHEDULE, frequency: "business-hours", days: selectedDays,
      startHour: Number(window[1]), endHour: Number(window[2]), hourInterval: Number(window[3] ?? 1),
    };
    return scheduleToCron(schedule) ? schedule : null;
  }

  if (minute === "0" && dayOfMonth === "*" && days === "*") {
    const interval = hour === "*" ? 1 : /^\*\/\d+$/.test(hour) ? Number(hour.slice(2)) : 0;
    if (HOUR_INTERVALS.some((n) => n === interval)) {
      return { ...DEFAULT_SCHEDULE, frequency: "hourly", hourInterval: interval };
    }
  }

  if (!/^\d{1,2}$/.test(minute) || Number(minute) > 59 || !/^\d{1,2}$/.test(hour) || Number(hour) > 23) return null;
  const base = { ...DEFAULT_SCHEDULE, time: `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}` };
  if (dayOfMonth === "*") {
    if (days === "*") return { ...base, frequency: "daily" };
    if (days === "1-5") return { ...base, frequency: "weekdays" };
    if (/^[0-6](,[0-6])*$/.test(days)) {
      return { ...base, frequency: "weekly", days: [...new Set(days.split(",").map(Number))] };
    }
  }
  if (days === "*" && /^\d{1,2}$/.test(dayOfMonth) && Number(dayOfMonth) >= 1 && Number(dayOfMonth) <= 31) {
    return { ...base, frequency: "monthly", dayOfMonth: Number(dayOfMonth) };
  }
  return null;
}
