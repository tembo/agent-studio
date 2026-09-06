"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import {
  deleteSmsChannelAction,
  saveSmsChannelAction,
  type SmsChannelFormState,
} from "./actions";

type ChannelView = {
  id: string;
  name: string;
  accountSid: string;
  hasAuthToken: boolean;
  phoneNumber: string;
  agentLabels: string[];
  enabled: boolean;
} | null;

const INITIAL: SmsChannelFormState = {};

export function TextMessageForm({
  workspaceSlug,
  channel,
  agents,
}: {
  workspaceSlug: string;
  channel: ChannelView;
  agents: { name: string; labels: string[] }[];
}) {
  const [state, action, pending] = useActionState(saveSmsChannelAction, INITIAL);

  return (
    <div className="flex flex-col gap-7">
      <form action={action} className="flex flex-col gap-5">
        <input type="hidden" name="workspace" value={workspaceSlug} />
        {channel && <input type="hidden" name="id" value={channel.id} />}

        <Field
          label="Name"
          name="name"
          defaultValue={channel?.name}
          placeholder="Support number"
          required
          disabled={pending}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Twilio Account SID"
            name="account_sid"
            defaultValue={channel?.accountSid}
            placeholder="AC…"
            required
            disabled={pending}
          />
          <Field
            label={`Twilio Auth Token${channel?.hasAuthToken ? " (set)" : ""}`}
            name="auth_token"
            type="password"
            placeholder={channel?.hasAuthToken ? "Leave blank to keep it" : "Auth token"}
            required={!channel}
            disabled={pending}
          />
          <Field
            label="Twilio phone number"
            name="phone_number"
            type="tel"
            defaultValue={channel?.phoneNumber}
            placeholder="+14155550123"
            required
            disabled={pending}
          />
          <Field
            label="Agent labels"
            name="agent_labels"
            defaultValue={channel?.agentLabels.join(", ")}
            placeholder="sales, support"
            list="sms-agent-labels"
            required
            disabled={pending}
          />
        </div>

        <datalist id="sms-agent-labels">
          {Array.from(new Set(agents.flatMap((agent) => agent.labels))).map((label) => (
            <option key={label} value={label} />
          ))}
        </datalist>

        <p className="text-foreground-muted text-sm">
          Comma-separated. The number can launch agents carrying any of these
          labels. Each linked sender runs as themselves with their own
          connections; agents use their stable versions.
        </p>

        {channel && (
          <label className="text-foreground flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="enabled"
              defaultChecked={channel.enabled}
              disabled={pending}
            />
            Accept incoming text messages
          </label>
        )}

        {state.error && (
          <p className="text-sentiment-negative text-sm" role="alert">
            {state.error}
          </p>
        )}
        <div>
          <Button type="submit" variant="primary" disabled={pending || agents.length === 0}>
            {pending ? "Saving…" : channel ? "Save changes" : "Create text number"}
          </Button>
        </div>
      </form>

      {channel && (
        <div className="border-border border-t pt-4">
          <form action={deleteSmsChannelAction}>
            <input type="hidden" name="workspace" value={workspaceSlug} />
            <input type="hidden" name="id" value={channel.id} />
            <button
              type="submit"
              className="text-foreground-weak hover:text-sentiment-negative text-sm"
            >
              Delete this text number
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  name,
  type = "text",
  defaultValue,
  placeholder,
  required,
  disabled,
  list,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  list?: string;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={`sms-${name}`} className="text-sm">
        {label}
      </Label>
      <Input
        id={`sms-${name}`}
        name={name}
        type={type}
        defaultValue={defaultValue}
        placeholder={placeholder}
        required={required}
        disabled={disabled}
        autoComplete="off"
        list={list}
      />
    </div>
  );
}
