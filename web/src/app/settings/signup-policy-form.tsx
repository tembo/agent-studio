"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  SIGNUP_POLICIES,
  SIGNUP_POLICY_DESCRIPTIONS,
  SIGNUP_POLICY_LABELS,
  type SignupPolicy,
} from "@/lib/signup-policy";
import { cn } from "@/lib/utils";

import {
  updateSignupPolicyAction,
  type InstanceSettingsState,
} from "./actions";

export function SignupPolicyForm({
  initialPolicy,
  initialDomains,
  oauthConfigured,
}: {
  initialPolicy: SignupPolicy;
  initialDomains: string;
  oauthConfigured: boolean;
}) {
  const [state, action, pending] = useActionState<
    InstanceSettingsState,
    FormData
  >(updateSignupPolicyAction, { ok: false });
  const [policy, setPolicy] = useState<SignupPolicy>(initialPolicy);
  const [domains, setDomains] = useState(initialDomains);

  return (
    <form action={action} className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="text-foreground text-sm font-medium">
          Who can create an account
        </legend>
        {SIGNUP_POLICIES.map((value) => {
          const selected = policy === value;
          return (
            <label
              key={value}
              className={cn(
                "flex cursor-pointer gap-3 rounded-lg border px-3 py-2.5",
                selected
                  ? "border-[var(--color-border)] bg-surface-raised"
                  : "border-transparent hover:bg-interactive-state-hover",
              )}
            >
              <input
                type="radio"
                name="signupPolicy"
                value={value}
                checked={selected}
                onChange={() => setPolicy(value)}
                disabled={pending}
                className="mt-1"
              />
              <span className="flex min-w-0 flex-col">
                <span className="text-foreground text-sm font-medium">
                  {SIGNUP_POLICY_LABELS[value]}
                </span>
                <span className="text-foreground-weak text-sm">
                  {SIGNUP_POLICY_DESCRIPTIONS[value]}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>

      {policy === "domain_allowlist" && (
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="allowedDomains"
            className="text-foreground text-sm font-medium"
          >
            Allowed domains
          </label>
          <Input
            id="allowedDomains"
            name="allowedDomains"
            value={domains}
            onChange={(e) => setDomains(e.target.value)}
            placeholder="acme.com, acme.co.uk"
            autoComplete="off"
            disabled={pending}
          />
          <p className="text-foreground-weak text-sm">
            Comma-separated, without <span className="font-medium">@</span>.
            Matching is exact — add <span className="font-medium">corp.acme.com</span>{" "}
            separately if you need subdomains.
          </p>
          {!oauthConfigured && (
            <p className="text-foreground-weak text-sm">
              Domain matching requires a verified email from Google, Microsoft,
              or OIDC. Email/password sign-up cannot prove domain membership, so
              those users still need an invite or instance-admin grant.
            </p>
          )}
        </div>
      )}

      {policy !== "domain_allowlist" && (
        <input type="hidden" name="allowedDomains" value={domains} />
      )}

      {policy === "open" && (
        <p className="text-foreground-weak text-sm">
          Anyone who can reach this instance can create an account. They still
          need an invite (or an instance admin) to join a workspace.
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" size="medium" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {state.saved && !pending && (
          <span className="text-sentiment-positive text-sm">Saved.</span>
        )}
        {state.error && !pending && (
          <span className="text-sentiment-negative text-sm">{state.error}</span>
        )}
      </div>
    </form>
  );
}
