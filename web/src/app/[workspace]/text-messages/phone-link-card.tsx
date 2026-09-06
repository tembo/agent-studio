"use client";

import { useActionState } from "react";

import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";

import {
  createSmsLinkCodeAction,
  type SmsLinkFormState,
  unlinkSmsPhoneAction,
} from "./actions";

const INITIAL: SmsLinkFormState = {};

export function PhoneLinkCard({
  workspaceSlug,
  channels,
  linkedPhoneNumber,
}: {
  workspaceSlug: string;
  channels: { id: string; name: string; phoneNumber: string }[];
  linkedPhoneNumber: string | null;
}) {
  const [state, action, pending] = useActionState(
    createSmsLinkCodeAction,
    INITIAL,
  );
  const command = state.code ? `link ${state.code}` : null;
  const linkNumber = state.smsPhoneNumber ?? channels[0]?.phoneNumber;
  const linkChannelId = state.channelId ?? channels[0]?.id;

  return (
    <section className="border-border bg-surface-raised flex flex-col gap-3 rounded-xl border p-4">
      <div>
        <h2 className="text-foreground font-medium">Your phone</h2>
        <p className="text-foreground-weak mt-1 text-sm">
          Link once to use every text number in this workspace. Runs act as you
          and use your own connections.
        </p>
      </div>

      {linkedPhoneNumber ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-foreground text-sm">
            Linked as <code>{linkedPhoneNumber}</code>
          </p>
          <form action={unlinkSmsPhoneAction}>
            <input type="hidden" name="workspace" value={workspaceSlug} />
            <Button type="submit" variant="ghost" size="small">
              Unlink phone
            </Button>
          </form>
        </div>
      ) : command && linkNumber && linkChannelId ? (
        <div className="flex flex-col gap-3">
          <p className="text-foreground-weak text-sm">
            Within 15 minutes, text this one-time command to {linkNumber}:
          </p>
          <div className="border-border bg-surface flex items-center gap-2 rounded-lg border px-3 py-2">
            <code className="text-foreground min-w-0 flex-1 break-all text-sm">
              {command}
            </code>
            <CopyButton text={command} ariaLabel="Copy phone-link command" />
          </div>
          <a
            href={`sms:${linkNumber}?body=${encodeURIComponent(command)}`}
            className="text-accent text-sm font-medium hover:underline"
          >
            Open text message
          </a>
          <form action={action}>
            <input type="hidden" name="workspace" value={workspaceSlug} />
            <input type="hidden" name="channel_id" value={linkChannelId} />
            <Button type="submit" variant="ghost" size="small" disabled={pending}>
              {pending ? "Creating code…" : "Create a new code"}
            </Button>
          </form>
        </div>
      ) : (
        <form action={action} className="flex flex-col items-start gap-3">
          <input type="hidden" name="workspace" value={workspaceSlug} />
          {channels.length > 1 ? (
            <label className="text-foreground flex flex-col gap-1.5 text-sm">
              Send the link command to
              <select
                name="channel_id"
                defaultValue={channels[0]?.id}
                disabled={pending}
                className="bg-input text-foreground min-w-64 rounded-lg px-3 py-2 text-sm shadow-[0_0_0_1px_var(--color-border)] focus:outline-none"
              >
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.name} · {channel.phoneNumber}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <input type="hidden" name="channel_id" value={channels[0]?.id} />
          )}
          <Button type="submit" variant="secondary" disabled={pending}>
            {pending ? "Creating code…" : "Link this phone"}
          </Button>
        </form>
      )}

      {state.error && (
        <p className="text-sentiment-negative text-sm" role="alert">
          {state.error}
        </p>
      )}
    </section>
  );
}
