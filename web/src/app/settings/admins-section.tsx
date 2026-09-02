"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { InstanceAdmin } from "@/lib/instance-admins";

import {
  addInstanceAdminAction,
  removeInstanceAdminAction,
  type InstanceAdminsState,
} from "./actions";

const INITIAL: InstanceAdminsState = { ok: false };

// Serializable projection of InstanceAdmin (Date → ISO) for the
// server→client boundary.
export type AdminRow = Omit<InstanceAdmin, "createdAt">;

function RemoveButton({ email }: { email: string }) {
  const [state, action, pending] = useActionState<InstanceAdminsState, FormData>(
    removeInstanceAdminAction,
    INITIAL,
  );
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="email" value={email} />
      {state.error && !pending && (
        <span className="text-sentiment-negative text-sm">{state.error}</span>
      )}
      <Button type="submit" variant="secondary" size="small" disabled={pending}>
        {pending ? "Removing…" : "Remove"}
      </Button>
    </form>
  );
}

export function AdminsSection({
  admins,
  currentEmail,
  signInUrl,
}: {
  admins: AdminRow[];
  currentEmail: string;
  signInUrl: string;
}) {
  const [state, action, pending] = useActionState<InstanceAdminsState, FormData>(
    addInstanceAdminAction,
    INITIAL,
  );
  // Controlled so a validation bounce doesn't wipe the typed email;
  // cleared manually on success (useActionState resets after submit).
  const [email, setEmail] = useState("");

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col divide-y divide-[var(--color-border-weak)]">
        {admins.map((a) => (
          <li
            key={a.email}
            className="flex items-center justify-between gap-3 py-2"
          >
            <div className="flex min-w-0 flex-col">
              <span className="text-foreground truncate text-sm font-medium">
                {a.email}
                {a.email === currentEmail.toLowerCase() && (
                  <span className="text-foreground-weak font-normal"> (you)</span>
                )}
              </span>
              <span className="text-foreground-muted text-sm">
                {a.source === "env"
                  ? "From deploy env (INSTANCE_ADMIN_EMAILS)"
                  : a.addedByName
                    ? `Added by ${a.addedByName}`
                    : "Added in-app"}
              </span>
            </div>
            {a.source === "db" && a.email !== currentEmail.toLowerCase() && (
              <RemoveButton email={a.email} />
            )}
          </li>
        ))}
      </ul>

      <form
        action={(fd) => {
          setEmail("");
          action(fd);
        }}
        className="flex flex-col gap-2"
      >
        <div className="flex items-center gap-2">
          <Input
            name="email"
            type="email"
            required
            placeholder="alice@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={pending}
            autoComplete="off"
            className="max-w-sm"
          />
          <Button type="submit" variant="primary" size="medium" disabled={pending}>
            {pending ? "Adding…" : "Add admin"}
          </Button>
        </div>
        {state.error && !pending && (
          <p className="text-sentiment-negative text-sm" role="alert">
            {state.error}
          </p>
        )}
        {state.added && !pending && (
          <p className="text-sentiment-positive text-sm">
            {state.added} can sign in now — no email is sent, so share{" "}
            <span className="text-foreground font-medium">{signInUrl}</span>{" "}
            with them.
          </p>
        )}
        <p className="text-foreground-muted text-sm">
          Instance admins can sign in, create workspaces, and manage instance
          settings — everything needed to finish setup.
        </p>
      </form>
    </div>
  );
}
