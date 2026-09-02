import { redirect } from "next/navigation";

import { AuthSetupGuide } from "@/components/auth-setup-guide";
import { EmailPasswordForm } from "@/components/email-password-form";
import { SetupInstanceNameForm } from "@/components/setup-instance-name-form";
import { SignInButtons } from "@/components/sign-in-buttons";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  emailPasswordEnabled,
  getConfiguredAuthProviders,
} from "@/lib/auth-providers";
import {
  getAppVersion,
  getInstanceNameFromEnv,
  POWERED_BY_HREF,
} from "@/lib/config";
import {
  getInstanceName,
  getSignupPolicy,
  getStoredInstanceName,
  isFirstRun,
} from "@/lib/instance-settings";
import { resolvePendingInvitesForUserId } from "@/lib/invitations";
import {
  signupRejectionMessage,
  type SignupPolicy,
} from "@/lib/signup-policy";
import { getServerSession } from "@/lib/session";
import { listWorkspacesForUser } from "@/lib/workspace";

export const dynamic = "force-dynamic";

// Sign-in lands back here with `?error=<code>` when an OAuth callback
// fails. The codes come from better-auth (e.g. `email_is_missing`), our
// sign-up gate, or the identity provider itself — all opaque to a
// first-time admin. Translate the common ones to actionable copy and
// always surface the raw code for support.
function describeAuthError(raw: string, policy: SignupPolicy): string {
  const code = raw.toLowerCase();
  if (code.includes("email_is_missing") || code.includes("email_not_found")) {
    return "Your sign-in provider didn't share an email address. For Microsoft Entra, make sure the account has an email or UPN set, then try again.";
  }
  if (code.includes("oauth_code_verification_failed")) {
    return "Couldn't complete sign-in with your provider (token exchange failed). Check the provider's client secret and that the redirect URI matches this site.";
  }
  if (
    code.includes("invite") ||
    code.includes("unable_to_create_user") ||
    code.includes("allowed email domain")
  ) {
    return signupRejectionMessage(policy);
  }
  return `Sign-in failed (${raw}). ${signupRejectionMessage(policy)}`;
}

// `next` carries the path a signed-out visitor was originally headed to (set
// by the proxy auth gate). Only accept a same-origin absolute path — reject
// protocol-relative (`//host`) and backslash tricks so it can't become an
// open redirect to another site.
function safeNext(raw?: string | string[]): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v || !v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\")) {
    return null;
  }
  return v;
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[]; next?: string | string[] }>;
}) {
  const session = await getServerSession();
  const instanceName = await getInstanceName();
  const { error, next } = await searchParams;
  const errorCode = Array.isArray(error) ? error[0] : error;
  const dest = safeNext(next);

  if (session) {
    // Auto-join any pending workspace invites for this account before
    // resolving where to land — covers users invited after they already
    // had an account (there's no separate "accept invite" step).
    try {
      await resolvePendingInvitesForUserId(session.user.id);
    } catch (e) {
      console.error("[invites] resolve on landing failed:", e);
    }
    // A returning deep-link visitor lands back where they were headed.
    if (dest && dest !== "/") {
      redirect(dest);
    }
    const workspaces = await listWorkspacesForUser(session.user.id);
    if (workspaces.length === 0) {
      redirect("/onboarding");
    }
    redirect(`/${workspaces[0].slug}`);
  }

  const providers = getConfiguredAuthProviders();
  const emailPw = emailPasswordEnabled();
  const firstRun = await isFirstRun();
  const version = getAppVersion();
  const { policy: signupPolicy } = await getSignupPolicy();
  const callbackURL = dest ? `/?next=${encodeURIComponent(dest)}` : "/";

  const signInCard =
    providers.length > 0 ? (
      <Card className="w-full max-w-md p-3">
        <CardHeader className="px-1 pb-3 pt-1">
          <CardTitle className="text-foreground-title text-base">
            Sign in
          </CardTitle>
        </CardHeader>
        <CardContent className="px-1 pb-1">
          <SignInButtons providers={providers} callbackURL={callbackURL} />
        </CardContent>
      </Card>
    ) : emailPw ? (
      <Card className="w-full max-w-md p-3">
        <CardHeader className="px-1 pb-3 pt-1">
          <CardTitle className="text-foreground-title text-base">
            {firstRun ? "Create your account" : "Sign in"}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-1 pb-1">
          <EmailPasswordForm
            callbackURL={callbackURL}
            initialMode={firstRun ? "signup" : "signin"}
          />
        </CardContent>
      </Card>
    ) : (
      <AuthSetupGuide />
    );

  return (
    <main className="bg-surface relative flex min-h-screen flex-col items-center justify-center px-6 py-12">
      <div className="flex w-full max-w-md flex-col items-center gap-6">
        <h1 className="text-foreground-title text-center text-lg font-medium">
          {instanceName}
        </h1>

        {errorCode && (
          <div
            role="alert"
            className="border-sentiment-negative/30 bg-sentiment-negative/10 text-foreground w-full max-w-md rounded-lg border px-3 py-2 text-sm"
          >
            {describeAuthError(errorCode, signupPolicy)}
          </div>
        )}

        {firstRun ? (
          <div className="flex w-full flex-col gap-4">
            <p className="text-foreground-weak text-center text-sm">
              {emailPw
                ? "First-run setup. Name this instance, then create the first account to set up your workspace."
                : "First-run setup. Name this instance and configure a sign-in provider, then sign in to create the first workspace."}
            </p>
            <Card className="w-full max-w-md p-3">
              <CardHeader className="px-1 pb-3 pt-1">
                <CardTitle className="text-foreground-title text-base">
                  Instance name
                </CardTitle>
              </CardHeader>
              <CardContent className="px-1 pb-1">
                <SetupInstanceNameForm
                  initialName={(await getStoredInstanceName()) ?? ""}
                  envFallback={getInstanceNameFromEnv()}
                />
              </CardContent>
            </Card>
            {signInCard}
          </div>
        ) : (
          signInCard
        )}
      </div>

      <p className="text-foreground-muted absolute bottom-4 right-4 text-sm">
        powered by{" "}
        <a
          href={POWERED_BY_HREF}
          target="_blank"
          rel="noreferrer noopener"
          className="hover:text-foreground-weak"
        >
          Tembo Agent Studio
        </a>
        {version && <span className="ml-1">{version}</span>}
      </p>
    </main>
  );
}
