"use client";

import Link from "next/link";
import { useActionState, useMemo, useState, useTransition } from "react";

import { IconApiConnection, IconPlusLarge, IconStar } from "central-icons";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type Column, type SortDir } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { mcpLogoUrl } from "@/lib/mcp-logo";
import { formatCurrency } from "@/lib/pricing";

import { toggleAgentStarAction } from "./agent-stars-actions";
import {
  AgentInventoryNameCell,
  inventoryAgentSearchText,
} from "./agent-inventory-name-cell";
import { dismissPendingCreateAction } from "./inventory-actions";

// Workspace agent inventory. Replaces the card grid (better for ~10
// agents, falls apart past that) with a sortable / filterable table.
// Status facet pills + free-text search live above; the table itself
// renders every agent — live, pending-create, and invalid — as a
// single row so the user sees the whole picture in one place.

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

type Props = {
  agents: InventoryAgent[];
  newAgentHref: string;
  /** Show the "New agent" button. Requires operator+ AND a Tembo API
   *  key (chat-to-create runs through Tembo CAP). */
  canCreate: boolean;
  workspaceSlug: string;
  /** Operator+; gates the "Dismiss" action on pending-create rows. */
  canEdit: boolean;
};

export function AgentsInventory({
  agents,
  newAgentHref,
  canCreate,
  workspaceSlug,
  canEdit,
}: Props) {
  const [query, setQuery] = useState("");
  // null = "all" (no facet selected). Selecting a pill switches the
  // visible rows to that bucket only.
  const [bucket, setBucket] = useState<StatusBucket | null>(null);
  const [labelFilter, setLabelFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [mcpFilter, setMcpFilter] = useState("");
  // Default sort: alphabetical by name. The user can re-sort by clicking
  // column headers.
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  // Default to MY agents (owned or starred) for a tidy day-to-day list; "all"
  // shows everyone's. Falls back to "all" when I own/star nothing yet, so the
  // list is never empty.
  const [view, setView] = useState<"mine" | "all">(
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

  // Distinct labels + models across live agents, for the filter dropdowns.
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
  // Distinct MCPs (top-level + sub-agent) across live agents, slug→label.
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
    const q = query.trim().toLowerCase();
    let rows = q
      ? enriched.filter(({ agent }) =>
          inventoryAgentSearchText(agent).toLowerCase().includes(q),
        )
      : enriched;
    if (view === "mine") {
      rows = rows.filter(
        ({ agent }) => agent.kind !== "live" || agent.isMine || agent.isStarred,
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

  const columns: Column<EnrichedRow>[] = [
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
      key: "labels",
      header: "Labels",
      cell: ({ agent }) => {
        if (agent.kind === "invalid") {
          return (
            <span className="text-sentiment-negative text-sm">
              {agent.error}
              {agent.detail ? ` — ${agent.detail}` : ""}
            </span>
          );
        }
        if (agent.kind === "pending-create") {
          return <span className="text-foreground-muted">—</span>;
        }
        return agent.labels.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {agent.labels.map((l) => (
              <Badge key={l} variant="gray" size="small">
                {l}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-foreground-muted">—</span>
        );
      },
    },
    {
      key: "model",
      header: "Model",
      cell: ({ agent }) => {
        if (agent.kind !== "live") {
          return <span className="text-foreground-muted">—</span>;
        }
        return (
          <span className="text-foreground-weak font-mono text-sm">
            {shortModel(agent.model)}
          </span>
        );
      },
    },
    {
      key: "mcps",
      header: "MCPs",
      cell: ({ agent }) => {
        if (agent.kind !== "live") {
          return <span className="text-foreground-muted">—</span>;
        }
        return <McpCell mcps={agent.mcps} subMcps={agent.subMcps} />;
      },
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
          placeholder="Search agents…"
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

      <div className="flex flex-wrap items-center gap-2">
        <div className="border-border inline-flex overflow-hidden rounded-md border text-sm">
          <button
            type="button"
            onClick={() => setView("mine")}
            className={`px-2.5 py-1 ${
              view === "mine"
                ? "bg-surface-raised text-foreground"
                : "text-foreground-weak hover:text-foreground"
            }`}
          >
            Mine + Starred
          </button>
          <button
            type="button"
            onClick={() => setView("all")}
            className={`px-2.5 py-1 ${
              view === "all"
                ? "bg-surface-raised text-foreground"
                : "text-foreground-weak hover:text-foreground"
            }`}
          >
            All
          </button>
        </div>
        <FacetPills counts={counts} active={bucket} onChange={setBucket} />
        {labelOptions.length > 1 && (
          <Select
            value={labelFilter}
            onValueChange={setLabelFilter}
            options={labelOptions}
            ariaLabel="Filter by label"
            className="min-w-[130px]"
          />
        )}
        {modelOptions.length > 1 && (
          <Select
            value={modelFilter}
            onValueChange={setModelFilter}
            options={modelOptions}
            ariaLabel="Filter by model"
            className="min-w-[130px]"
          />
        )}
        {mcpOptions.length > 1 && (
          <Select
            value={mcpFilter}
            onValueChange={setMcpFilter}
            options={mcpOptions}
            ariaLabel="Filter by MCP"
            className="min-w-[130px]"
          />
        )}
      </div>

      <DataTable
        columns={columns}
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

// MCPs column for a live agent: the agent's own connection logos, then —
// for an orchestrator — a "+" and the (dimmed) logos its sub-agents bring in.
function McpCell({ mcps, subMcps }: { mcps: McpIcon[]; subMcps: McpIcon[] }) {
  if (mcps.length === 0 && subMcps.length === 0) {
    return <span className="text-foreground-muted">—</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {mcps.map((m) => (
        <McpLogo key={`top:${m.slug}`} icon={m} />
      ))}
      {subMcps.length > 0 && (
        <>
          <span
            className="text-foreground-muted px-0.5 text-xs"
            title="Used by this agent's sub-agents"
          >
            +
          </span>
          {subMcps.map((m) => (
            <McpLogo key={`sub:${m.slug}`} icon={m} dimmed />
          ))}
        </>
      )}
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
