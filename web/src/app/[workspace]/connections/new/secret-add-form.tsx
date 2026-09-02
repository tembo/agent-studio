"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import {
  setSecretConnectionAction,
  type SecretActionState,
} from "../secrets-actions";

const INITIAL: SecretActionState = {};

// Add a workspace secret (API key / token). On success the action redirects to
// the secret's connection view; this state only carries validation errors.
export function SecretAddForm({
  workspaceSlug,
  isAdmin,
}: {
  workspaceSlug: string;
  isAdmin: boolean;
}) {
  const [state, action, pending] = useActionState(
    setSecretConnectionAction,
    INITIAL,
  );
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="workspace" value={workspaceSlug} />
      {isAdmin ? (
        <fieldset className="grid gap-2">
          <legend className="text-foreground-weak text-sm font-medium">
            Who can use it?
          </legend>
          <label className="border-border flex cursor-pointer gap-2 rounded-lg border px-3 py-2.5">
            <input type="radio" name="scope" value="personal" defaultChecked />
            <span className="flex flex-col">
              <span className="text-foreground text-sm font-medium">Me</span>
              <span className="text-foreground-muted text-sm">
                Only your runs use this value.
              </span>
            </span>
          </label>
          <label className="border-border flex cursor-pointer gap-2 rounded-lg border px-3 py-2.5">
            <input type="radio" name="scope" value="workspace" />
            <span className="flex flex-col">
              <span className="text-foreground text-sm font-medium">Workspace</span>
              <span className="text-foreground-muted text-sm">
                Shared fallback for everyone in the workspace.
              </span>
            </span>
          </label>
        </fieldset>
      ) : (
        <>
          <input type="hidden" name="scope" value="personal" />
          <p className="text-foreground-muted text-sm">
            This secret is personal. Only your runs can use it.
          </p>
        </>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor="secret-slug" className="text-sm">
          Name
        </Label>
        <Input
          id="secret-slug"
          name="slug"
          required
          pattern="[a-z0-9_-]+"
          autoComplete="off"
          spellCheck={false}
          disabled={pending}
          placeholder="stripe_api_key"
        />
        <p className="text-foreground-muted text-sm">
          Lowercase letters, numbers, <code>_</code>, <code>-</code>. Agents read
          it with <code>tas_tools.secret(&quot;name&quot;)</code>.
        </p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="secret-value" className="text-sm">
          Value
        </Label>
        <Input
          id="secret-value"
          name="value"
          type="password"
          required
          autoComplete="off"
          disabled={pending}
          placeholder="sk_live_…"
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="secret-description" className="text-sm">
          Description <span className="text-foreground-muted">(optional)</span>
        </Label>
        <Input
          id="secret-description"
          name="description"
          disabled={pending}
          placeholder="Stripe live secret key"
        />
      </div>
      {state.error && (
        <p className="text-sentiment-negative text-sm" role="alert">
          {state.error}
        </p>
      )}
      <div>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Saving…" : "Add secret"}
        </Button>
      </div>
    </form>
  );
}
