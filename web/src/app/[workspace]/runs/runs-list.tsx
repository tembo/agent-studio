"use client";

// Client-side filter + paginate surface shared by workspace and agent runs.
// Filters navigate through the URL; pagination appends through a server action.

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState, useTransition } from "react";

import { LocalTime } from "@/components/local-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { formatCurrency } from "@/lib/pricing";
import {
  RUN_ENVIRONMENTS,
  runEnvironmentLabel,
  type RunEnvironment,
} from "@/lib/run-environment";
import {
  RUN_LIST_STATUSES,
  RUN_LIST_TRIGGERS,
  type RunListStatus,
  type RunListTrigger,
} from "@/lib/run-list-query";
import { runIdentityLabel } from "@/lib/run-identity";

import { loadRunsAction } from "./actions";
import type { LoadedRun } from "./shape";

const PAGE_SIZE = 50;
const NO_STATUSES: RunListStatus[] = [];
const NO_TRIGGERS: RunListTrigger[] = [];
const NO_ENVIRONMENTS: RunEnvironment[] = [];

type Props = {
  workspaceSlug: string;
  agentNames: string[];
  initial: LoadedRun[];
  /**
   * Initial filter values, typically read from the URL by the server
   * component so deep links (e.g. from a failed-run "find similar"
   * affordance) land prefiltered. Empty arrays / empty strings mean
   * "no filter."
   */
  initialFilters?: {
    statuses?: RunListStatus[];
    triggers?: RunListTrigger[];
    environments?: RunEnvironment[];
    agentName?: string;
    search?: string;
  };
  /**
   * When set, the list is scoped to a single agent: the Agent filter and the
   * Agent + Input columns are hidden (the per-agent Runs tab). Loads always
   * filter to this agent.
   */
  lockedAgent?: string;
};

export function RunsList({
  workspaceSlug,
  agentNames,
  initial,
  initialFilters,
  lockedAgent,
}: Props) {
  const agentScoped = Boolean(lockedAgent);
  const router = useRouter();
  const pathname = usePathname();
  const urlSearchParams = useSearchParams();
  const statuses = initialFilters?.statuses ?? NO_STATUSES;
  const triggers = initialFilters?.triggers ?? NO_TRIGGERS;
  const environments = initialFilters?.environments ?? NO_ENVIRONMENTS;
  const agentName = lockedAgent ?? initialFilters?.agentName ?? "";
  const activeSearch = initialFilters?.search ?? "";
  const [search, setSearch] = useState(activeSearch);

  const [rows, setRows] = useState<LoadedRun[]>(initial);
  const [more, setMore] = useState<boolean>(initial.length >= PAGE_SIZE);
  const [pending, startTransition] = useTransition();

  const navigateWithFilters = useCallback(
    (
      updates: Partial<
        Record<
          "status" | "trigger" | "environment" | "agent" | "q",
          string | null
        >
      >,
    ) => {
      const next = new URLSearchParams(urlSearchParams.toString());
      for (const [name, value] of Object.entries(updates)) {
        if (value) next.set(name, value);
        else next.delete(name);
      }
      const query = next.toString();
      startTransition(() => {
        router.replace(query ? `${pathname}?${query}` : pathname, {
          scroll: false,
        });
      });
    },
    [pathname, router, urlSearchParams],
  );

  const onLoadMore = useCallback(() => {
    if (rows.length === 0) return;
    const last = rows[rows.length - 1];
    startTransition(async () => {
      const next = await loadRunsAction({
        workspaceSlug,
        filters: {
          statuses: statuses.length ? statuses : undefined,
          triggers: triggers.length ? triggers : undefined,
          environments: environments.length ? environments : undefined,
          agentName: agentName || undefined,
          search: activeSearch || undefined,
        },
        beforeIso: last.createdAt,
      });
      setRows((prev) => [...prev, ...next]);
      setMore(next.length >= PAGE_SIZE);
    });
  }, [
    rows,
    workspaceSlug,
    statuses,
    triggers,
    environments,
    agentName,
    activeSearch,
  ]);

  const hasFilters =
    statuses.length > 0 ||
    triggers.length > 0 ||
    environments.length > 0 ||
    (!agentScoped && agentName !== "") ||
    activeSearch !== "";

  // Longest completed duration in the current row set — used to scale
  // the bar-chart background on the Duration cell. Memoised so a tall
  // re-sort of `rows` doesn't recompute on every cell render.
  const maxDurationMs = useMemo(() => {
    let max = 0;
    for (const r of rows) {
      if (r.startedAt && r.completedAt) {
        const d =
          new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime();
        if (d > max) max = d;
      }
    }
    return max;
  }, [rows]);

  // Same idea for cost — scale the Cost cell's background bar against
  // the highest cost in view. Runs without a recorded cost contribute
  // nothing (cost shows as "—").
  const maxCostUsd = useMemo(() => {
    let max = 0;
    for (const r of rows) {
      if (r.costUsd !== null && r.costUsd > max) max = r.costUsd;
    }
    return max;
  }, [rows]);

  // Stable agent options array (incl. "All agents" sentinel).
  const agentOptions = useMemo(
    () => [
      { value: "", label: "All agents" },
      ...agentNames.map((n) => ({ value: n, label: n })),
    ],
    [agentNames],
  );

  // Column definitions — conditional columns are included/excluded based on
  // agentScoped so the list stays consistent across the global Runs page and
  // the per-agent Runs tab.
  const columns = useMemo<Column<LoadedRun>[]>(() => {
    const cols: Column<LoadedRun>[] = [];

    cols.push({
      key: "status",
      header: "Status",
      cell: (run) => (
        <Badge variant={STATUS_BADGE[run.status]} size="small">
          {STATUS_LABELS[run.status]}
        </Badge>
      ),
    });

    if (!agentScoped) {
      cols.push({
        key: "agent",
        header: "Agent",
        cell: (run) => {
          const agentHref = `/${workspaceSlug}/agents/${encodeURIComponent(run.agentName)}`;
          return (
            <Link
              href={agentHref}
              onClick={(e) => e.stopPropagation()}
              className="text-foreground hover:underline"
            >
              {run.agentName}
            </Link>
          );
        },
      });
    }

    cols.push({
      key: "source",
      header: "Source",
      cell: (run) => <SourceCell run={run} />,
    });

    if (!agentScoped) {
      cols.push({
        key: "input",
        header: "Input",
        tdClassName: "text-foreground max-w-md",
        cell: (run) => (
          <>
            {run.userMessagePreview ? (
              <div className="truncate">{run.userMessagePreview}</div>
            ) : !run.errorMessagePreview ? (
              <span className="text-foreground-muted">—</span>
            ) : null}
            {run.errorMessagePreview && (
              <div className="text-foreground-sentiment-negative mt-0.5 line-clamp-2 font-mono text-sm leading-4">
                {run.errorMessagePreview}
              </div>
            )}
          </>
        ),
      });
    }

    cols.push({
      key: "queued",
      header: "Queued",
      tdClassName: "text-foreground-weak",
      cell: (run) => <LocalTime iso={run.createdAt} style="relative" />,
    });

    cols.push({
      key: "duration",
      header: "Duration",
      tdClassName: "text-foreground-weak relative",
      cell: (run) => {
        const durationMs =
          run.startedAt && run.completedAt
            ? new Date(run.completedAt).getTime() -
              new Date(run.startedAt).getTime()
            : null;
        if (durationMs !== null && maxDurationMs > 0) {
          return (
            <>
              <span
                aria-hidden
                className="bg-interactive-state-hover absolute inset-y-1 left-1 rounded-sm"
                style={{
                  width: `calc(${Math.max(2, (durationMs / maxDurationMs) * 100)}% - 8px)`,
                }}
              />
              <span className="relative">{formatDuration(durationMs)}</span>
            </>
          );
        }
        if (run.startedAt) return <span>Running</span>;
        return <span className="text-foreground-muted">—</span>;
      },
    });

    cols.push({
      key: "cost",
      header: "Cost",
      tdClassName: "text-foreground-weak relative",
      cell: (run) => {
        if (run.costUsd !== null && maxCostUsd > 0) {
          return (
            <>
              <span
                aria-hidden
                className="bg-interactive-state-hover absolute inset-y-1 left-1 rounded-sm"
                style={{
                  width: `calc(${Math.max(2, (run.costUsd / maxCostUsd) * 100)}% - 8px)`,
                }}
              />
              <span className="relative">{formatCurrency(run.costUsd)}</span>
            </>
          );
        }
        return <span className="text-foreground-muted">—</span>;
      },
    });

    return cols;
  }, [agentScoped, workspaceSlug, maxDurationMs, maxCostUsd]);

  return (
    <div className="flex flex-col gap-5">
      {/* Filter row */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-foreground-weak w-20 shrink-0 text-sm uppercase tracking-wide">
            Status
          </span>
          {RUN_LIST_STATUSES.map((status) => (
            <FilterChip
              key={status}
              active={statuses.includes(status)}
              onClick={() => {
                const next = toggle(status, statuses);
                navigateWithFilters({
                  status: next.length > 0 ? next.join(",") : null,
                });
              }}
              label={STATUS_LABELS[status]}
            />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-foreground-weak w-20 shrink-0 text-sm uppercase tracking-wide">
            Environment
          </span>
          {RUN_ENVIRONMENTS.map((environment) => (
            <FilterChip
              key={environment}
              active={environments.includes(environment)}
              onClick={() => {
                const next = toggle(environment, environments);
                navigateWithFilters({
                  environment: next.length > 0 ? next.join(",") : null,
                });
              }}
              label={runEnvironmentLabel(environment)}
            />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-foreground-weak w-20 shrink-0 text-sm uppercase tracking-wide">
            Trigger
          </span>
          {RUN_LIST_TRIGGERS.map((trigger) => (
            <FilterChip
              key={trigger}
              active={triggers.includes(trigger)}
              onClick={() => {
                const next = toggle(trigger, triggers);
                navigateWithFilters({
                  trigger: next.length > 0 ? next.join(",") : null,
                });
              }}
              label={TRIGGER_LABELS[trigger]}
            />
          ))}
        </div>

        {!agentScoped && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-foreground-weak w-20 shrink-0 text-sm uppercase tracking-wide">
              Agent
            </span>
            <Select
              value={agentName}
              onValueChange={(value) =>
                navigateWithFilters({ agent: value || null })
              }
              options={agentOptions}
              ariaLabel="Filter by agent"
              className="min-w-[200px]"
            />
          </div>
        )}

        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            navigateWithFilters({ q: search.trim() || null });
          }}
        >
          <label
            htmlFor="run-search"
            className="text-foreground-weak w-20 shrink-0 text-sm uppercase tracking-wide"
          >
            Search
          </label>
          <Input
            id="run-search"
            type="search"
            placeholder="Agent, run ID, Run as, input, output, or error…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-sm"
            maxLength={200}
          />
          <Button type="submit" variant="secondary" size="small">
            Search
          </Button>
          {activeSearch && (
            <Button
              type="button"
              variant="ghost"
              size="small"
              onClick={() => {
                setSearch("");
                navigateWithFilters({ q: null });
              }}
            >
              Clear
            </Button>
          )}
        </form>
      </div>

      <hr className="border-[var(--color-border-weak)]" />

      {/* Result count + table */}
      <div className="text-foreground-weak text-sm">
        {pending
          ? "Loading…"
          : rows.length === 0
            ? hasFilters
              ? "No runs match these filters."
              : "No runs yet."
            : `${rows.length} run${rows.length === 1 ? "" : "s"}${more ? "+" : ""}`}
      </div>

      {rows.length > 0 && (
        <DataTable
          columns={columns}
          rows={rows}
          getRowKey={(r) => r.id}
          rowHref={(r) => {
            const agentHref = `/${workspaceSlug}/agents/${encodeURIComponent(r.agentName)}`;
            return `${agentHref}/runs/${r.id}`;
          }}
        />
      )}

      {more && rows.length > 0 && (
        <div className="flex justify-center pt-2">
          <Button
            type="button"
            variant="secondary"
            onClick={onLoadMore}
            disabled={pending}
          >
            {pending ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}

// Source = how the run was instigated + who it acted as, plus a deep link
// back to the Slack conversation when one started it. Slack runs are
// trigger=event *with* a slack_delivery row; other events are webhooks.
function SourceCell({ run }: { run: LoadedRun }) {
  const who = runIdentityLabel(run.createdByName, run.createdByEmail);
  const slack = run.slack;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5">
        {slack ? (
          <Badge variant="green" size="small">
            Slack
          </Badge>
        ) : run.trigger === "schedule" ? (
          <Badge variant="blue" size="small">
            Scheduled
          </Badge>
        ) : run.trigger === "event" ? (
          <Badge variant="purple" size="small">
            Event
          </Badge>
        ) : (
          <span className="text-foreground-weak text-sm">Manual</span>
        )}
        {/* For Slack, the bot name doubles as the deep link to the thread. */}
        {slack &&
          (slack.permalink ? (
            <a
              href={slack.permalink}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(e) => e.stopPropagation()}
              title={`Open in Slack — ${slack.appName}`}
              className="text-foreground-weak hover:text-foreground text-sm hover:underline"
            >
              {slack.appName} ↗
            </a>
          ) : (
            <span className="text-foreground-muted text-sm">{slack.appName}</span>
          ))}
      </span>
      <span
        className="text-foreground-muted truncate text-sm"
        title={`Run as ${who}`}
      >
        Run as {who}
      </span>
      {run.agentVersionLabel && (
        <span className="text-foreground-muted font-mono text-xs">
          {run.agentVersionLabel}
        </span>
      )}
      <Badge
        variant={run.runEnvironment === "production" ? "gray" : "yellow"}
        size="small"
      >
        {runEnvironmentLabel(run.runEnvironment)}
      </Badge>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        active
          ? "bg-interactive text-foreground-on-accent border-interactive rounded-md border px-2.5 py-1 text-sm font-medium"
          : "text-foreground hover:bg-surface-raised border-border rounded-md border px-2.5 py-1 text-sm font-medium"
      }
    >
      {label}
    </button>
  );
}

function toggle<T>(value: T, list: T[]): T[] {
  return list.includes(value)
    ? list.filter((item) => item !== value)
    : [...list, value];
}

const STATUS_LABELS: Record<RunListStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

const TRIGGER_LABELS: Record<RunListTrigger, string> = {
  manual: "Manual",
  schedule: "Scheduled",
  event: "Event",
};

const STATUS_BADGE: Record<
  RunListStatus,
  "green" | "red" | "yellow" | "blue" | "gray"
> = {
  queued: "yellow",
  running: "blue",
  succeeded: "green",
  failed: "red",
  cancelled: "gray",
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms - m * 60_000) / 1000);
  return `${m}m ${s}s`;
}
