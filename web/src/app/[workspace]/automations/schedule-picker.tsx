"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  cronToSchedule,
  DEFAULT_SCHEDULE,
  HOUR_INTERVALS,
  scheduleToCron,
  type ScheduleFrequency,
  type SimpleSchedule,
} from "@/lib/schedule-picker";

const DAYS = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 0, label: "Sunday" },
];

const SELECT_CLASS = "bg-surface border-border text-foreground rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring-color,#009eff)]";

export function SchedulePicker({
  cron,
  onChange,
  disabled,
}: {
  cron: string;
  onChange: (cron: string) => void;
  disabled: boolean;
}) {
  const [advanced, setAdvanced] = useState(() => cronToSchedule(cron) === null);
  const [schedule, setSchedule] = useState(() => cronToSchedule(cron) ?? DEFAULT_SCHEDULE);
  const parsed = cronToSchedule(cron);

  function update(next: SimpleSchedule) {
    setSchedule(next);
    onChange(scheduleToCron(next));
  }

  function showPicker() {
    if (parsed) setSchedule(parsed);
    else update(DEFAULT_SCHEDULE);
    setAdvanced(false);
  }

  return (
    <fieldset disabled={disabled} className="grid min-w-0 gap-3">
      <legend className="mb-2 text-sm font-medium">Schedule</legend>
      <input type="hidden" name="cron" value={cron} />
      {advanced ? (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor="cron">Advanced cron</Label>
            <Input
              id="cron"
              type="text"
              required
              autoComplete="off"
              spellCheck={false}
              value={cron}
              onChange={(event) => onChange(event.target.value)}
              placeholder="0 9 * * 1-5"
              className="font-mono"
            />
            <p className="text-foreground-muted text-sm">
              Five fields: minute, hour, day of month, month, day of week.
            </p>
          </div>
          {!parsed && (
            <p className="text-foreground-muted text-sm">
              This expression needs Advanced cron. Starting a simple schedule will replace it.
            </p>
          )}
          <Button variant="secondary" onClick={showPicker}>
            {parsed ? "Use schedule picker" : "Start a new simple schedule"}
          </Button>
        </>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid content-start gap-1.5">
              <Label htmlFor="schedule-frequency">Repeats</Label>
              <select
                id="schedule-frequency"
                value={schedule.frequency}
                onChange={(event) => update({ ...schedule, frequency: event.target.value as ScheduleFrequency })}
                className={SELECT_CLASS}
              >
                <option value="daily">Daily</option>
                <option value="weekdays">Weekdays (Monday–Friday)</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="hourly">Every few hours</option>
                <option value="business-hours">Business hours</option>
              </select>
            </div>
            {(schedule.frequency === "hourly" || schedule.frequency === "business-hours") ? (
              <div className="grid content-start gap-1.5">
                <Label htmlFor="schedule-interval">Every</Label>
                <select
                  id="schedule-interval"
                  value={schedule.hourInterval}
                  onChange={(event) => update({ ...schedule, hourInterval: Number(event.target.value) })}
                  className={SELECT_CLASS}
                >
                  {HOUR_INTERVALS.map((hours) => (
                    <option key={hours} value={hours}>{hours} {hours === 1 ? "hour" : "hours"}</option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="grid content-start gap-1.5">
                <Label htmlFor="schedule-time">At</Label>
                <Input
                  id="schedule-time"
                  type="time"
                  required
                  step={60}
                  value={schedule.time}
                  onChange={(event) => update({ ...schedule, time: event.target.value })}
                  className="h-10"
                />
              </div>
            )}
          </div>
          {schedule.frequency === "business-hours" && (
            <div className="grid gap-3 sm:grid-cols-2">
              {(["startHour", "endHour"] as const).map((field) => (
                <div key={field} className="grid gap-1.5">
                  <Label htmlFor={`schedule-${field}`}>{field === "startHour" ? "From" : "Through"}</Label>
                  <select
                    id={`schedule-${field}`}
                    value={schedule[field]}
                    onChange={(event) => update({ ...schedule, [field]: Number(event.target.value) })}
                    className={SELECT_CLASS}
                  >
                    {Array.from({ length: 24 }, (_, hour) => (
                      <option key={hour} value={hour}>{hour.toString().padStart(2, "0")}:00</option>
                    ))}
                  </select>
                </div>
              ))}
              <p className="text-foreground-muted text-sm sm:col-span-2">
                Runs on the hour from the start time. Includes the end hour if the interval lands on it.
                The window restarts on each selected day. For overnight windows, use Advanced cron.
              </p>
              {schedule.startHour >= schedule.endHour && (
                <p className="text-sentiment-negative text-sm sm:col-span-2" role="alert">End hour must be later than start hour.</p>
              )}
            </div>
          )}
          {(schedule.frequency === "weekly" || schedule.frequency === "business-hours") && (
            <fieldset className="grid gap-2">
              <legend className="mb-2 text-sm font-medium">On these days</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {DAYS.map((day) => (
                  <label key={day.value} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={schedule.days.includes(day.value)}
                      onChange={(event) => update({
                        ...schedule,
                        days: event.target.checked
                          ? [...schedule.days, day.value]
                          : schedule.days.filter((value) => value !== day.value),
                      })}
                      className="h-4 w-4"
                    />
                    {day.label}
                  </label>
                ))}
              </div>
              {schedule.days.length === 0 && (
                <p className="text-sentiment-negative text-sm" role="alert">Choose at least one day.</p>
              )}
            </fieldset>
          )}
          {schedule.frequency === "monthly" && (
            <div className="grid gap-1.5">
              <Label htmlFor="schedule-day">Day of the month</Label>
              <select
                id="schedule-day"
                value={schedule.dayOfMonth}
                onChange={(event) => update({ ...schedule, dayOfMonth: Number(event.target.value) })}
                className={SELECT_CLASS}
              >
                {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
                  <option key={day} value={day}>{day}</option>
                ))}
              </select>
              {schedule.dayOfMonth > 28 && (
                <p className="text-foreground-muted text-sm">Months without this day are skipped.</p>
              )}
            </div>
          )}
          {schedule.frequency === "hourly" && (
            <p className="text-foreground-muted text-sm">Runs throughout the day, on the hour, starting at midnight.</p>
          )}
          <Button variant="secondary" onClick={() => setAdvanced(true)}>Advanced cron</Button>
        </>
      )}
    </fieldset>
  );
}
