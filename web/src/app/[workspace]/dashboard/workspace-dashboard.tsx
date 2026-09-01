import Link from "next/link";

import { LocalTime } from "@/components/local-time";
import { formatCurrency } from "@/lib/pricing";
import {
  type AgentDailyRunBands,
  type AgentStats30d,
  type DailyRunBand,
  type WorkspaceTopFailingAgent,
} from "@/lib/run-analytics-db";
import type { RunEnvironmentFilter } from "@/lib/run-environment";

// Workspace-level operational dashboard. Mirrors the per-agent
// dashboard's structure so an operator's reading flow is the same
// at both scales: health header → four tiles → 30-day trend → "what
// looks broken." The "what looks broken" cut at workspace scope is
// "which agents are failing" rather than "which error strings repeat"
// — same error message coming from two different agents is two
// different problems at the workspace level.

type Props = {
  stats: AgentStats30d;
  daily: AgentDailyRunBands[];
  topFailing: WorkspaceTopFailingAgent[];
  workspaceSlug: string;
  environment: RunEnvironmentFilter;
};

export function WorkspaceDashboard({
  stats,
  daily,
  topFailing,
  workspaceSlug,
  environment,
}: Props) {
  if (stats.totalRuns === 0) {
    return (
      <div className="text-foreground-weak flex flex-col items-center gap-2 rounded-lg border border-dashed border-[var(--color-border)] px-4 py-6 text-center text-sm">
        <p>
          No {environment === "all" ? "" : `${environment} `}runs in the last
          30 days yet — the dashboard fills in as agents start firing.
        </p>
        <Link
          href={`/${workspaceSlug}`}
          className="text-foreground font-medium hover:underline"
        >
          Browse your agents →
        </Link>
      </div>
    );
  }

  const successRate = stats.succeeded / stats.totalRuns;

  return (
    <div className="flex flex-col gap-5">
      <StatTiles
        stats={stats}
        successRate={successRate}
        environment={environment}
      />
      <DailyTrend daily={daily} />
      {topFailing.length > 0 && (
        <TopFailingAgents
          rows={topFailing}
          workspaceSlug={workspaceSlug}
        />
      )}
    </div>
  );
}

function StatTiles({
  stats,
  successRate,
  environment,
}: {
  stats: AgentStats30d;
  successRate: number;
  environment: RunEnvironmentFilter;
}) {
  const scope =
    environment === "all" ? "all environments" : `${environment} only`;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Tile
        label="Runs (30d)"
        value={stats.totalRuns.toLocaleString("en-US")}
        sub={`${stats.succeeded} ok · ${stats.failed} failed`}
      />
      <Tile
        label="Success rate"
        value={`${Math.round(successRate * 100)}%`}
        sub={scope}
      />
      <Tile
        label="Spend (30d)"
        value={
          stats.totalCostUsd > 0 ? formatCurrency(stats.totalCostUsd) : "—"
        }
        sub={stats.totalCostUsd > 0 ? "approx" : "no cost data"}
      />
      <Tile
        label="Avg duration"
        value={
          stats.avgDurationMs !== null
            ? formatDuration(stats.avgDurationMs)
            : "—"
        }
        sub={
          stats.avgDurationMs !== null ? "completed runs" : "no completed runs"
        }
      />
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="bg-surface border-border flex flex-col gap-0.5 rounded-lg border px-3 py-2">
      <span className="text-foreground-weak text-sm font-medium uppercase tracking-widest">
        {label}
      </span>
      <span className="text-foreground-title text-xl font-semibold">
        {value}
      </span>
      <span className="text-foreground-muted text-sm">{sub}</span>
    </div>
  );
}

export function DailyTrend({ daily }: { daily: AgentDailyRunBands[] }) {
  const days = fillThirtyDays(daily);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-foreground-weak text-sm font-medium uppercase tracking-widest">
          Last 30 days
        </span>
        <span className="text-foreground-muted text-sm">
          {days[0].day} → {days[days.length - 1].day}
        </span>
      </div>
      <div className="bg-surface border-border flex h-16 items-stretch gap-[2px] rounded-lg border p-2">
        {days.map((d) => (
          <DayBox key={d.day} day={d} />
        ))}
      </div>
    </div>
  );
}

/**
 * One column in the 30-day strip. Empty days render as a neutral
 * placeholder so the chart's "what's the cadence here?" reading stays
 * honest — a sparse gap is meaningful (no runs that day), and styling
 * it the same as a day full of "other"-status runs would be a lie.
 *
 * Within a populated box, bands stripe left-to-right in time order:
 * earliest runs on the left, latest on the right. Reading direction
 * matches the outer 30-day strip (oldest-on-the-left), so the eye
 * can zoom in from "which day" to "what time of day" without
 * flipping orientation.
 */
function DayBox({ day }: { day: AgentDailyRunBands }) {
  if (day.total === 0) {
    return (
      <div
        title={`${day.day}: no runs`}
        className="bg-surface-secondary flex-1 self-stretch rounded-sm opacity-50"
      />
    );
  }
  const succeeded = day.bands
    .filter((b) => b.status === "success")
    .reduce((n, b) => n + b.count, 0);
  const failed = day.bands
    .filter((b) => b.status === "failed")
    .reduce((n, b) => n + b.count, 0);
  const other = day.total - succeeded - failed;
  const title =
    `${day.day}: ${succeeded} succeeded, ${failed} failed` +
    (other ? `, ${other} other` : "");
  return (
    <div
      title={title}
      className="flex flex-1 flex-row overflow-hidden rounded-sm"
    >
      {day.bands.map((band, i) => (
        <div
          key={i}
          className={bandColorClass(band.status)}
          style={{ flexBasis: `${(band.count / day.total) * 100}%` }}
        />
      ))}
    </div>
  );
}

function bandColorClass(status: DailyRunBand["status"]): string {
  // Tokens follow the same green/red/neutral split used in the stats
  // tiles + health header so the dashboard reads as one palette
  // regardless of which surface drew first.
  switch (status) {
    case "success":
      return "bg-[var(--color-sentiment-positive)]";
    case "failed":
      return "bg-[var(--color-sentiment-negative)]";
    case "other":
      return "bg-surface-tertiary";
  }
}

function fillThirtyDays(
  sparse: AgentDailyRunBands[],
): AgentDailyRunBands[] {
  // The DB returns only days that had runs. Fill the gaps so the strip
  // is always 30 boxes wide; empty days render as the neutral
  // placeholder DayBox draws for `total === 0`.
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const byDay = new Map(sparse.map((d) => [d.day, d]));
  const out: AgentDailyRunBands[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push(byDay.get(key) ?? { day: key, bands: [], total: 0 });
  }
  return out;
}

function TopFailingAgents({
  rows,
  workspaceSlug,
}: {
  rows: WorkspaceTopFailingAgent[];
  workspaceSlug: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-foreground-weak text-sm font-medium uppercase tracking-widest">
        Top failing agents (30d)
      </span>
      <ul className="divide-border bg-surface border-border flex flex-col divide-y overflow-hidden rounded-lg border">
        {rows.map((r) => {
          const rate = r.totalRuns > 0 ? r.failures / r.totalRuns : 0;
          return (
            <li
              key={r.agentName}
              className="flex flex-col gap-1 px-3 py-2"
            >
              <div className="flex items-baseline justify-between gap-3">
                <div className="flex min-w-0 items-baseline gap-2">
                  <Link
                    href={`/${workspaceSlug}/agents/${encodeURIComponent(r.agentName)}`}
                    className="text-foreground truncate text-sm font-medium hover:underline"
                  >
                    {r.agentName}
                  </Link>
                  <span className="text-foreground-weak text-sm">
                    ×{r.failures} failures / {r.totalRuns} runs · {Math.round(rate * 100)}%
                  </span>
                </div>
                <Link
                  href={`/${workspaceSlug}/agents/${encodeURIComponent(r.agentName)}/runs/${r.exampleRunId}`}
                  className="text-foreground-weak hover:text-foreground shrink-0 text-sm hover:underline"
                >
                  Last <LocalTime iso={r.lastSeen.toISOString()} style="relative" /> →
                </Link>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms - m * 60_000) / 1000);
  return `${m}m ${s}s`;
}
