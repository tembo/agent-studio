import Link from "next/link";
import { redirect } from "next/navigation";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { isAnyAuthConfigured } from "@/lib/auth-providers";
import { getInstanceNameFromEnv, getPublicOrigin } from "@/lib/config";
import { authorizeInstance } from "@/lib/instance";
import { listInstanceAdmins } from "@/lib/instance-admins";
import {
  getRunQueueSettings,
  getSignupPolicy,
  getStoredInstanceName,
} from "@/lib/instance-settings";
import { formatAllowedDomains } from "@/lib/signup-policy";

import { AdminsSection } from "./admins-section";
import { InstanceNameForm } from "./instance-name-form";
import { RunQueueForm } from "./run-queue-form";
import { SignupPolicyForm } from "./signup-policy-form";

export const dynamic = "force-dynamic";

// Root /settings — deployment-level (instance) settings, gated to
// instance admins (INSTANCE_ADMIN_EMAILS). Lives outside the workspace
// shell since these settings aren't workspace-scoped.
export default async function InstanceSettingsPage() {
  const auth = await authorizeInstance();
  // Don't leak the admin surface: a signed-out or non-admin user just
  // goes home.
  if (!auth.ok) redirect("/");

  const storedName = await getStoredInstanceName();
  const envFallback = getInstanceNameFromEnv();
  const signup = await getSignupPolicy();
  const runQueue = await getRunQueueSettings();
  const admins = await listInstanceAdmins();
  const oauthConfigured = isAnyAuthConfigured();

  return (
    <main className="bg-surface min-h-screen px-6 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <div className="flex flex-col gap-1">
          <Link
            href="/"
            className="text-foreground-weak hover:text-foreground w-fit text-sm"
          >
            ← Back
          </Link>
          <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
            Instance settings
          </h1>
          <p className="text-foreground-weak text-base">
            Deployment-wide configuration. Visible to instance admins only.
          </p>
        </div>

        <hr className="border-[var(--color-border-weak)]" />

        <Card className="w-full p-3">
          <CardHeader className="flex-col items-start gap-1 px-1 pb-3 pt-1">
            <CardTitle className="text-foreground-title text-base">
              General
            </CardTitle>
            <CardDescription>
              Branding shown across the deployment.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-1 pb-1">
            <InstanceNameForm
              initialName={storedName ?? ""}
              envFallback={envFallback}
            />
          </CardContent>
        </Card>

        <Card className="w-full p-3">
          <CardHeader className="flex-col items-start gap-1 px-1 pb-3 pt-1">
            <CardTitle className="text-foreground-title text-base">
              Run queue
            </CardTitle>
            <CardDescription>
              How many agents execute at once on this instance. Queued
              sub-agents start before new orchestrator runs.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-1 pb-1">
            <RunQueueForm
              initialMaxConcurrentRuns={runQueue.maxConcurrentRuns}
              initialMaxSubAgentsPerOrchestrator={
                runQueue.maxSubAgentsPerOrchestrator
              }
            />
          </CardContent>
        </Card>

        <Card className="w-full p-3">
          <CardHeader className="flex-col items-start gap-1 px-1 pb-3 pt-1">
            <CardTitle className="text-foreground-title text-base">
              Sign-up policy
            </CardTitle>
            <CardDescription>
              Who may create an account on this instance. Workspace membership
              is still by invitation.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-1 pb-1">
            <SignupPolicyForm
              initialPolicy={signup.policy}
              initialDomains={formatAllowedDomains(signup.allowedDomains)}
              oauthConfigured={oauthConfigured}
            />
          </CardContent>
        </Card>

        <Card className="w-full p-3">
          <CardHeader className="flex-col items-start gap-1 px-1 pb-3 pt-1">
            <CardTitle className="text-foreground-title text-base">
              Instance admins
            </CardTitle>
            <CardDescription>
              Who can sign in to this instance, create workspaces, and manage
              these settings.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-1 pb-1">
            <AdminsSection
              admins={admins.map(({ email, source, addedByName }) => ({
                email,
                source,
                addedByName,
              }))}
              currentEmail={auth.email}
              signInUrl={getPublicOrigin()}
            />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
