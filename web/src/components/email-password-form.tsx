"use client";

import { useState, useTransition } from "react";

import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Email + password sign-in / sign-up, shown only when no OAuth provider is
// configured (the zero-config quickstart). Sign-up is still gated server-side
// by the instance sign-up policy (invite-only by default). On success
// better-auth sets the session cookie; we navigate to `callbackURL` ourselves
// (the email flow returns no redirect URL like OAuth does).
export function EmailPasswordForm({
  callbackURL = "/",
  initialMode = "signin",
}: {
  callbackURL?: string;
  initialMode?: "signin" | "signup";
}) {
  const [mode, setMode] = useState<"signin" | "signup">(initialMode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res =
        mode === "signup"
          ? await authClient.signUp.email({
              email: email.trim(),
              password,
              name: name.trim() || email.trim().split("@")[0],
              callbackURL,
            })
          : await authClient.signIn.email({
              email: email.trim(),
              password,
              callbackURL,
            });
      if (res.error) {
        setError(
          res.error.message ??
            (mode === "signup"
              ? "Couldn't create the account."
              : "Sign-in failed."),
        );
        return;
      }
      window.location.href = callbackURL;
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      {mode === "signup" && (
        <Input
          type="text"
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          disabled={pending}
        />
      )}
      <Input
        type="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        autoComplete="email"
        required
        disabled={pending}
      />
      <Input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete={mode === "signup" ? "new-password" : "current-password"}
        minLength={8}
        required
        disabled={pending}
      />

      {error && (
        <p className="text-sentiment-negative text-sm" role="alert">
          {error}
        </p>
      )}

      <Button type="submit" disabled={pending}>
        {pending
          ? mode === "signup"
            ? "Creating…"
            : "Signing in…"
          : mode === "signup"
            ? "Create account"
            : "Sign in"}
      </Button>

      <button
        type="button"
        onClick={() => {
          setMode(mode === "signin" ? "signup" : "signin");
          setError(null);
        }}
        disabled={pending}
        className="text-foreground-weak hover:text-foreground text-sm"
      >
        {mode === "signin"
          ? "First time? Create an account"
          : "Already have an account? Sign in"}
      </button>

      {mode === "signin" && (
        <p className="text-foreground-muted text-center text-sm">
          Forgot your password? Ask a workspace admin to generate a reset link.
        </p>
      )}
    </form>
  );
}
