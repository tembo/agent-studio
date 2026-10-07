import Link from "next/link";

import { LocalTime } from "@/components/local-time";
import { Section } from "@/components/section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { type Automation } from "@/lib/automations-api";
import { nextFireAfter, validateCron } from "@/lib/cron";

// Cron-scheduled runs for an agent. Lives on the Automation tab.

export function AutomationsSection({
  automations,
  workspaceSlug,
  agentName,
}: {
  automations: Automation[];
  workspaceSlug: string;
  agentName: string;
}) {
  // The "New automation" link is in the Section header (right side)
  // so the affordance is visible even when the list is empty.
  const newHref = `/${workspaceSlug}/automations/new?agent=${encodeURIComponent(agentName)}`;
  return (
    <Section
      collapsible
      title={
        automations.length > 0
          ? `Schedules (${automations.length})`
          : "Schedules"
      }
      description="Schedules that fire this agent on their own. Each schedule uses its saved timezone."
    >
      <div className="mb-3">
        <Button asChild variant="secondary">
          <Link href={newHref}>New schedule</Link>
        </Button>
      </div>
      {automations.length === 0 ? (
        <p className="text-foreground-weak rounded-lg border border-dashed border-[var(--color-border)] px-4 py-6 text-center text-sm">
          No schedules yet. Click{" "}
          <strong className="text-foreground">New schedule</strong> to run this
          agent automatically.
        </p>
      ) : (
        <ul className="divide-border flex flex-col divide-y border-y border-[var(--color-border)]">
          {automations.map((a) => {
            const preview = validateCron(a.cron, a.timezone);
            const next = a.enabled ? nextFireAfter(a.cron, new Date(), a.timezone) : null;
            return (
              <li
                key={a.id}
                className="flex items-center justify-between gap-3 py-2"
              >
                <Link
                  href={`/${workspaceSlug}/automations/${a.id}`}
                  className="flex min-w-0 flex-1 items-center gap-3"
                >
                  {a.enabled ? (
                    a.lastFireError ? (
                      <Badge variant="red" size="small">
                        Error
                      </Badge>
                    ) : (
                      <Badge variant="green" size="small">
                        On
                      </Badge>
                    )
                  ) : (
                    <Badge variant="gray" size="small">
                      Off
                    </Badge>
                  )}
                  <span className="text-foreground truncate text-sm font-medium">
                    {a.name}
                  </span>
                  <span className="text-foreground-weak truncate text-sm">
                    {preview.ok ? preview.humanReadable : a.cron}{" "}
                    <span className="text-foreground-muted">({a.timezone})</span>
                  </span>
                </Link>
                <span className="text-foreground-muted shrink-0 text-sm">
                  {next ? (
                    <>
                      Next{" "}
                      <LocalTime
                        iso={next.toISOString()}
                        className="text-foreground-weak"
                      />
                    </>
                  ) : a.enabled ? (
                    "—"
                  ) : (
                    "Paused"
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
