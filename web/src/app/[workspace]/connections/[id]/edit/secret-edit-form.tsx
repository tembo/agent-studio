"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import {
  removeSecretConnectionAction,
  setSecretConnectionAction,
  type SecretActionState,
} from "../../secrets-actions";

const INITIAL: SecretActionState = {};

// Edit a workspace secret: rotate its value / description (slug is fixed — it's
// the identifier agent code calls), and a delete. Both actions redirect on
// success (to the view, or the list on delete).
export function SecretEditForm({
  workspaceSlug,
  id,
  slug,
  description,
}: {
  workspaceSlug: string;
  id: string;
  slug: string;
  description: string | null;
}) {
  const [state, action, pending] = useActionState(
    setSecretConnectionAction,
    INITIAL,
  );
  const [, removeAction, removing] = useActionState(
    removeSecretConnectionAction,
    INITIAL,
  );
  return (
    <div className="flex flex-col gap-6">
      <form action={action} className="flex flex-col gap-3">
        <input type="hidden" name="workspace" value={workspaceSlug} />
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="slug" value={slug} />
        <div className="grid gap-1.5">
          <Label htmlFor="secret-value" className="text-sm">
            New value
          </Label>
          <Input
            id="secret-value"
            name="value"
            type="password"
            required
            autoComplete="off"
            disabled={pending}
            placeholder="Paste a new value to rotate"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="secret-description" className="text-sm">
            Description <span className="text-foreground-muted">(optional)</span>
          </Label>
          <Input
            id="secret-description"
            name="description"
            defaultValue={description ?? ""}
            disabled={pending}
          />
        </div>
        {state.error && (
          <p className="text-sentiment-negative text-sm" role="alert">
            {state.error}
          </p>
        )}
        <div>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Saving…" : "Rotate value"}
          </Button>
        </div>
      </form>

      <div className="border-t border-[var(--color-border-weak)] pt-4">
        <form action={removeAction}>
          <input type="hidden" name="workspace" value={workspaceSlug} />
          <input type="hidden" name="id" value={id} />
          <button
            type="submit"
            disabled={removing}
            className="text-foreground-weak hover:text-sentiment-negative text-sm"
          >
            {removing ? "Removing…" : "Delete this secret"}
          </button>
        </form>
      </div>
    </div>
  );
}
