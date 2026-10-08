"use client";

// Shared create/edit form for an automation. Live cron preview so
// the user sees both the human description ("Every weekday at 09:00")
// and the next-fire instant rendered in their local tz before they
// commit. New schedules capture the browser timezone; edits keep the saved zone.

import { useActionState, useMemo, useState } from "react";
import { useActionToast } from "@/lib/use-action-toast";

import { MemberPicker } from "@/components/member-picker";
import type { MemberChoice } from "@/lib/member-choice";
import { LocalTime } from "@/components/local-time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useBrowserTimezone } from "@/lib/use-browser-timezone";
import { validateCron } from "@/lib/cron";
import { SchedulePicker } from "./schedule-picker";

import {
  createAutomationAction,
  updateAutomationAction,
  type AutomationFormState,
} from "./actions";

const INITIAL: AutomationFormState = {};

type AgentChoice = {
  name: string;
};

type CommonProps = {
  workspaceSlug: string;
  agents: AgentChoice[];
  initialOwner: MemberChoice;
  defaults?: {
    id?: string;
    name?: string;
    agentName?: string;
    cron?: string;
    timezone?: string;
    inputMessage?: string;
    enabled?: boolean;
    useDraft?: boolean;
  };
};

export function AutomationForm({
  workspaceSlug,
  agents,
  initialOwner,
  defaults,
  mode,
}: CommonProps & { mode: "create" | "edit" }) {
  const action = mode === "create" ? createAutomationAction : updateAutomationAction;
  const [state, formAction, pending] = useActionState(action, INITIAL);
  useActionToast(state);

  // Controlled — React 19's useActionState resets uncontrolled fields
  // after each submission, including the returned-error path.
  // Cron is already controlled for the live preview.
  const [name, setName] = useState(defaults?.name ?? "");
  const [agentName, setAgentName] = useState(defaults?.agentName ?? "");
  const [cron, setCron] = useState(defaults?.cron ?? "0 9 * * 1-5");
  const [inputMessage, setInputMessage] = useState(defaults?.inputMessage ?? "");
  const [enabled, setEnabled] = useState(defaults?.enabled ?? true);
  const [owner, setOwner] = useState(initialOwner);
  const [useDraft, setUseDraft] = useState(defaults?.useDraft ?? false);
  const browserTimezone = useBrowserTimezone();
  const [selectedTimezone, setSelectedTimezone] = useState<string | null>(
    mode === "edit" ? defaults?.timezone ?? "UTC" : defaults?.timezone ?? null,
  );
  const timezone = selectedTimezone ?? browserTimezone;
  // Enumerate in the browser after hydration; keep saved aliases and UTC available.
  const timezoneOptions = useMemo(() => [...new Set([
    "UTC", ...(timezone ? [timezone] : []),
    ...(browserTimezone ? Intl.supportedValuesOf("timeZone") : []),
  ])].sort(), [browserTimezone, timezone]);
  const preview = useMemo(
    () => timezone ? validateCron(cron, timezone) : null,
    [cron, timezone],
  );

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <input type="hidden" name="workspace" value={workspaceSlug} />
      {mode === "edit" && defaults?.id && (
        <input type="hidden" name="id" value={defaults.id} />
      )}

      <div className="grid gap-1.5">
        <Label htmlFor="name" className="text-sm">
          Automation name
        </Label>
        <Input
          id="name"
          name="name"
          type="text"
          required
          maxLength={200}
          autoComplete="off"
          spellCheck={false}
          disabled={pending}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Daily inbox sweep"
        />
        {state.fieldErrors?.name && (
          <FieldError>{state.fieldErrors.name}</FieldError>
        )}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="agent" className="text-sm">
          Agent
        </Label>
        <select
          id="agent"
          name="agent"
          required
          disabled={pending}
          value={agentName}
          onChange={(e) => setAgentName(e.target.value)}
          className="bg-surface border-border text-foreground focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring-color,#009eff)] rounded-md border px-3 py-2 text-sm leading-6"
        >
          <option value="" disabled>
            Pick an agent…
          </option>
          {agents.map((a) => (
            <option key={a.name} value={a.name}>
              {a.name}
            </option>
          ))}
        </select>
        {state.fieldErrors?.agent && (
          <FieldError>{state.fieldErrors.agent}</FieldError>
        )}
      </div>

      <div className="grid gap-1.5">
        <SchedulePicker cron={cron} onChange={setCron} disabled={pending} />
        <Label htmlFor="timezone">Timezone</Label>
        <select
          id="timezone"
          name="timezone"
          value={timezone ?? ""}
          onChange={(event) => setSelectedTimezone(event.target.value)}
          disabled={pending || !timezone}
          required
          className="bg-surface border-border text-foreground min-w-0 rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring-color,#009eff)]"
        >
          {!timezone && <option value="">Detecting your browser’s timezone…</option>}
          {timezoneOptions.map((zone) => (
            <option key={zone} value={zone}>{zone.replaceAll("_", " ")}</option>
          ))}
        </select>
        <p className="text-foreground-muted text-sm">
          {mode === "create" ? "Defaults to your browser’s timezone. " : "Saved with this schedule. "}
          Changing timezone keeps the selected clock times and follows local daylight saving changes.
        </p>
        {preview && timezone && <CronPreview preview={preview} timezone={timezone} />}
        {cron && preview && !preview.ok && (
          <FieldError>{preview.error}</FieldError>
        )}
        {state.fieldErrors?.cron && (
          <FieldError>{state.fieldErrors.cron}</FieldError>
        )}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="input_message" className="text-sm">
          Input message (optional)
        </Label>
        <textarea
          id="input_message"
          name="input_message"
          rows={3}
          disabled={pending}
          value={inputMessage}
          onChange={(e) => setInputMessage(e.target.value)}
          placeholder="Anything the agent should treat as the user's prompt for the run."
          className="bg-surface border-border text-foreground focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring-color,#009eff)] rounded-md border px-3 py-2 text-sm leading-6 resize-y"
        />
      </div>

      <div className="grid gap-1.5">
        <MemberPicker workspaceSlug={workspaceSlug} name="owner_user_id" value={owner} onChange={setOwner} disabled={pending} />
        <p className="text-foreground-muted text-sm">
          Scheduled runs use this user&apos;s Composio connections. If the
          agent declares a toolkit this user hasn&apos;t authorized, the run
          fails — pick someone who has the connections you need (or
          authorize them yourself).
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="enabled"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          disabled={pending}
          className="h-4 w-4"
        />
        <span className="text-foreground">Enabled</span>
        <span className="text-foreground-weak text-sm">
          (turn off to pause without deleting)
        </span>
      </label>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="use_draft"
          checked={useDraft}
          onChange={(e) => setUseDraft(e.target.checked)}
          disabled={pending}
          className="h-4 w-4"
        />
        <span className="text-foreground">Run the draft</span>
        <span className="text-foreground-weak text-sm">
          (default: the agent&apos;s current stable version)
        </span>
      </label>

      {state.error && (
        <div className="border-sentiment-negative bg-[var(--color-input-error)] rounded-lg border p-3 text-sm">
          {state.error}
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending || !timezone || !preview?.ok}>
          {pending ? "Saving…" : mode === "create" ? "Create" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

function CronPreview({
  preview,
  timezone,
}: {
  preview: ReturnType<typeof validateCron>;
  timezone: string;
}) {
  if (!preview.ok) return null;
  return (
    <div className="text-foreground-weak flex flex-col gap-0.5 text-sm">
      <span>
        <span className="text-foreground">{preview.humanReadable}</span>{" "}
        <span className="text-foreground-muted">({timezone})</span>
      </span>
      <span>
        Next run:{" "}
        <LocalTime iso={preview.nextFire.toISOString()} />
      </span>
    </div>
  );
}

function FieldError({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-sentiment-negative text-sm">{children}</span>
  );
}
