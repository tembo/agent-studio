import Link from "next/link";
import { notFound } from "next/navigation";

import { LocalTime } from "@/components/local-time";
import { RunEnvironmentTabs } from "@/components/run-environment-tabs";
import { Section } from "@/components/section";
import { Badge } from "@/components/ui/badge";
import { scheduleImprovementScan } from "@/lib/improvement-scan";
import {
  countImprovementsSince,
  listImprovements,
  listOpenImprovements,
  type ImprovementStatus,
} from "@/lib/improvements-api";
import {
  getWorkspaceDailyRunBands30d,
  getWorkspaceStats30d,
  listWorkspaceTopFailingAgents30d,
} from "@/lib/run-analytics-db";
import {
  listRunsForWorkspace,
  type RunListItem,
} from "@/lib/runs-db";
import { listMemberActivity } from "@/lib/member-stats";
import { runIdentityLabel } from "@/lib/run-identity";
import { parseRunEnvironmentFilter } from "@/lib/run-environment";
import { listAgentOwners } from "@/lib/agent-versions";
import { listAgents } from "@/lib/workspace-agents";
import { getServerSession } from "@/lib/session";
import { getWorkspaceBySlug, getWorkspaceRole } from "@/lib/workspace";

import { DashboardTeamTable, type TeamRow } from "./dashboard-team-table";
import { WorkspaceDashboard } from "./workspace-dashboard";

export const dynamic = "force-dynamic";

// Length of the "this week" window used for the Improvements counts.
// 7 days rolling avoids the cross-tz ambiguity of calendar weeks.
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export default async function DashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspace: slug }, sp] = await Promise.all([params, searchParams]);
  const environment = parseRunEnvironmentFilter(sp.environment);

  const session = await getServerSession();
  if (!session) notFound();

  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();

  // Server component: compute the rolling window from the request-time clock.
  // eslint-disable-next-line react-hooks/purity
  const since = new Date(Date.now() - WEEK_MS);
  const [
    stats,
    daily,
    topFailing,
    improvementCounts,
    recentImprovements,
    recentRuns,
    memberActivity,
    agentsListing,
    agentOwners,
    role,
    openImprovements,
  ] = await Promise.all([
    getWorkspaceStats30d(workspace.id, environment),
    getWorkspaceDailyRunBands30d(workspace.id, environment),
    listWorkspaceTopFailingAgents30d(workspace.id, 5, environment),
    countImprovementsSince(workspace.id, since),
    listImprovements(workspace.id, 10),
    listRunsForWorkspace(
      workspace.id,
      {
        environments: environment === "all" ? undefined : [environment],
      },
      { limit: 8 },
    ),
    listMemberActivity(workspace.id),
    listAgents(workspace.id).catch(() => null),
    listAgentOwners(workspace.id).catch(() => new Map<string, string>()),
    getWorkspaceRole(workspace.id, session.user.id),
    listOpenImprovements(workspace.id),
  ]);
  scheduleImprovementScan(workspace.id, openImprovements);
  const isAdmin = role === "workspace_admin";

  // Tally agents-owned per member, plus what's left unowned. The live agent
  // list (from the repo) is the inventory; agent_owner rows can outlive a
  // deleted agent, so we walk the live agents and look each one's owner up —
  // never the row set, which would over-count ghosts. An agent with an owner
  // row pointing at a former member (no longer in memberActivity) still counts
  // as "owned" for the unowned tally, but won't surface in any visible row.
  const ownedNamesByUser = new Map<string, string[]>();
  const unownedAgentNames: string[] = [];
  if (agentsListing && agentsListing.ok) {
    for (const a of agentsListing.agents) {
      if (!a.ok) continue;
      const name = a.spec.name;
      const owner = agentOwners.get(name);
      if (owner) {
        const list = ownedNamesByUser.get(owner) ?? [];
        list.push(name);
        ownedNamesByUser.set(owner, list);
      } else {
        unownedAgentNames.push(name);
      }
    }
  }

  // Disambiguate the Team table: when two members share a first name,
  // append the email in parens so "Ry" and "Ry" are distinguishable.
  // Members without a display name just show their email.
  const firstNameCounts = new Map<string, number>();
  for (const m of memberActivity) {
    const first = m.name?.trim().split(/\s+/)[0]?.toLowerCase();
    if (first) firstNameCounts.set(first, (firstNameCounts.get(first) ?? 0) + 1);
  }
  const memberLabel = (m: (typeof memberActivity)[number]): string => {
    if (!m.name) return m.email;
    const first = m.name.trim().split(/\s+/)[0]?.toLowerCase();
    return first && (firstNameCounts.get(first) ?? 0) > 1
      ? `${m.name} (${m.email})`
      : m.name;
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
          Dashboard
        </h1>
      </div>

      <hr className="border-[var(--color-border-weak)]" />

      <RunEnvironmentTabs
        active={environment}
        baseHref={`/${workspace.slug}/dashboard`}
      />

      <WorkspaceDashboard
        stats={stats}
        daily={daily}
        topFailing={topFailing}
        workspaceSlug={workspace.slug}
        environment={environment}
      />

      <Section
        title="Team"
        description="Connections, automations, Slack-bot usage, and 30-day run activity per member. Hover a count for details."
      >
        <DashboardTeamTable
          rows={memberActivity.map((m): TeamRow => {
            const owned = ownedNamesByUser.get(m.userId) ?? [];
            return {
              userId: m.userId,
              label: memberLabel(m),
              memberHref: isAdmin
                ? `/${workspace.slug}/settings/members/${m.userId}`
                : null,
              connections: m.connections,
              connectionLabels: m.connectionLabels,
              automations: m.automations,
              automationAgents: m.automationAgents,
              slackRuns30d: m.slackRuns30d,
              slackBots: m.slackBots,
              runs30d: m.runs30d,
              agentsOwned: owned.length,
              ownedAgents: owned.slice().sort((a, b) => a.localeCompare(b)),
            };
          })}
          unownedCount={unownedAgentNames.length}
          unownedAgents={unownedAgentNames
            .slice()
            .sort((a, b) => a.localeCompare(b))}
        />
      </Section>

      <Section
        title="Recent runs"
        description="The latest agent runs across this workspace."
        actions={
          <Link
            href={`/${workspace.slug}/runs`}
            className="text-foreground-weak hover:text-foreground text-sm"
          >
            View all →
          </Link>
        }
      >
        {recentRuns.length === 0 ? (
          <p className="text-foreground-weak rounded-lg border border-dashed border-[var(--color-border)] px-4 py-6 text-center text-sm">
            No runs yet. Trigger a run from an agent to see it here.
          </p>
        ) : (
          <ul className="border-border divide-border-weak bg-surface divide-y overflow-hidden rounded-lg border">
            {recentRuns.map((r) => {
              const agentHref = `/${workspace.slug}/agents/${encodeURIComponent(r.agentName)}`;
              const runHref = `${agentHref}/runs/${r.id}`;
              // Failed runs preview the error; everything else previews
              // the input (empty for manual "Run now" with no message).
              const preview =
                r.status === "failed" && r.errorMessagePreview
                  ? r.errorMessagePreview
                  : r.userMessagePreview;
              return (
                <li
                  key={r.id}
                  className="hover:bg-interactive-state-hover relative flex items-start justify-between gap-4 px-3 py-2.5 text-sm transition-colors"
                >
                  {/* Stretched link: the whole row navigates to the run.
                      It sits behind the nested agent link (z-10), so that
                      sublink keeps working — no invalid nested anchors. */}
                  <Link
                    href={runHref}
                    aria-label={`Open run for ${r.agentName}`}
                    className="absolute inset-0"
                  />
                  <div className="relative flex min-w-0 flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <Link
                        href={agentHref}
                        className="text-foreground relative z-10 font-medium hover:underline"
                      >
                        {r.agentName}
                      </Link>
                      <RunStatusBadge status={r.status} />
                      {r.isDryRun && (
                        <Badge variant="orange" size="small">
                          Dry run
                        </Badge>
                      )}
                    </div>
                    {preview && (
                      <p className="text-foreground-weak line-clamp-2 text-sm leading-5">
                        {preview}
                      </p>
                    )}
                  </div>
                  <div className="text-foreground-weak relative flex shrink-0 flex-col items-end gap-0.5 text-sm">
                    <span>
                      <LocalTime iso={r.createdAt.toISOString()} style="relative" />
                    </span>
                    <span
                      className="text-foreground-muted max-w-[12rem] truncate text-xs"
                      title={`Run as ${runIdentityLabel(r.createdByName, r.createdByEmail)}`}
                    >
                      Run as{" "}
                      {runIdentityLabel(r.createdByName, r.createdByEmail)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section
        title="Improvements"
        description="Edits proposed from run-detail pages this week, plus the latest activity."
      >
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {/* Submitted is the cumulative count of *all* improvement
                rows created in the window, regardless of their current
                status. The other three break that population down by
                where it ended up. */}
            <StatCard
              label="Submitted"
              value={improvementCounts.total}
              accent="gray"
            />
            <StatCard
              label="PR open"
              value={improvementCounts.pr_opened}
              accent="blue"
            />
            {/* "Landed" = merged PRs + direct commits (YOLO), since both put
                the change on the default branch. */}
            <StatCard
              label="Landed"
              value={improvementCounts.merged + improvementCounts.committed}
              accent="green"
            />
            <StatCard
              label="Closed"
              value={improvementCounts.closed}
              accent="red"
            />
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <span className="text-foreground-weak text-sm font-medium uppercase tracking-widest">
                Recent improvements
              </span>
              <Link
                href={`/${workspace.slug}/improvements`}
                className="text-foreground-weak hover:text-foreground text-sm"
              >
                View all →
              </Link>
            </div>
            {recentImprovements.length === 0 ? (
              <p className="text-foreground-weak rounded-lg border border-dashed border-[var(--color-border)] px-4 py-6 text-center text-sm">
                No improvements yet. Open a run and use{" "}
                <em>Improve the Agent</em> to start one.
              </p>
            ) : (
              <ul className="border-border divide-border-weak bg-surface divide-y overflow-hidden rounded-lg border">
                {recentImprovements.map((i) => {
                  const agentHref = `/${workspace.slug}/agents/${encodeURIComponent(i.agentName)}`;
                  const runHref = `${agentHref}/runs/${i.runId}`;
                  return (
                    <li
                      key={i.id}
                      className="flex items-start justify-between gap-4 px-3 py-2.5 text-sm"
                    >
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <div className="flex items-center gap-2">
                          <Link
                            href={agentHref}
                            className="text-foreground font-medium hover:underline"
                          >
                            {i.agentName}
                          </Link>
                          <StatusBadge status={i.status} />
                        </div>
                        <p className="text-foreground-weak line-clamp-2 text-sm leading-5">
                          {i.improvementText}
                        </p>
                      </div>
                      <div className="text-foreground-weak flex shrink-0 flex-col items-end gap-1 text-sm">
                        <span>
                          <LocalTime iso={i.createdAt.toISOString()} />
                        </span>
                        <div className="flex gap-2">
                          <Link href={runHref} className="hover:underline">
                            Run
                          </Link>
                          {i.prUrl && (
                            <a
                              href={i.prUrl}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="hover:underline"
                            >
                              PR ↗
                            </a>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </Section>
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: "green" | "blue" | "gray" | "red";
}) {
  const accentClass = ACCENT_CLASS[accent];
  return (
    <div className="border-border bg-surface flex flex-col gap-0.5 rounded-lg border px-3 py-2">
      <span className="text-foreground-weak text-sm font-medium uppercase tracking-widest">
        {label}
      </span>
      <span className={`text-xl font-semibold ${accentClass}`}>{value}</span>
    </div>
  );
}

const ACCENT_CLASS: Record<"green" | "blue" | "gray" | "red", string> = {
  green: "text-sentiment-positive",
  blue: "text-[var(--color-blue-600)]",
  gray: "text-foreground",
  red: "text-sentiment-negative",
};

type RunStatus = RunListItem["status"];

const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

const RUN_STATUS_BADGE: Record<
  RunStatus,
  "green" | "red" | "yellow" | "blue" | "gray"
> = {
  queued: "yellow",
  running: "blue",
  succeeded: "green",
  failed: "red",
  cancelled: "gray",
};

function RunStatusBadge({ status }: { status: RunStatus }) {
  return (
    <Badge variant={RUN_STATUS_BADGE[status]} size="small">
      {RUN_STATUS_LABELS[status]}
    </Badge>
  );
}

function StatusBadge({ status }: { status: ImprovementStatus }) {
  switch (status) {
    case "submitted":
      return (
        <Badge variant="gray" size="small">
          Submitted
        </Badge>
      );
    case "pr_opened":
      return (
        <Badge variant="blue" size="small">
          PR opened
        </Badge>
      );
    case "merged":
      return (
        <Badge variant="green" size="small">
          Merged
        </Badge>
      );
    case "committed":
      return (
        <Badge variant="green" size="small">
          Committed
        </Badge>
      );
    case "closed":
      return (
        <Badge variant="red" size="small">
          Closed
        </Badge>
      );
  }
}
