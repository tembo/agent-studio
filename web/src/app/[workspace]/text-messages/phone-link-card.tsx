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

      {!linkedPhoneNumber && (
        <div className="border-border bg-surface flex flex-col gap-2 rounded-lg border p-3 text-sm">
          <p className="text-foreground font-medium">SMS consent</p>
          <p className="text-foreground-weak">
            By sending the one-time link command, you agree to receive
            request-initiated customer-care texts from this number and other
            workspace numbers you text, including acknowledgements, agent
            results, help, and service messages. We do not send marketing
            texts. Message frequency varies based on your use; each request
            typically produces an acknowledgement and one result. Message and
            data rates may apply. Consent is not a condition of purchase. Reply
            STOP to opt out from that number, START to resubscribe, or HELP for
            help.
          </p>
          <p className="text-foreground-muted flex flex-wrap gap-x-3 gap-y-1">
            <a
              href="https://www.tembo.io/privacy/privacy-policy"
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2"
            >
              Privacy Policy
            </a>
            <a
              href="https://www.tembo.io/terms"
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2"
            >
              Terms
            </a>
          </p>
        </div>
      )}

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
