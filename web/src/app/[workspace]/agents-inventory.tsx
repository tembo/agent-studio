"use client";

import Link from "next/link";
import {
  useActionState,
  useMemo,
  useState,
  useTransition,
  type ReactNode,
} from "react";

import { IconApiConnection, IconPlusLarge, IconStar } from "central-icons";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type Column, type SortDir } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { mcpLogoUrl } from "@/lib/mcp-logo";
import { formatCurrency } from "@/lib/pricing";
import { cn } from "@/lib/utils";

import { toggleAgentStarAction } from "./agent-stars-actions";
import {
  AgentInventoryNameCell,
  inventoryAgentSearchText,
} from "./agent-inventory-name-cell";
import { dismissPendingCreateAction } from "./inventory-actions";

// Workspace agent switchboard. Browse keeps the scan path compact and moves
// configuration into a selected-agent pane; Performance keeps the sortable
// operational metrics together instead of repeating them across every view.

export type McpIcon = {
  /** Provider slug for the logo (e.g. "attio", "linear"). */
  slug: string;
  /** Human label for the tooltip / filter (e.g. "Attio"). */
  label: string;
};

export type InventoryAgent =
  | {
      kind: "live";
      // Used as the React key. Stable across renders.
      path: string;
      filename: string;
      /** The slug identifier (matches the filename); used for links + lookup. */
      name: string;
      /** Free-text display name (spec `title:`), falls back to the slug. */
      displayName: string;
      /** Agent summary from the spec, when present. */
      description: string | null;
      detailHref: string;
      frameworkLabel: string;
      /** Spec labels (for grouping + Slack-app scoping). */
      labels: string[];
      /** MCP/provider connections declared on this agent's own spec. */
      mcps: McpIcon[];
      /** MCPs reached one level down: providers this agent's sub-agents use
       *  (derived from the parent_run_id graph). Empty for non-orchestrators. */
      subMcps: McpIcon[];
      model: string | null;
      /** 30-day window. Zero when the agent has never run in that window. */
      runs30d: number;
      succeeded30d: number;
      failed30d: number;
      /** Avg estimated USD cost over 30d runs that have a cost (null = none). */
      avgCostUsd30d: number | null;
      /** Latest run regardless of window. Null when never run. */
      lastRun:
        | {
            status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
            createdAtIso: string;
          }
        | null;
      /** This user starred the agent (a personal visibility flag). */
      isStarred: boolean;
      /** This user owns the agent (its agent_owner row). */
      isMine: boolean;
      /** Live draft differs from stable, or has never been promoted. */
      pendingPromotion: {
        href: string;
        stableVersionNumber: number | null;
        stableChangedAtIso: string | null;
        draftChangedAtIso: string | null;
        addedLines: number;
        removedLines: number;
      } | null;
    }
  | {
      kind: "invalid";
      path: string;
      filename: string;
      error: string;
      detail?: string;
    }
  | {
      kind: "pending-create";
      // Unique key (improvement row id).
      key: string;
      name: string;
      path: string;
      frameworkLabel: string;
      createdAtIso: string;
      status: "submitted" | "pr_opened";
      temboTaskHtmlUrl: string | null;
      prUrl: string | null;
      prNumber: number | null;
    };

type StatusBucket = "active" | "idle" | "error" | "pending" | "invalid";

type SortKey =
  | "status"
  | "name"
  | "runs"
  | "cost"
  | "success"
  | "last-run";

type EnrichedRow = { agent: InventoryAgent; bucket: StatusBucket };
type InventoryMode = "browse" | "performance" | "changes";

type Props = {
  agents: InventoryAgent[];
  newAgentHref: string;
  /** Show the "New agent" button. Requires operator+ AND a Tembo API
   *  key (chat-to-create runs through Tembo CAP). */
  canCreate: boolean;
  workspaceSlug: string;
  /** Operator+; gates the "Dismiss" action on pending-create rows. */
  canEdit: boolean;
  /** Deep links from the sidebar open the complete pending-promotion set. */
  initialPromotionOnly?: boolean;
};

export function AgentsInventory({
  agents,
  newAgentHref,
  canCreate,
  workspaceSlug,
  canEdit,
  initialPromotionOnly = false,
}: Props) {
  const [query, setQuery] = useState("");
  const [bucket, setBucket] = useState<StatusBucket | null>(null);
  const [labelFilter, setLabelFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [mcpFilter, setMcpFilter] = useState("");
  const [mode, setMode] = useState<InventoryMode>(
    initialPromotionOnly ? "changes" : "browse",
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [view, setView] = useState<"mine" | "all">(
    !initialPromotionOnly &&
      agents.some((a) => a.kind === "live" && (a.isMine || a.isStarred))
      ? "mine"
      : "all",
  );

  const enriched = useMemo(
    () => agents.map((a) => ({ agent: a, bucket: statusBucket(a) })),
    [agents],
  );

  const counts = useMemo(() => {
    const c: Record<StatusBucket | "all", number> = {
      all: enriched.length,
      active: 0,
      idle: 0,
      error: 0,
      pending: 0,
      invalid: 0,
    };
    for (const { bucket } of enriched) c[bucket]++;
    return c;
  }, [enriched]);
  const pendingPromotionCount = useMemo(
    () =>
      enriched.filter(
        ({ agent }) =>
          agent.kind === "live" && agent.pendingPromotion !== null,
      ).length,
    [enriched],
  );

  const labelOptions = useMemo(() => {
    const set = new Set<string>();
    for (const { agent } of enriched) {
      if (agent.kind === "live") for (const l of agent.labels) set.add(l);
    }
    return [
      { value: "", label: "All labels" },
      ...[...set].sort().map((l) => ({ value: l, label: l })),
    ];
  }, [enriched]);
  const modelOptions = useMemo(() => {
    const set = new Set<string>();
    for (const { agent } of enriched) {
      if (agent.kind === "live" && agent.model) set.add(agent.model);
    }
    return [
      { value: "", label: "All models" },
      ...[...set].sort().map((m) => ({ value: m, label: shortModel(m) })),
    ];
  }, [enriched]);
  const mcpOptions = useMemo(() => {
    const labels = new Map<string, string>();
    for (const { agent } of enriched) {
      if (agent.kind !== "live") continue;
      for (const m of [...agent.mcps, ...agent.subMcps]) {
        if (!labels.has(m.slug)) labels.set(m.slug, m.label);
      }
    }
    return [
      { value: "", label: "All MCPs" },
      ...[...labels.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([slug, label]) => ({ value: slug, label })),
    ];
  }, [enriched]);

  const filtered = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let rows = terms.length
      ? enriched.filter(({ agent }) => {
          const text = inventoryAgentSearchText(agent).toLowerCase();
          return terms.every((term) => text.includes(term));
        })
      : enriched;
    if (view === "mine") {
      rows = rows.filter(
        ({ agent }) => agent.kind !== "live" || agent.isMine || agent.isStarred,
      );
    }
    if (mode === "changes") {
      rows = rows.filter(
        ({ agent }) =>
          agent.kind === "live" && agent.pendingPromotion !== null,
      );
    }
    if (bucket !== null) rows = rows.filter((e) => e.bucket === bucket);
    if (labelFilter) {
      rows = rows.filter(
        ({ agent }) =>
          agent.kind === "live" && agent.labels.includes(labelFilter),
      );
    }
    if (modelFilter) {
      rows = rows.filter(
        ({ agent }) => agent.kind === "live" && agent.model === modelFilter,
      );
    }
    if (mcpFilter) {
      rows = rows.filter(
        ({ agent }) =>
          agent.kind === "live" &&
          [...agent.mcps, ...agent.subMcps].some((m) => m.slug === mcpFilter),
      );
    }
    return [...rows].sort((a, b) =>
      compareRows(a.agent, b.agent, a.bucket, b.bucket, sortKey, sortDir),
    );
  }, [
    enriched,
    query,
    view,
    mode,
    bucket,
    labelFilter,
    modelFilter,
    mcpFilter,
    sortKey,
    sortDir,
  ]);

  function onHeaderClick(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Most columns are most useful when sorted with the "worst" or
      // "newest" at the top: error/invalid first, biggest run count
      // first, lowest success rate first, newest activity first.
      setSortDir(
        key === "name"
          ? "asc"
          : key === "status"
            ? "asc"
            : key === "runs" || key === "last-run" || key === "cost"
              ? "desc"
              : "asc",
      );
    }
  }

  function onSort(key: string) {
    onHeaderClick(key as SortKey);
  }

  function selectMode(nextMode: InventoryMode) {
    setMode(nextMode);
    setSelectedKey(null);
    setMobileDetailsOpen(false);
    if (nextMode === "changes") setView("all");
    if (nextMode === "performance") {
      setSortKey("last-run");
      setSortDir("desc");
    } else {
      setSortKey("name");
      setSortDir("asc");
    }
  }

  const performanceColumns: Column<EnrichedRow>[] = [
    {
      key: "star",
      header: "",
      tdClassName: "w-8 pr-0",
      cell: ({ agent }) =>
        agent.kind === "live" ? (
          <StarButton
            workspaceSlug={workspaceSlug}
            agentName={agent.name}
            starred={agent.isStarred}
          />
        ) : null,
    },
    {
      key: "name",
      header: "Name",
      sortable: true,
      cell: ({ agent }) => {
        if (agent.kind === "invalid") {
          return (
            <span className="text-foreground font-mono text-sm">
              {agent.filename}
            </span>
          );
        }
        if (agent.kind === "pending-create") {
          return (
            <span className="text-foreground text-sm font-medium">
              {agent.name}
            </span>
          );
        }
        return <AgentInventoryNameCell agent={agent} />;
      },
    },
    {
      key: "status",
      header: "Status",
      sortable: true,
      thClassName: "w-[120px]",
      cell: ({ bucket }) => <StatusCell bucket={bucket} />,
    },
    {
      key: "runs",
      header: "Runs 30d",
      sortable: true,
      align: "right",
      cell: ({ agent }) => {
        if (agent.kind !== "live") {
          return <span className="text-foreground-muted">—</span>;
        }
        return (
          <span className="text-foreground font-mono text-sm">
            {agent.runs30d.toLocaleString("en-US")}
          </span>
        );
      },
    },
    {
      key: "cost",
      header: "Avg cost/run",
      sortable: true,
      align: "right",
      cell: ({ agent }) => {
        if (agent.kind !== "live" || agent.avgCostUsd30d === null) {
          return <span className="text-foreground-muted">—</span>;
        }
        return (
          <span className="text-foreground font-mono text-sm">
            {formatCurrency(agent.avgCostUsd30d)}
          </span>
        );
      },
    },
    {
      key: "success",
      header: "Success",
      sortable: true,
      align: "right",
      cell: ({ agent }) => {
        if (agent.kind !== "live") {
          return <span className="text-foreground-muted">—</span>;
        }
        const successRate =
          agent.runs30d > 0 ? agent.succeeded30d / agent.runs30d : null;
        return successRate === null ? (
          <span className="text-foreground-muted">—</span>
        ) : (
          <SuccessCell rate={successRate} failed={agent.failed30d} />
        );
      },
    },
    {
      key: "last-run",
      header: "Last run",
      sortable: true,
      align: "right",
      cell: ({ agent, bucket: rowBucket }) => {
        if (agent.kind === "invalid") {
          return <span className="text-foreground-muted">—</span>;
        }
        if (agent.kind === "pending-create") {
          return (
            <span className="inline-flex flex-wrap items-center justify-end gap-3">
              <PendingLinks agent={agent} />
              {canEdit && (
                <DismissPendingButton
                  workspaceSlug={workspaceSlug}
                  improvementId={agent.key}
                  agentName={agent.name}
                />
              )}
            </span>
          );
        }
        // live
        void rowBucket;
        return agent.lastRun ? (
          <span
            className="text-foreground-weak text-sm"
            title={new Date(agent.lastRun.createdAtIso).toLocaleString()}
            suppressHydrationWarning
          >
            {formatRelativeAgo(agent.lastRun.createdAtIso)}
          </span>
        ) : (
          <span className="text-foreground-muted">Never</span>
        );
      },
    },
  ];

  const activeAdvancedFilters = [labelFilter, modelFilter, mcpFilter].filter(
    Boolean,
  ).length;

  const emptyState = (
    <div className="text-foreground-weak flex flex-col items-center gap-2 rounded-lg border border-dashed border-[var(--color-border)] px-4 py-8 text-center text-sm">
      {agents.length === 0 ? (
        <>
          <p>No agents yet.</p>
          {canCreate && (
            <div className="flex flex-col items-center gap-1">
              <Link
                href={`/${workspaceSlug}/library`}
                className="text-foreground font-medium hover:underline"
              >
                Browse the agent library →
              </Link>
              <Link
                href={newAgentHref}
                className="text-foreground-muted hover:text-foreground hover:underline"
              >
                or describe your own
              </Link>
            </div>
          )}
        </>
      ) : (
        "No agents match these filters."
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Input
          type="search"
          placeholder="Search name, label, or connection…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-sm"
          aria-label="Search agents"
        />
        {canCreate && (
          <Button asChild>
            <Link href={newAgentHref}>
              <IconPlusLarge size={16} />
              <span>New agent</span>
            </Link>
          </Button>
        )}
      </div>

      <div
        role="tablist"
        aria-label="Agent inventory view"
        className="border-border flex items-end gap-6 border-b"
      >
        <InventoryTab
          active={mode === "browse"}
          label="Browse"
          count={agents.length}
          onClick={() => selectMode("browse")}
        />
        <InventoryTab
          active={mode === "performance"}
          label="Performance"
          onClick={() => selectMode("performance")}
        />
        <InventoryTab
          active={mode === "changes"}
          label="Changes"
          count={pendingPromotionCount}
          tone={pendingPromotionCount > 0 ? "caution" : "neutral"}
          onClick={() => selectMode("changes")}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="border-border inline-flex overflow-hidden rounded-full border text-sm">
          <button
            type="button"
            onClick={() => setView("mine")}
            className={`px-3 py-1.5 ${
              view === "mine"
                ? "bg-interactive text-foreground-on-accent"
                : "text-foreground-weak hover:text-foreground"
            }`}
          >
            Mine + Starred
          </button>
          <button
            type="button"
            onClick={() => setView("all")}
            className={`px-3 py-1.5 ${
              view === "all"
                ? "bg-interactive text-foreground-on-accent"
                : "text-foreground-weak hover:text-foreground"
            }`}
          >
            All
          </button>
        </div>
        <FacetPills counts={counts} active={bucket} onChange={setBucket} />
        <button
          type="button"
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((open) => !open)}
          className="border-border text-foreground-weak hover:text-foreground rounded-full border bg-surface px-3 py-1.5 text-sm"
        >
          Filters{activeAdvancedFilters > 0 ? ` · ${activeAdvancedFilters}` : ""}
        </button>
      </div>

      {filtersOpen && (
        <div className="border-border bg-surface-raised grid gap-3 rounded-lg border p-3 sm:grid-cols-3">
          {labelOptions.length > 1 && (
            <Select
              value={labelFilter}
              onValueChange={setLabelFilter}
              options={labelOptions}
              ariaLabel="Filter by label"
            />
          )}
          {modelOptions.length > 1 && (
            <Select
              value={modelFilter}
              onValueChange={setModelFilter}
              options={modelOptions}
              ariaLabel="Filter by model"
            />
          )}
          {mcpOptions.length > 1 && (
            <Select
              value={mcpFilter}
              onValueChange={setMcpFilter}
              options={mcpOptions}
              ariaLabel="Filter by MCP"
            />
          )}
        </div>
      )}

      {mode === "performance" ? (
        <>
          <div className="hidden md:block">
            <DataTable
              columns={performanceColumns}
              rows={filtered}
              getRowKey={({ agent }) => rowKey(agent)}
              rowHref={({ agent }) =>
                agent.kind === "live" ? agent.detailHref : null
              }
              rowClassName={({ bucket: rowBucket }) =>
                rowBucket === "invalid"
                  ? "bg-[var(--color-input-error)]/30 hover:bg-[var(--color-input-error)]/50"
                  : ""
              }
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={onSort}
              empty={emptyState}
            />
          </div>
          <MobilePerformanceList rows={filtered} />
        </>
      ) : filtered.length > 0 ? (
        <InventoryBrowser
          rows={filtered}
          selectedKey={selectedKey}
          mobileDetailsOpen={mobileDetailsOpen}
          workspaceSlug={workspaceSlug}
          canEdit={canEdit}
          onSelect={(key) => {
            setSelectedKey(key);
            setMobileDetailsOpen(true);
          }}
          onCloseMobileDetails={() => setMobileDetailsOpen(false)}
          onSortName={() => onHeaderClick("name")}
          sortDir={sortDir}
        />
      ) : (
        emptyState
      )}
    </div>
  );
}

function MobilePerformanceList({ rows }: { rows: EnrichedRow[] }) {
  return (
    <div className="border-border overflow-hidden rounded-lg border md:hidden">
      {rows.map(({ agent, bucket }) => {
        const title =
          agent.kind === "invalid"
            ? agent.filename
            : agent.kind === "live"
              ? agent.displayName
              : agent.name;
        const body = (
          <>
            <div className="flex items-start justify-between gap-3">
              <span className="text-foreground min-w-0 truncate text-sm font-medium">
                {title}
              </span>
              <StatusPill bucket={bucket} />
            </div>
            {agent.kind === "live" && (
              <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                <MobileMetric label="Runs" value={agent.runs30d.toLocaleString("en-US")} />
                <MobileMetric
                  label="Success"
                  value={
                    agent.runs30d > 0
                      ? `${Math.round((agent.succeeded30d / agent.runs30d) * 100)}%`
                      : "—"
                  }
                />
                <MobileMetric
                  label="Last run"
                  value={agent.lastRun ? formatRelativeAgo(agent.lastRun.createdAtIso) : "Never"}
                />
              </div>
            )}
          </>
        );
        return agent.kind === "live" ? (
          <Link
            key={rowKey(agent)}
            href={agent.detailHref}
            className="border-border-weak hover:bg-interactive-state-hover block border-b bg-surface-raised p-3 last:border-b-0"
          >
            {body}
          </Link>
        ) : (
          <div
            key={rowKey(agent)}
            className="border-border-weak border-b bg-surface-raised p-3 last:border-b-0"
          >
            {body}
          </div>
        );
      })}
    </div>
  );
}

function MobileMetric({ label, value }: { label: string; value: string }) {
  return (
    <span className="border-border min-w-0 rounded border bg-surface p-2">
      <span className="text-foreground-muted block uppercase tracking-wide">{label}</span>
      <span className="text-foreground mt-1 block truncate font-mono">{value}</span>
    </span>
  );
}

function InventoryTab({
  active,
  label,
  count,
  tone = "neutral",
  onClick,
}: {
  active: boolean;
  label: string;
  count?: number;
  tone?: "neutral" | "caution";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "-mb-px flex items-center gap-1.5 border-b-2 px-0.5 pb-2 text-sm font-medium",
        active
          ? "border-foreground text-foreground"
          : "text-foreground-weak hover:text-foreground border-transparent",
      )}
    >
      {label}
      {count !== undefined && (
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 text-xs",
            tone === "caution" && count > 0
              ? "bg-[var(--color-sentiment-caution-subtle)] text-[var(--color-foreground-sentiment-caution)]"
              : "bg-surface-secondary text-foreground-muted",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function InventoryBrowser({
  rows,
  selectedKey,
  mobileDetailsOpen,
  workspaceSlug,
  canEdit,
  onSelect,
  onCloseMobileDetails,
  onSortName,
  sortDir,
}: {
  rows: EnrichedRow[];
  selectedKey: string | null;
  mobileDetailsOpen: boolean;
  workspaceSlug: string;
  canEdit: boolean;
  onSelect: (key: string) => void;
  onCloseMobileDetails: () => void;
  onSortName: () => void;
  sortDir: SortDir;
}) {
  const selected =
    rows.find(({ agent }) => rowKey(agent) === selectedKey) ?? rows[0];
  const effectiveKey = rowKey(selected.agent);

  return (
    <div className="border-border relative grid min-h-[34rem] overflow-hidden rounded-lg border bg-surface lg:grid-cols-[minmax(0,1.2fr)_minmax(20rem,0.8fr)]">
      <section className="border-border min-w-0 border-r-0 lg:border-r">
        <div className="border-border text-foreground-weak flex items-center justify-between border-b bg-surface-secondary px-4 py-2 text-xs font-medium uppercase tracking-wide">
          <span>
            {rows.length} {rows.length === 1 ? "agent" : "agents"}
          </span>
          <button
            type="button"
            onClick={onSortName}
            className="hover:text-foreground"
            aria-label={`Sort agent names ${sortDir === "asc" ? "descending" : "ascending"}`}
          >
            {sortDir === "asc" ? "A–Z ↑" : "Z–A ↓"}
          </button>
        </div>
        <div className="max-h-[42rem] overflow-y-auto">
          {rows.map((row) => (
            <InventoryBrowseRow
              key={rowKey(row.agent)}
              row={row}
              selected={rowKey(row.agent) === effectiveKey}
              workspaceSlug={workspaceSlug}
              onSelect={() => onSelect(rowKey(row.agent))}
            />
          ))}
        </div>
      </section>

      <InventoryDetails
        row={selected}
        mobileOpen={mobileDetailsOpen}
        workspaceSlug={workspaceSlug}
        canEdit={canEdit}
        onCloseMobile={onCloseMobileDetails}
      />
    </div>
  );
}

function InventoryBrowseRow({
  row,
  selected,
  workspaceSlug,
  onSelect,
}: {
  row: EnrichedRow;
  selected: boolean;
  workspaceSlug: string;
  onSelect: () => void;
}) {
  const { agent, bucket } = row;
  const title =
    agent.kind === "invalid" ? agent.filename : agent.kind === "live" ? agent.displayName : agent.name;
  const subtitle = agent.kind === "live" ? agent.name : agent.path;
  const labels = agent.kind === "live" ? agent.labels.slice(0, 2) : [];
  const mcps = agent.kind === "live" ? [...agent.mcps, ...agent.subMcps].slice(0, 3) : [];

  return (
    <div
      className={cn(
        "border-border-weak grid grid-cols-[2rem_minmax(0,1fr)] border-b bg-surface-raised transition-colors last:border-b-0",
        selected
          ? "bg-[var(--color-sentiment-positive-subtle)] shadow-[inset_3px_0_0_var(--color-sentiment-positive)]"
          : "hover:bg-interactive-state-hover",
        bucket === "invalid" && "bg-[var(--color-input-error)]/30",
      )}
    >
      <div className="flex justify-center pt-4">
        {agent.kind === "live" ? (
          <StarButton
            workspaceSlug={workspaceSlug}
            agentName={agent.name}
            starred={agent.isStarred}
          />
        ) : (
          <span className="mt-1 h-1.5 w-1.5 rounded-full bg-[var(--color-foreground-muted)]" />
        )}
      </div>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-3 py-3 pr-3 text-left"
      >
        <span className="min-w-0">
          <span className="text-foreground block truncate text-sm font-medium">
            {title}
          </span>
          <span className="text-foreground-muted mt-0.5 block truncate font-mono text-xs">
            {subtitle}
          </span>
          <span className="mt-2 flex min-w-0 items-center gap-1 overflow-hidden">
            <StatusPill bucket={bucket} />
            {labels.map((label) => (
              <span
                key={label}
                className="border-border text-foreground-weak max-w-28 truncate rounded border bg-surface px-1.5 py-0.5 text-xs"
              >
                {label}
              </span>
            ))}
            {agent.kind === "live" && agent.labels.length > labels.length && (
              <span className="text-foreground-muted text-xs">
                +{agent.labels.length - labels.length}
              </span>
            )}
          </span>
        </span>
        {mcps.length > 0 && (
          <span className="hidden items-center gap-1 pt-1 sm:flex">
            {mcps.map((m) => (
              <span
                key={m.slug}
                className="border-border flex h-7 w-7 items-center justify-center rounded-md border bg-surface"
              >
                <McpLogo icon={m} />
              </span>
            ))}
          </span>
        )}
      </button>
    </div>
  );
}

function InventoryDetails({
  row,
  mobileOpen,
  workspaceSlug,
  canEdit,
  onCloseMobile,
}: {
  row: EnrichedRow;
  mobileOpen: boolean;
  workspaceSlug: string;
  canEdit: boolean;
  onCloseMobile: () => void;
}) {
  const { agent, bucket } = row;
  return (
    <aside
      aria-label="Selected agent details"
      className={cn(
        "bg-surface-raised absolute inset-0 z-10 min-w-0 flex-col lg:static lg:flex",
        mobileOpen ? "flex" : "hidden",
      )}
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-foreground-category-green text-xs font-medium uppercase tracking-wide">
              Selected agent
            </p>
            <h2 className="text-foreground-title mt-1 truncate text-xl font-semibold">
              {agent.kind === "invalid"
                ? agent.filename
                : agent.kind === "live"
                  ? agent.displayName
                  : agent.name}
            </h2>
            <p className="text-foreground-muted mt-1 truncate font-mono text-xs">
              {agent.kind === "live" ? agent.name : agent.path}
            </p>
          </div>
          <button
            type="button"
            onClick={onCloseMobile}
            aria-label="Close agent details"
            className="border-border text-foreground-weak hover:text-foreground rounded-md border px-2 py-1 lg:hidden"
          >
            ×
          </button>
        </div>

        {agent.kind === "live" ? (
          <LiveAgentDetails agent={agent} bucket={bucket} />
        ) : agent.kind === "pending-create" ? (
          <div className="mt-5 flex flex-col gap-4">
            <StatusPill bucket={bucket} />
            <p className="text-foreground-weak text-sm">
              Submitted {formatRelativeAgo(agent.createdAtIso)} using {agent.frameworkLabel}.
            </p>
            <PendingLinks agent={agent} />
            {canEdit && (
              <DismissPendingButton
                workspaceSlug={workspaceSlug}
                improvementId={agent.key}
                agentName={agent.name}
              />
            )}
          </div>
        ) : (
          <div className="mt-5 flex flex-col gap-3">
            <StatusPill bucket={bucket} />
            <p className="text-sentiment-negative text-sm">{agent.error}</p>
            {agent.detail && (
              <p className="text-foreground-weak whitespace-pre-wrap text-sm">{agent.detail}</p>
            )}
          </div>
        )}
      </div>

      {agent.kind === "live" && (
        <div className="border-border grid grid-cols-2 gap-2 border-t p-4">
          <Button variant="secondary" asChild>
            <Link href={`/${workspaceSlug}/runs?agent=${encodeURIComponent(agent.name)}`}>
              Run history
            </Link>
          </Button>
          <Button variant="primary" asChild>
            <Link href={agent.detailHref}>Open agent</Link>
          </Button>
        </div>
      )}
    </aside>
  );
}

function LiveAgentDetails({
  agent,
  bucket,
}: {
  agent: Extract<InventoryAgent, { kind: "live" }>;
  bucket: StatusBucket;
}) {
  const successRate =
    agent.runs30d > 0 ? agent.succeeded30d / agent.runs30d : null;
  return (
    <div className="mt-5">
      {agent.description && (
        <p className="text-foreground-weak line-clamp-5 text-sm leading-6">
          {agent.description}
        </p>
      )}

      {agent.pendingPromotion && (
        <Link
          href={agent.pendingPromotion.href}
          className="border-[var(--color-sentiment-caution)] bg-[var(--color-sentiment-caution-subtle)] mt-4 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm"
        >
          <span>
            <span className="text-foreground block font-medium">Draft needs promotion</span>
            <span className="text-foreground-weak text-xs">
              +{agent.pendingPromotion.addedLines} −{agent.pendingPromotion.removedLines}
            </span>
          </span>
          <span aria-hidden>→</span>
        </Link>
      )}

      <DetailSection title="Operational signals">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
          <Metric label="Status"><StatusCell bucket={bucket} /></Metric>
          <Metric label="Runs 30d">{agent.runs30d.toLocaleString("en-US")}</Metric>
          <Metric label="Success">
            {successRate === null ? "—" : <SuccessCell rate={successRate} failed={agent.failed30d} />}
          </Metric>
          <Metric label="Avg cost">
            {agent.avgCostUsd30d === null ? "—" : formatCurrency(agent.avgCostUsd30d)}
          </Metric>
        </div>
        <p className="text-foreground-muted mt-2 text-xs" suppressHydrationWarning>
          Last run: {agent.lastRun ? `${formatRelativeAgo(agent.lastRun.createdAtIso)} · ${agent.lastRun.status}` : "Never"}
        </p>
      </DetailSection>

      <DetailSection title="Configuration">
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="gray" size="small">{shortModel(agent.model)}</Badge>
          <Badge variant="gray" size="small">{agent.frameworkLabel}</Badge>
        </div>
      </DetailSection>

      <DetailSection title={`Connections · ${agent.mcps.length + agent.subMcps.length}`}>
        {[...agent.mcps, ...agent.subMcps].length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {[...agent.mcps, ...agent.subMcps].map((m) => (
              <span key={m.slug} className="border-border flex items-center gap-1.5 rounded-md border bg-surface px-2 py-1 text-xs">
                <McpLogo icon={m} />
                {m.label}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-foreground-muted text-sm">None declared</span>
        )}
      </DetailSection>

      <DetailSection title={`Labels · ${agent.labels.length}`}>
        {agent.labels.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {agent.labels.map((label) => (
              <Badge key={label} variant="gray" size="small">{label}</Badge>
            ))}
          </div>
        ) : (
          <span className="text-foreground-muted text-sm">No labels</span>
        )}
      </DetailSection>
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-border mt-5 border-t pt-4">
      <h3 className="text-foreground-weak mb-2 text-xs font-medium uppercase tracking-wide">{title}</h3>
      {children}
    </section>
  );
}

function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-border min-w-0 rounded-md border bg-surface p-2">
      <span className="text-foreground-muted block text-xs uppercase tracking-wide">{label}</span>
      <span className="text-foreground mt-1 block truncate font-mono text-sm">{children}</span>
    </div>
  );
}

function StatusPill({ bucket }: { bucket: StatusBucket }) {
  const meta = STATUS_META[bucket];
  return (
    <span className="border-border text-foreground-weak inline-flex w-fit items-center gap-1.5 rounded border bg-surface px-1.5 py-0.5 text-xs">
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dotClass}`} aria-hidden />
      {meta.label}
    </span>
  );
}

function FacetPills({
  counts,
  active,
  onChange,
}: {
  counts: Record<StatusBucket | "all", number>;
  active: StatusBucket | null;
  onChange: (b: StatusBucket | null) => void;
}) {
  const pills: Array<{ key: StatusBucket | "all"; label: string }> = [
    { key: "all", label: "All" },
    { key: "active", label: "Active" },
    { key: "idle", label: "Idle" },
    { key: "error", label: "Error" },
    { key: "pending", label: "Pending" },
    { key: "invalid", label: "Invalid" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {pills.map(({ key, label }) => {
        const count = counts[key];
        if (key !== "all" && count === 0) return null;
        const isActive =
          (key === "all" && active === null) || key === active;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key === "all" ? null : (key as StatusBucket))}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm transition-colors ${
              isActive
                ? "border-foreground bg-surface-raised text-foreground"
                : "border-border bg-surface text-foreground-weak hover:text-foreground"
            }`}
          >
            {label}
            <span
              className={`rounded-full px-1.5 py-0.5 text-sm font-medium ${
                isActive
                  ? "bg-surface text-foreground-weak"
                  : "bg-surface-secondary text-foreground-muted"
              }`}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function McpLogo({ icon, dimmed = false }: { icon: McpIcon; dimmed?: boolean }) {
  const [failed, setFailed] = useState(false);
  const title = dimmed ? `${icon.label} (sub-agent)` : icon.label;
  return (
    <span
      title={title}
      className={`inline-flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden${
        dimmed ? " opacity-60" : ""
      }`}
    >
      {failed ? (
        <IconApiConnection size={12} className="text-foreground-muted" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={mcpLogoUrl(icon.slug)}
          alt=""
          aria-hidden
          className="h-4 w-4 object-contain"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

function SuccessCell({ rate, failed }: { rate: number; failed: number }) {
  const pct = Math.round(rate * 100);
  const tone =
    failed === 0
      ? "text-foreground"
      : rate >= 0.95
        ? "text-foreground"
        : rate >= 0.8
          ? "text-foreground-weak"
          : "text-sentiment-negative";
  return <span className={`font-mono text-sm ${tone}`}>{pct}%</span>;
}

function StatusCell({ bucket }: { bucket: StatusBucket }) {
  const meta = STATUS_META[bucket];
  return (
    <span className="text-foreground-weak inline-flex items-center gap-1.5 text-sm">
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dotClass}`}
        aria-hidden
      />
      {meta.label}
    </span>
  );
}

function PendingLinks({
  agent,
}: {
  agent: Extract<InventoryAgent, { kind: "pending-create" }>;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {agent.prUrl && agent.prNumber !== null ? (
        <a
          href={agent.prUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-foreground hover:underline"
        >
          PR #{agent.prNumber} ↗
        </a>
      ) : null}
      {agent.temboTaskHtmlUrl ? (
        <a
          href={agent.temboTaskHtmlUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-foreground-weak hover:text-foreground hover:underline"
        >
          Tembo session ↗
        </a>
      ) : null}
    </span>
  );
}

// Inline two-step confirm: "Dismiss" → "Dismiss? Yes / No". Marks the
// pending create closed so it drops off the inventory. The GitHub PR (if
// Per-agent star toggle (personal visibility). Optimistic: flips immediately,
// reverts if the action fails. stopPropagation so it doesn't trigger the row's
// click-to-navigate.
function StarButton({
  workspaceSlug,
  agentName,
  starred,
}: {
  workspaceSlug: string;
  agentName: string;
  starred: boolean;
}) {
  const [on, setOn] = useState(starred);
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      aria-label={on ? "Unstar agent" : "Star agent"}
      title={on ? "Unstar (remove from your list)" : "Star (add to your list)"}
      disabled={pending}
      onClick={(e) => {
        e.stopPropagation();
        const next = !on;
        setOn(next);
        startTransition(async () => {
          const r = await toggleAgentStarAction({
            workspaceSlug,
            agentName,
            starred: next,
          });
          if (!r.ok) setOn(!next);
        });
      }}
      className={
        on
          ? "text-foreground-title"
          : "text-foreground-muted hover:text-foreground"
      }
    >
      <IconStar size={16} />
    </button>
  );
}

// any) is left alone — the links above still reach it.
function DismissPendingButton({
  workspaceSlug,
  improvementId,
  agentName,
}: {
  workspaceSlug: string;
  improvementId: string;
  agentName: string;
}) {
  const [state, action, pending] = useActionState(dismissPendingCreateAction, {
    error: undefined,
  });
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="text-foreground-weak hover:text-sentiment-negative"
        title={`Dismiss the pending "${agentName}" create`}
      >
        Dismiss
      </button>
    );
  }

  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="workspace" value={workspaceSlug} />
      <input type="hidden" name="improvementId" value={improvementId} />
      <span
        className={
          state.error ? "text-sentiment-negative" : "text-foreground-weak"
        }
      >
        {state.error ?? "Dismiss?"}
      </span>
      <button
        type="submit"
        disabled={pending}
        className="text-sentiment-negative hover:underline disabled:opacity-60"
      >
        {pending ? "…" : "Yes"}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="text-foreground-weak hover:text-foreground"
      >
        No
      </button>
    </form>
  );
}

const STATUS_META: Record<
  StatusBucket,
  { label: string; dotClass: string; order: number }
> = {
  error: {
    label: "Error",
    dotClass: "bg-[var(--color-sentiment-negative)]",
    order: 0,
  },
  invalid: {
    label: "Invalid",
    dotClass: "bg-[var(--color-sentiment-negative)]",
    order: 1,
  },
  pending: {
    label: "Pending",
    dotClass: "bg-[var(--color-blue-500)]",
    order: 2,
  },
  active: {
    label: "Active",
    dotClass: "bg-[var(--color-sentiment-positive)]",
    order: 3,
  },
  idle: {
    label: "Idle",
    dotClass: "bg-[var(--color-foreground-muted)]",
    order: 4,
  },
};

function statusBucket(a: InventoryAgent): StatusBucket {
  if (a.kind === "invalid") return "invalid";
  if (a.kind === "pending-create") return "pending";
  if (a.lastRun?.status === "failed") return "error";
  if (a.runs30d === 0) return "idle";
  return "active";
}

function rowKey(a: InventoryAgent): string {
  if (a.kind === "pending-create") return `pending:${a.key}`;
  return a.path;
}

function compareRows(
  a: InventoryAgent,
  b: InventoryAgent,
  bucketA: StatusBucket,
  bucketB: StatusBucket,
  key: SortKey,
  dir: SortDir,
): number {
  const sign = dir === "asc" ? 1 : -1;
  switch (key) {
    case "status": {
      const d = STATUS_META[bucketA].order - STATUS_META[bucketB].order;
      if (d !== 0) return d * sign;
      return compareNames(a, b);
    }
    case "name":
      return compareNames(a, b) * sign;
    case "runs": {
      const ra = rowRuns(a);
      const rb = rowRuns(b);
      if (ra !== rb) return (ra - rb) * sign;
      return compareNames(a, b);
    }
    case "cost": {
      const ra = rowAvgCost(a);
      const rb = rowAvgCost(b);
      // Nulls last so agents with no costed runs don't crowd the top.
      if (ra === null && rb === null) return compareNames(a, b);
      if (ra === null) return 1;
      if (rb === null) return -1;
      if (ra !== rb) return (ra - rb) * sign;
      return compareNames(a, b);
    }
    case "success": {
      const ra = rowSuccessRate(a);
      const rb = rowSuccessRate(b);
      // Nulls last so "no data" doesn't crowd the top.
      if (ra === null && rb === null) return compareNames(a, b);
      if (ra === null) return 1;
      if (rb === null) return -1;
      if (ra !== rb) return (ra - rb) * sign;
      return compareNames(a, b);
    }
    case "last-run": {
      const ta = rowLastRunMs(a);
      const tb = rowLastRunMs(b);
      if (ta === null && tb === null) return compareNames(a, b);
      if (ta === null) return 1;
      if (tb === null) return -1;
      if (ta !== tb) return (ta - tb) * sign;
      return compareNames(a, b);
    }
  }
}

function rowRuns(a: InventoryAgent): number {
  if (a.kind === "live") return a.runs30d;
  return -1; // pending + invalid sink to the bottom on numeric sorts
}

function rowSuccessRate(a: InventoryAgent): number | null {
  if (a.kind !== "live" || a.runs30d === 0) return null;
  return a.succeeded30d / a.runs30d;
}
function rowAvgCost(a: InventoryAgent): number | null {
  return a.kind === "live" ? a.avgCostUsd30d : null;
}

function rowLastRunMs(a: InventoryAgent): number | null {
  if (a.kind === "live" && a.lastRun) {
    return new Date(a.lastRun.createdAtIso).getTime();
  }
  if (a.kind === "pending-create") {
    return new Date(a.createdAtIso).getTime();
  }
  return null;
}

// Trim the noisy provider/family prefix off the model id for the table:
// "anthropic:claude-sonnet-5" → "sonnet-5", "openai:gpt-4o-mini" → "gpt-4o-mini".
function shortModel(model: string | null): string {
  if (!model) return "—";
  return model.replace(/^anthropic:claude-/, "").replace(/^openai:/, "");
}

function compareNames(a: InventoryAgent, b: InventoryAgent): number {
  const an = a.kind === "invalid" ? a.filename : a.name;
  const bn = b.kind === "invalid" ? b.filename : b.name;
  return an.localeCompare(bn);
}

function formatRelativeAgo(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = Math.max(0, now - then);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}
