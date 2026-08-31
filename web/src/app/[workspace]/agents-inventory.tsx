"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useMemo, useState, useTransition } from "react";

import { IconApiConnection, IconPlusLarge, IconStar } from "central-icons";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { mcpLogoUrl } from "@/lib/mcp-logo";
import { formatCurrency } from "@/lib/pricing";
import { cn } from "@/lib/utils";

import { toggleAgentStarAction } from "./agent-stars-actions";
import { inventoryAgentSearchText } from "./agent-inventory-name-cell";
import { dismissPendingCreateAction } from "./inventory-actions";

export type McpIcon = {
  slug: string;
  label: string;
};

export type InventoryAgent =
  | {
      kind: "live";
      path: string;
      filename: string;
      name: string;
      displayName: string;
      description: string | null;
      detailHref: string;
      frameworkLabel: string;
      labels: string[];
      mcps: McpIcon[];
      subMcps: McpIcon[];
      model: string | null;
      runs30d: number;
      succeeded30d: number;
      failed30d: number;
      avgCostUsd30d: number | null;
      lastRun:
        | {
            status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
            createdAtIso: string;
          }
        | null;
      isStarred: boolean;
      isMine: boolean;
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
type EnrichedRow = { agent: InventoryAgent; bucket: StatusBucket };
type SortKey = "last-run" | "name" | "status" | "runs" | "cost" | "success";

const SORT_OPTIONS = [
  { value: "last-run", label: "Sort: Recently run" },
  { value: "name", label: "Sort: Name A–Z" },
  { value: "status", label: "Sort: Status" },
  { value: "runs", label: "Sort: Most T30 runs" },
  { value: "cost", label: "Sort: Highest avg cost" },
  { value: "success", label: "Sort: Lowest success" },
];

type Props = {
  agents: InventoryAgent[];
  newAgentHref: string;
  canCreate: boolean;
  workspaceSlug: string;
  canEdit: boolean;
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
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [promotionOnly, setPromotionOnly] = useState(initialPromotionOnly);
  const [sortKey, setSortKey] = useState<SortKey>("last-run");
  const [view, setView] = useState<"mine" | "all">(
    !initialPromotionOnly &&
      agents.some((agent) =>
        agent.kind === "live" ? agent.isMine || agent.isStarred : false,
      )
      ? "mine"
      : "all",
  );

  const enriched = useMemo(
    () => agents.map((agent) => ({ agent, bucket: statusBucket(agent) })),
    [agents],
  );

  const counts = useMemo(() => {
    const result: Record<StatusBucket | "all", number> = {
      all: enriched.length,
      active: 0,
      idle: 0,
      error: 0,
      pending: 0,
      invalid: 0,
    };
    for (const row of enriched) result[row.bucket]++;
    return result;
  }, [enriched]);

  const pendingPromotionCount = useMemo(
    () =>
      enriched.filter(
        ({ agent }) => agent.kind === "live" && agent.pendingPromotion !== null,
      ).length,
    [enriched],
  );

  const labelOptions = useMemo(() => {
    const values = new Set<string>();
    for (const { agent } of enriched) {
      if (agent.kind === "live") {
        for (const label of agent.labels) values.add(label);
      }
    }
    return [
      { value: "", label: "All labels" },
      ...[...values].sort().map((value) => ({ value, label: value })),
    ];
  }, [enriched]);

  const modelOptions = useMemo(() => {
    const values = new Set<string>();
    for (const { agent } of enriched) {
      if (agent.kind === "live" && agent.model) values.add(agent.model);
    }
    return [
      { value: "", label: "All models" },
      ...[...values]
        .sort()
        .map((value) => ({ value, label: shortModel(value) })),
    ];
  }, [enriched]);

  const mcpOptions = useMemo(() => {
    const values = new Map<string, string>();
    for (const { agent } of enriched) {
      if (agent.kind !== "live") continue;
      for (const mcp of [...agent.mcps, ...agent.subMcps]) {
        if (!values.has(mcp.slug)) values.set(mcp.slug, mcp.label);
      }
    }
    return [
      { value: "", label: "All MCPs" },
      ...[...values.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([value, label]) => ({ value, label })),
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
    if (promotionOnly) {
      rows = rows.filter(
        ({ agent }) => agent.kind === "live" && agent.pendingPromotion !== null,
      );
    }
    if (bucket !== null) rows = rows.filter((row) => row.bucket === bucket);
    if (labelFilter) {
      rows = rows.filter(
        ({ agent }) => agent.kind === "live" && agent.labels.includes(labelFilter),
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
          [...agent.mcps, ...agent.subMcps].some((mcp) => mcp.slug === mcpFilter),
      );
    }

    return [...rows].sort((a, b) => compareRows(a, b, sortKey));
  }, [
    enriched,
    query,
    view,
    promotionOnly,
    bucket,
    labelFilter,
    modelFilter,
    mcpFilter,
    sortKey,
  ]);

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
          placeholder="Search name, label, model, or connection…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="max-w-sm"
          aria-label="Search agents"
        />
        <div className="flex items-center gap-2">
          <Select
            value={sortKey}
            onValueChange={(value) => setSortKey(value as SortKey)}
            options={SORT_OPTIONS}
            ariaLabel="Sort agents"
            className="min-w-[180px]"
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
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="border-border inline-flex overflow-hidden rounded-full border text-sm">
          <button
            type="button"
            onClick={() => setView("mine")}
            className={cn(
              "px-3 py-1.5",
              view === "mine"
                ? "bg-interactive text-foreground-on-accent"
                : "text-foreground-weak hover:text-foreground",
            )}
          >
            Mine + Starred
          </button>
          <button
            type="button"
            onClick={() => setView("all")}
            className={cn(
              "px-3 py-1.5",
              view === "all"
                ? "bg-interactive text-foreground-on-accent"
                : "text-foreground-weak hover:text-foreground",
            )}
          >
            All
          </button>
        </div>

        <FacetPills counts={counts} active={bucket} onChange={setBucket} />

        {pendingPromotionCount > 0 && (
          <button
            type="button"
            aria-pressed={promotionOnly}
            onClick={() => {
              setPromotionOnly((active) => !active);
              if (!promotionOnly) setView("all");
            }}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm transition-colors",
              promotionOnly
                ? "border-foreground bg-interactive text-foreground-on-accent"
                : "border-border bg-surface text-foreground-weak hover:text-foreground",
            )}
          >
            Drafts
            <span className="rounded-full bg-surface-secondary px-1.5 py-0.5 text-sm text-foreground-weak">
              {pendingPromotionCount}
            </span>
          </button>
        )}

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

      {filtered.length > 0 ? (
        <div className="border-border overflow-hidden rounded-lg border bg-surface">
          {filtered.map((row) => (
            <InventoryRow
              key={rowKey(row.agent)}
              row={row}
              workspaceSlug={workspaceSlug}
              canEdit={canEdit}
            />
          ))}
        </div>
      ) : (
        emptyState
      )}
    </div>
  );
}
function InventoryRow({
  row,
  workspaceSlug,
  canEdit,
}: {
  row: EnrichedRow;
  workspaceSlug: string;
  canEdit: boolean;
}) {
  if (row.agent.kind === "live") {
    return (
      <LiveInventoryRow
        agent={row.agent}
        bucket={row.bucket}
        workspaceSlug={workspaceSlug}
      />
    );
  }
  if (row.agent.kind === "pending-create") {
    return (
      <PendingInventoryRow
        agent={row.agent}
        bucket={row.bucket}
        workspaceSlug={workspaceSlug}
        canEdit={canEdit}
      />
    );
  }
  return <InvalidInventoryRow agent={row.agent} bucket={row.bucket} />;
}

function LiveInventoryRow({
  agent,
  bucket,
  workspaceSlug,
}: {
  agent: Extract<InventoryAgent, { kind: "live" }>;
  bucket: StatusBucket;
  workspaceSlug: string;
}) {
  const router = useRouter();
  const connections = [...agent.mcps, ...agent.subMcps];
  const successLabel =
    agent.runs30d > 0
      ? `${Math.round((agent.succeeded30d / agent.runs30d) * 100)}%`
      : "—";

  return (
    <article
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a, button")) return;
        router.push(agent.detailHref);
      }}
      className="border-border-weak hover:bg-interactive-state-hover grid cursor-pointer grid-cols-[2rem_minmax(0,1fr)] gap-x-3 gap-y-2 border-b bg-surface-raised px-4 py-4 transition-colors last:border-b-0 lg:grid-cols-[2rem_minmax(0,1fr)_minmax(24rem,auto)] lg:grid-rows-2 lg:gap-x-5"
    >
      <div className="row-span-4 flex justify-center pt-0.5 lg:row-span-2">
        <StarButton
          workspaceSlug={workspaceSlug}
          agentName={agent.name}
          starred={agent.isStarred}
        />
      </div>

      <Link
        href={agent.detailHref}
        className="text-foreground-title col-start-2 w-fit min-w-0 truncate text-[15px] font-semibold hover:underline lg:row-start-1"
      >
        {agent.displayName}
      </Link>

      <AgentMetadata agent={agent} connections={connections} />

      <div className="text-foreground col-start-2 flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1 font-mono text-sm lg:col-start-3 lg:row-start-1 lg:justify-self-end">
        {agent.runs30d > 0 && (
          <>
            <span
              title="Average cost per run in the trailing 30 days"
              aria-label={`Average cost per run: ${agent.avgCostUsd30d === null ? "not available" : formatCurrency(agent.avgCostUsd30d)}`}
            >
              {agent.avgCostUsd30d === null
                ? "—"
                : formatCurrency(agent.avgCostUsd30d)}
            </span>
            <span
              title="Success rate in the trailing 30 days"
              aria-label={`Success rate: ${successLabel}`}
            >
              {successLabel}
            </span>
          </>
        )}
        <StatusDot bucket={bucket} />
        <span
          className="text-foreground-weak whitespace-nowrap"
          title={
            agent.lastRun
              ? new Date(agent.lastRun.createdAtIso).toLocaleString()
              : "This agent has not run yet"
          }
          suppressHydrationWarning
        >
          {agent.lastRun
            ? `Last run ${formatRelativeAgo(agent.lastRun.createdAtIso)}`
            : "No runs yet"}
        </span>
      </div>

      {agent.runs30d > 0 && (
        <span
          className="text-foreground-weak col-start-2 font-mono text-sm lg:col-start-3 lg:row-start-2 lg:justify-self-end"
          title="Runs in the trailing 30 days"
        >
          {agent.runs30d.toLocaleString("en-US")} T30{" "}
          {agent.runs30d === 1 ? "run" : "runs"}
        </span>
      )}
    </article>
  );
}

function AgentMetadata({
  agent,
  connections,
}: {
  agent: Extract<InventoryAgent, { kind: "live" }>;
  connections: McpIcon[];
}) {
  const visibleConnections = connections.slice(0, 5);
  const visibleLabels = agent.labels.slice(0, 5);
  return (
    <div className="col-start-2 flex min-w-0 flex-wrap items-center gap-1.5 lg:row-start-2">
      {visibleConnections.map((connection, index) => (
        <span
          key={`${connection.slug}:${index}`}
          title={
            index >= agent.mcps.length
              ? `${connection.label} (via sub-agent)`
              : connection.label
          }
          aria-label={connection.label}
          className="border-border inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border bg-surface"
        >
          <McpLogo icon={connection} dimmed={index >= agent.mcps.length} />
        </span>
      ))}
      {connections.length > visibleConnections.length && (
        <span
          className="bg-surface-secondary text-foreground-weak rounded px-1.5 py-0.5 text-xs"
          title={connections
            .slice(visibleConnections.length)
            .map((connection) => connection.label)
            .join(", ")}
        >
          +{connections.length - visibleConnections.length}
        </span>
      )}

      {visibleLabels.map((label) => (
        <span
          key={label}
          className="bg-surface-secondary text-foreground-weak max-w-32 truncate rounded px-2 py-0.5 text-xs"
        >
          {label}
        </span>
      ))}
      {agent.labels.length > visibleLabels.length && (
        <span
          className="bg-surface-secondary text-foreground-weak rounded px-1.5 py-0.5 text-xs"
          title={agent.labels.slice(visibleLabels.length).join(", ")}
        >
          +{agent.labels.length - visibleLabels.length}
        </span>
      )}

      <span
        className="rounded bg-gray-300 px-2 py-0.5 font-mono text-xs text-gray-800 dark:bg-gray-700 dark:text-gray-100"
        title={agent.model ?? "No model configured"}
      >
        {shortModel(agent.model)}
      </span>

      {agent.pendingPromotion && (
        <Link
          href={agent.pendingPromotion.href}
          className="bg-interactive text-foreground-on-accent rounded px-2 py-0.5 text-xs font-medium hover:underline"
          title={`Draft needs promotion · +${agent.pendingPromotion.addedLines} −${agent.pendingPromotion.removedLines}`}
        >
          Draft
        </Link>
      )}
    </div>
  );
}

function PendingInventoryRow({
  agent,
  bucket,
  workspaceSlug,
  canEdit,
}: {
  agent: Extract<InventoryAgent, { kind: "pending-create" }>;
  bucket: StatusBucket;
  workspaceSlug: string;
  canEdit: boolean;
}) {
  return (
    <article className="border-border-weak grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 gap-y-2 border-b bg-surface-secondary px-4 py-4 last:border-b-0 lg:grid-cols-[2rem_minmax(0,1fr)_minmax(24rem,auto)] lg:grid-rows-2 lg:gap-x-5">
      <div className="row-span-4 flex justify-center pt-2 lg:row-span-2">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-foreground-muted)]" />
      </div>
      <span className="text-foreground-title col-start-2 text-[15px] font-semibold lg:row-start-1">
        {agent.name}
      </span>
      <div className="col-start-2 flex flex-wrap items-center gap-1.5 lg:row-start-2">
        <span className="bg-[var(--color-border-strong)] text-foreground rounded px-2 py-0.5 text-xs">
          {agent.frameworkLabel}
        </span>
        <span className="bg-interactive text-foreground-on-accent rounded px-2 py-0.5 text-xs font-medium">
          Pending create
        </span>
      </div>
      <div className="text-foreground-weak col-start-2 flex items-center gap-3 font-mono text-sm lg:col-start-3 lg:row-start-1 lg:justify-self-end">
        <StatusDot bucket={bucket} />
        <span suppressHydrationWarning>
          Submitted {formatRelativeAgo(agent.createdAtIso)}
        </span>
      </div>
      <div className="text-foreground-weak col-start-2 flex flex-wrap items-center gap-3 text-sm lg:col-start-3 lg:row-start-2 lg:justify-self-end">
        <PendingLinks agent={agent} />
        {canEdit && (
          <DismissPendingButton
            workspaceSlug={workspaceSlug}
            improvementId={agent.key}
            agentName={agent.name}
          />
        )}
      </div>
    </article>
  );
}

function InvalidInventoryRow({
  agent,
  bucket,
}: {
  agent: Extract<InventoryAgent, { kind: "invalid" }>;
  bucket: StatusBucket;
}) {
  return (
    <article className="border-border-weak grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 gap-y-2 border-b bg-[var(--color-input-error)]/30 px-4 py-4 last:border-b-0 lg:grid-cols-[2rem_minmax(0,1fr)_minmax(24rem,auto)] lg:grid-rows-2 lg:gap-x-5">
      <div className="row-span-3 flex justify-center pt-2 lg:row-span-2">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-foreground-muted)]" />
      </div>
      <span className="text-foreground-title col-start-2 text-[15px] font-semibold lg:row-start-1">
        {agent.filename}
      </span>
      <div className="col-start-2 flex flex-wrap items-center gap-1.5 lg:row-start-2">
        <span className="bg-interactive text-foreground-on-accent rounded px-2 py-0.5 text-xs font-medium">
          Invalid
        </span>
        <span className="text-sentiment-negative text-xs">{agent.error}</span>
      </div>
      <div className="text-foreground-weak col-start-2 flex items-center gap-3 font-mono text-sm lg:col-start-3 lg:row-start-1 lg:justify-self-end">
        <StatusDot bucket={bucket} />
        <span>Cannot load agent</span>
      </div>
    </article>
  );
}

function StatusDot({ bucket }: { bucket: StatusBucket }) {
  const status = STATUS_META[bucket];
  return (
    <span
      role="img"
      aria-label={status.label}
      title={status.label}
      className={cn("h-2 w-2 shrink-0 rounded-full", status.dotClass)}
    />
  );
}

function FacetPills({
  counts,
  active,
  onChange,
}: {
  counts: Record<StatusBucket | "all", number>;
  active: StatusBucket | null;
  onChange: (bucket: StatusBucket | null) => void;
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
            onClick={() =>
              onChange(key === "all" ? null : (key as StatusBucket))
            }
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm transition-colors",
              isActive
                ? "border-foreground bg-surface-raised text-foreground"
                : "border-border bg-surface text-foreground-weak hover:text-foreground",
            )}
          >
            {label}
            <span
              className={cn(
                "rounded-full px-1.5 py-0.5 text-sm font-medium",
                isActive
                  ? "bg-surface text-foreground-weak"
                  : "bg-surface-secondary text-foreground-muted",
              )}
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
  return (
    <span
      className={cn(
        "inline-flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden",
        dimmed && "opacity-60",
      )}
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

function PendingLinks({
  agent,
}: {
  agent: Extract<InventoryAgent, { kind: "pending-create" }>;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {agent.prUrl && agent.prNumber !== null && (
        <a
          href={agent.prUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-foreground hover:underline"
        >
          PR #{agent.prNumber} ↗
        </a>
      )}
      {agent.temboTaskHtmlUrl && (
        <a
          href={agent.temboTaskHtmlUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-foreground-weak hover:text-foreground hover:underline"
        >
          Tembo session ↗
        </a>
      )}
    </span>
  );
}

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
      onClick={() => {
        const next = !on;
        setOn(next);
        startTransition(async () => {
          const result = await toggleAgentStarAction({
            workspaceSlug,
            agentName,
            starred: next,
          });
          if (!result.ok) setOn(!next);
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

function statusBucket(agent: InventoryAgent): StatusBucket {
  if (agent.kind === "invalid") return "invalid";
  if (agent.kind === "pending-create") return "pending";
  if (agent.lastRun?.status === "failed") return "error";
  if (agent.runs30d === 0) return "idle";
  return "active";
}

function rowKey(agent: InventoryAgent): string {
  if (agent.kind === "pending-create") return `pending:${agent.key}`;
  return agent.path;
}

function compareNames(a: InventoryAgent, b: InventoryAgent): number {
  const nameA = a.kind === "invalid" ? a.filename : a.name;
  const nameB = b.kind === "invalid" ? b.filename : b.name;
  return nameA.localeCompare(nameB);
}

function compareRows(a: EnrichedRow, b: EnrichedRow, key: SortKey): number {
  let result = 0;
  switch (key) {
    case "name":
      return compareNames(a.agent, b.agent);
    case "status":
      result = STATUS_META[a.bucket].order - STATUS_META[b.bucket].order;
      break;
    case "last-run":
      result = compareNumbersDesc(lastRunTime(a.agent), lastRunTime(b.agent));
      break;
    case "runs":
      result = compareNumbersDesc(runCount(a.agent), runCount(b.agent));
      break;
    case "cost":
      result = compareNumbersDesc(averageCost(a.agent), averageCost(b.agent));
      break;
    case "success":
      result = compareNumbersAsc(successRate(a.agent), successRate(b.agent));
      break;
  }
  return result || compareNames(a.agent, b.agent);
}

function compareNumbersDesc(a: number | null, b: number | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return b - a;
}

function compareNumbersAsc(a: number | null, b: number | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return a - b;
}

function lastRunTime(agent: InventoryAgent): number | null {
  return agent.kind === "live" && agent.lastRun
    ? new Date(agent.lastRun.createdAtIso).getTime()
    : null;
}

function runCount(agent: InventoryAgent): number | null {
  return agent.kind === "live" ? agent.runs30d : null;
}

function averageCost(agent: InventoryAgent): number | null {
  return agent.kind === "live" ? agent.avgCostUsd30d : null;
}

function successRate(agent: InventoryAgent): number | null {
  return agent.kind === "live" && agent.runs30d > 0
    ? agent.succeeded30d / agent.runs30d
    : null;
}

function shortModel(model: string | null): string {
  if (!model) return "—";
  return model.replace(/^anthropic:claude-/, "").replace(/^openai:/, "");
}

function formatRelativeAgo(iso: string): string {
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
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
  return `${Math.floor(days / 365)}y ago`;
}
