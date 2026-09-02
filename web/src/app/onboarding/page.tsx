import Link from "next/link";
import { redirect } from "next/navigation";

import { isInstanceAdmin } from "@/lib/instance";
import { getInstanceName, getSignupPolicy } from "@/lib/instance-settings";
import { getServerSession } from "@/lib/session";
import { listWorkspacesForUser } from "@/lib/workspace";

import { OnboardingForm } from "./onboarding-form";
import { SignOutLink } from "./sign-out-link";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const session = await getServerSession();
  if (!session) {
    redirect("/");
  }

  const isAdmin = await isInstanceAdmin(session.user.email);
  const workspaces = await listWorkspacesForUser(session.user.id);
  const instanceName = await getInstanceName();
  const { policy } = await getSignupPolicy();

  // Only instance admins create workspaces. A non-admin who already
  // belongs somewhere goes there; one who doesn't waits to be added
  // (invite-only sign-up usually means they already landed in a
  // workspace; open / domain-allowlist self-join can reach this page).
  if (!isAdmin) {
    if (workspaces.length > 0) {
      redirect(`/${workspaces[0].slug}`);
    }
    return (
      <main className="bg-surface flex min-h-screen flex-col items-center justify-center px-6 py-12">
        <div className="flex w-full max-w-md flex-col items-center gap-6">
          <div className="space-y-1 text-center">
            <p className="text-foreground-weak text-sm font-medium uppercase tracking-widest">
              {instanceName}
            </p>
            <h1 className="text-foreground-title text-2xl font-semibold">
              You&apos;re not in a workspace yet
            </h1>
            <p className="text-foreground-weak text-base">
              {policy === "invite_only"
                ? "This instance is invite-only. Ask an admin to invite "
                : "Ask an admin to add "}
              <span className="text-foreground font-medium">
                {session.user.email}
              </span>{" "}
              to a workspace.
            </p>
          </div>
          <SignOutLink email={session.user.email} />
        </div>
      </main>
    );
  }

  const isFirst = workspaces.length === 0;

  return (
    <main className="bg-surface flex min-h-screen flex-col items-center justify-center px-6 py-12">
      <div className="flex w-full max-w-md flex-col items-center gap-6">
        <div className="space-y-1 text-center">
          <p className="text-foreground-weak text-sm font-medium uppercase tracking-widest">
            {instanceName}
          </p>
          <h1 className="text-foreground-title text-2xl font-semibold">
            {isFirst
              ? `Welcome, ${session.user.name ?? session.user.email}`
              : "Create a workspace"}
          </h1>
          <p className="text-foreground-weak text-base">
            A workspace pairs a Git repo with the team that uses it. You&apos;ll
            connect the repo next; API keys live in Settings.
          </p>
        </div>
        <OnboardingForm isFirst={isFirst} />
        <p className="text-foreground-weak text-center text-sm">
          Handing setup to someone else?{" "}
          <Link
            href="/settings"
            className="text-foreground font-medium underline underline-offset-2 hover:text-foreground-title"
          >
            Invite instance admins
          </Link>{" "}
          — they can sign in and finish from here.
        </p>
        <SignOutLink email={session.user.email} />
      </div>
    </main>
  );
}
