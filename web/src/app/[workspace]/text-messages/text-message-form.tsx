"use client";

import { useActionState } from "react";

import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import {
  deleteSmsChannelAction,
  saveSmsChannelAction,
  type SmsChannelFormState,
} from "./actions";

type Option = { value: string; label: string };
type ChannelView = {
  id: string;
  accountSid: string;
  hasAuthToken: boolean;
  phoneNumber: string;
  allowedNumbers: string[];
  agentName: string;
  defaultOwnerUserId: string;
  enabled: boolean;
} | null;

const INITIAL: SmsChannelFormState = {};

export function TextMessageForm({
  workspaceSlug,
  channel,
  webhookUrl,
  agents,
  members,
}: {
  workspaceSlug: string;
  channel: ChannelView;
  webhookUrl: string | null;
  agents: Option[];
  members: Option[];
}) {
  const [state, action, pending] = useActionState(saveSmsChannelAction, INITIAL);

  return (
    <div className="flex flex-col gap-7">
      {webhookUrl && (
        <div className="border-border bg-surface-raised flex flex-col gap-3 rounded-xl border p-4">
          <div>
            <h2 className="text-foreground font-medium">Twilio webhook</h2>
            <p className="text-foreground-weak mt-1 text-sm">
              In Twilio, set this phone number&apos;s incoming-message webhook to
              HTTP POST.
            </p>
          </div>
          <div className="border-border bg-surface flex items-center gap-2 rounded-lg border px-3 py-2">
            <code className="text-foreground min-w-0 flex-1 break-all text-sm">
              {webhookUrl}
            </code>
            <CopyButton text={webhookUrl} ariaLabel="Copy Twilio webhook URL" />
          </div>
        </div>
      )}

      <form action={action} className="flex flex-col gap-5">
        <input type="hidden" name="workspace" value={workspaceSlug} />
        {channel && <input type="hidden" name="id" value={channel.id} />}

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
            label="Allowed sender numbers"
            name="allowed_numbers"
            defaultValue={channel?.allowedNumbers.join(", ")}
            placeholder="+14155550100, +14155550101"
            required
            disabled={pending}
          />
          <SelectField
            label="Agent"
            name="agent_name"
            options={agents}
            defaultValue={channel?.agentName ?? ""}
            placeholder="Choose an agent…"
            disabled={pending}
          />
          <SelectField
            label="Run as"
            name="default_owner"
            options={members}
            defaultValue={channel?.defaultOwnerUserId ?? ""}
            placeholder="Choose a workspace member…"
            disabled={pending}
          />
        </div>

        <p className="text-foreground-muted text-sm">
          Texts run the selected agent&apos;s stable version and use this member&apos;s
          connections. Replies are limited to one 1,500-character SMS.
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
        {state.message && (
          <p className="text-sentiment-positive text-sm" role="status">
            {state.message}
          </p>
        )}

        <div>
          <Button type="submit" variant="primary" disabled={pending || agents.length === 0}>
            {pending ? "Saving…" : channel ? "Save changes" : "Set up text messages"}
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
              Remove text-message channel
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
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
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
      />
    </div>
  );
}

function SelectField({
  label,
  name,
  options,
  defaultValue,
  placeholder,
  disabled,
}: {
  label: string;
  name: string;
  options: Option[];
  defaultValue: string;
  placeholder: string;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={`sms-${name}`} className="text-sm">
        {label}
      </Label>
      <select
        id={`sms-${name}`}
        name={name}
        required
        defaultValue={defaultValue}
        disabled={disabled}
        className="bg-input text-foreground rounded-lg px-3 py-2 text-sm shadow-[0_0_0_1px_var(--color-border)] focus:outline-none"
      >
        <option value="" disabled>
          {placeholder}
        </option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
