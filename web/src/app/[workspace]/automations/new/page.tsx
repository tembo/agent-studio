import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { IconCalendarRepeat, IconGlobe, IconLightning } from "central-icons";

import { BackLink } from "@/components/back-link";
import { memberChoice } from "@/lib/member-choice";
import { getServerSession } from "@/lib/session";
import { getWorkspaceBySlug } from "@/lib/workspace";
import { listAgents } from "@/lib/workspace-agents";

import { AutomationForm } from "../automation-form";

export const dynamic = "force-dynamic";

// Create an automation in two steps. The first page picks one of the three
// TYPES (Schedule / Trigger / Webhook), mirroring the New connection flow.
//   • Schedule  → the cron form right here.
//   • Trigger / Webhook are configured on the owning agent, so we drill into a
//     short agent picker that links to that agent's Automation tab.
// ?type=schedule (or a legacy ?agent= deep-link) shows the form; ?type=trigger
// / ?type=webhook show the agent picker.
export default async function NewAutomationPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ type?: string; agent?: string }>;
}) {
  const [{ workspace: slug }, { type: typeParam, agent: prefillAgent }] =
    await Promise.all([params, searchParams]);

  const session = await getServerSession();
  if (!session) notFound();

  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();

  const newHref = `/${workspace.slug}/automations/new`;
  const backToTypes = <BackLink href={newHref} label="New automation" />;

  // Valid, parsed agents only — broken files can't describe a runnable model.
  const agentNames = async (): Promise<string[]> => {
    const result = await listAgents(workspace.id);
    return result.ok
      ? result.agents.filter((a) => a.ok).map((a) => a.spec.name)
      : [];
  };

  // ── Schedule: the cron form ─────────────────────────────────────────
  if (typeParam === "schedule" || (!typeParam && prefillAgent)) {
    const names = await agentNames();
    const agents = names.map((name) => ({ name }));
    return (
      <FormShell
        back={backToTypes}
        title="New schedule"
        description="Run an agent on a recurring cadence. New schedules use your browser’s timezone and follow its daylight saving changes."
      >
        <AutomationForm
          workspaceSlug={slug}
          agents={agents}
          initialOwner={memberChoice(session.user.id, session.user.name, session.user.email)}
          defaults={prefillAgent ? { agentName: prefillAgent } : undefined}
          mode="create"
        />
      </FormShell>
    );
  }

  // ── Trigger / Webhook: pick the agent to configure it on ────────────
  if (typeParam === "trigger" || typeParam === "webhook") {
    const names = await agentNames();
    const isTrigger = typeParam === "trigger";
    return (
      <FormShell
        back={backToTypes}
        title={isTrigger ? "New event trigger" : "New webhook"}
        description={
          isTrigger
            ? "Composio event triggers fire an agent when something happens in a connected app. They're configured on the agent — pick which one."
            : "Inbound webhooks fire an agent when an outside system POSTs to a URL. They're configured on the agent — pick which one."
        }
      >
        {names.length === 0 ? (
          <p className="text-foreground-muted text-sm">
            No runnable agents yet. Add an agent first, then wire up its{" "}
            {isTrigger ? "triggers" : "webhooks"}.
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {names.sort().map((name) => (
              <OptionCard
                key={name}
                href={`/${slug}/agents/${encodeURIComponent(name)}/automation`}
                logo={isTrigger ? <IconLightning size={20} /> : <IconGlobe size={20} />}
                title={name}
                sublabel={`Configure on ${name} →`}
              />
            ))}
          </div>
        )}
      </FormShell>
    );
  }

  if (typeParam) notFound();

  // ── The type chooser (first page) ───────────────────────────────────
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-col gap-2">
        <BackLink href={`/${workspace.slug}/automations`} label="Automations" />
        <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
          New automation
        </h1>
        <p className="text-foreground-weak text-base">
          Pick how the agent should fire.
        </p>
      </div>

      <hr className="border-[var(--color-border-weak)]" />

      <div className="grid gap-2 sm:grid-cols-2">
        <OptionCard
          href={`${newHref}?type=schedule`}
          logo={<IconCalendarRepeat size={20} className="text-foreground-muted" />}
          title="Schedule"
          sublabel="Run an agent on a cron"
        />
        <OptionCard
          href={`${newHref}?type=trigger`}
          logo={<IconLightning size={20} className="text-foreground-muted" />}
          title="Event trigger"
          sublabel="Fire on an event in a connected app"
        />
        <OptionCard
          href={`${newHref}?type=webhook`}
          logo={<IconGlobe size={20} className="text-foreground-muted" />}
          title="Webhook"
          sublabel="Fire on an inbound HTTP POST"
        />
      </div>
    </div>
  );
}

function OptionCard({
  href,
  logo,
  title,
  sublabel,
}: {
  href: string;
  logo: ReactNode;
  title: string;
  sublabel: string;
}) {
  return (
    <Link
      href={href}
      className="border-border bg-surface hover:bg-surface-secondary group flex items-center gap-3 rounded-lg border px-4 py-3 transition-colors"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center">{logo}</span>
      <span className="flex min-w-0 flex-col">
        <span className="text-foreground group-hover:underline font-medium">{title}</span>
        <span className="text-foreground-muted truncate text-sm">{sublabel}</span>
      </span>
    </Link>
  );
}

function FormShell({
  back,
  title,
  description,
  children,
}: {
  back: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-col gap-2">
        {back}
        <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
          {title}
        </h1>
        <p className="text-foreground-weak text-base">{description}</p>
      </div>
      <hr className="border-[var(--color-border-weak)]" />
      {children}
    </div>
  );
}
