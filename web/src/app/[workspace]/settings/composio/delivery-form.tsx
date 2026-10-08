"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { composioDeliveryAction, type DeliveryState } from "./actions";

export function DeliveryForm({ workspaceSlug }: { workspaceSlug: string }) {
  const [state, action, pending] = useActionState(composioDeliveryAction, {} as DeliveryState);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="workspace" value={workspaceSlug} />
      <p className="text-foreground-weak text-sm">
        Saving credentials does not register a delivery URL in Composio. Check
        the remote configuration and trigger status, or configure this
        workspace&apos;s webhook and save its signing secret automatically.
        Requires a workspace admin. Other webhook URLs are preserved.
      </p>
      <div className="flex gap-2">
        <Button type="submit" name="intent" value="check" variant="secondary" disabled={pending}>
          Check delivery
        </Button>
        <Button type="submit" name="intent" value="configure" disabled={pending}>
          Configure delivery
        </Button>
      </div>
      <div aria-live="polite" className="text-sm">
        {pending && <p>Contacting Composio…</p>}
        {!pending && state.error && <p role="alert">{state.error}</p>}
        {!pending && state.message && <p>{state.message}</p>}
        {!pending && state.triggers && state.triggers.length > 0 && (
          <ul className="mt-3 space-y-2">
            {state.triggers.map((trigger, index) => (
              <li key={`${trigger.id}:${index}`}>
                <strong>{trigger.agent}</strong>: {trigger.status}
                <br /><code>{trigger.id}</code>
              </li>
            ))}
          </ul>
        )}
      </div>
    </form>
  );
}
