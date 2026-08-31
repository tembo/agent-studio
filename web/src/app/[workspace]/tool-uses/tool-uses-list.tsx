"use client";

// Client-side filter + paginate surface for /<workspace>/tool-uses.
// Mirrors runs-list.tsx: filters live in component state, the server page
// renders the first page, this takes over on filter changes / "Load more".

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";

import { LocalTime } from "@/components/local-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { ToolCallOutcome } from "@/lib/runs-db";

import { loadToolUsesAction } from "./actions";
import type { LoadedToolCall } from "./shape";

const ALL_OUTCOMES: ToolCallOutcome[] = ["ok", "failed", "no-result"];
const OUTCOME_LABELS: Record<ToolCallOutcome, string> = {
  ok: "OK",
  failed: "Failed",
  "no-result": "No result",
};
const PAGE_SIZE = 50;
const RELATIVE_MS = 24 * 60 * 60 * 1000;

type Props = {
  workspaceSlug: string;
  agentNames: string[];
  toolNames: string[];
  initial: LoadedToolCall[];
  initialFilters?: {
    agentName?: string;
    toolName?: string;
    outcomes?: ToolCallOutcome[];
    search?: string;
  };
};

export function ToolUsesList({
  workspaceSlug,
  agentNames,
  toolNames,
  initial,
  initialFilters,
}: Props) {
  const [agentName, setAgentName] = useState(initialFilters?.agentName ?? "");
  const [toolName, setToolName] = useState(initialFilters?.toolName ?? "");
  const [outcomes, setOutcomes] = useState<ToolCallOutcome[]>(
    initialFilters?.outcomes ?? [],
  );
  const [search, setSearch] = useState(initialFilters?.search ?? "");

  const [rows, setRows] = useState<LoadedToolCall[]>(initial);
  const [more, setMore] = useState(initial.length >= PAGE_SIZE);
  const [pending, startTransition] = useTransition();

  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const filterEpoch = useRef(0);
  const filtersKey = JSON.stringify({
    agentName,
    toolName,
    outcomes,
    search: debouncedSearch,
  });
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    filterEpoch.current += 1;
    const epoch = filterEpoch.current;
    startTransition(async () => {
      const next = await loadToolUsesAction({
        workspaceSlug,
        filters: {
          agentName: agentName || undefined,
          toolName: toolName || undefined,
          outcomes: outcomes.length ? outcomes : undefined,
          search: debouncedSearch || undefined,
        },
      });
      if (epoch !== filterEpoch.current) return;
      setRows(next);
      setMore(next.length >= PAGE_SIZE);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey, workspaceSlug]);

  const onLoadMore = useCallback(() => {
    if (rows.length === 0) return;
    const last = rows[rows.length - 1];
    startTransition(async () => {
      const next = await loadToolUsesAction({
        workspaceSlug,
        filters: {
          agentName: agentName || undefined,
          toolName: toolName || undefined,
          outcomes: outcomes.length ? outcomes : undefined,
          search: debouncedSearch || undefined,
        },
        before: { createdAtIso: last.createdAt, id: last.id },
      });
      setRows((prev) => [...prev, ...next]);
      setMore(next.length >= PAGE_SIZE);
    });
  }, [rows, workspaceSlug, agentName, toolName, outcomes, debouncedSearch]);

  const agentOptions = [
    { value: "", label: "All agents" },
    ...agentNames.map((n) => ({ value: n, label: n })),
  ];
  const toolOptions = [
    { value: "", label: "All tools" },
    ...toolNames.map((n) => ({ value: n, label: n })),
  ];

  const columns: Column<LoadedToolCall>[] = [
    {
      key: "outcome",
      header: "Outcome",
      cell: (t) => <OutcomeBadge ok={t.ok} />,
    },
    {
      key: "tool",
      header: "Tool",
      cell: (t) => (
        <>
          <code className="text-foreground text-sm">{t.toolName}</code>
          {t.ok === false && t.errorMessage && (
            <div className="text-foreground-sentiment-negative mt-0.5 line-clamp-2 font-mono text-xs leading-4">
              {t.errorMessage}
            </div>
          )}
        </>
      ),
    },
    {
      key: "agent",
      header: "Agent",
      tdClassName: "whitespace-nowrap",
      cell: (t) => (
        <Link
          href={`/${workspaceSlug}/agents/${encodeURIComponent(t.agentName)}`}
          className="text-foreground hover:underline"
        >
          {t.agentName}
        </Link>
      ),
    },
    {
      key: "when",
      header: "When",
      tdClassName: "text-foreground-weak whitespace-nowrap text-sm",
      cell: (t) => <When iso={t.createdAt} />,
    },
    {
      key: "run",
      header: "Run",
      tdClassName: "whitespace-nowrap",
      cell: (t) => (
        <Link
          href={`/${workspaceSlug}/agents/${encodeURIComponent(t.agentName)}/runs/${t.runId}`}
          className="text-foreground-weak hover:text-foreground text-sm"
        >
          Open →
        </Link>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-foreground-weak w-20 shrink-0 text-sm uppercase tracking-wide">
            Outcome
          </span>
          {ALL_OUTCOMES.map((o) => (
            <FilterChip
              key={o}
              active={outcomes.includes(o)}
              onClick={() => toggle(o, outcomes, setOutcomes)}
              label={OUTCOME_LABELS[o]}
            />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-foreground-weak w-20 shrink-0 text-sm uppercase tracking-wide">
            Agent
          </span>
          <Select
            value={agentName}
            onValueChange={setAgentName}
            options={agentOptions}
            ariaLabel="Filter by agent"
            className="min-w-[200px]"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-foreground-weak w-20 shrink-0 text-sm uppercase tracking-wide">
            Tool
          </span>
          <Select
            value={toolName}
            onValueChange={setToolName}
            options={toolOptions}
            ariaLabel="Filter by tool"
            className="min-w-[200px]"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label
            htmlFor="tool-search"
            className="text-foreground-weak w-20 shrink-0 text-sm uppercase tracking-wide"
          >
            Search
          </label>
          <Input
            id="tool-search"
            type="search"
            placeholder="Search tool name or error…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-sm"
            maxLength={200}
          />
        </div>
      </div>

      <hr className="border-[var(--color-border-weak)]" />

      <div className="text-foreground-weak text-sm">
        {pending
          ? "Loading…"
          : rows.length === 0
            ? "No tool calls match these filters."
            : `${rows.length} tool call${rows.length === 1 ? "" : "s"}${more ? "+" : ""}`}
      </div>

      {rows.length > 0 && (
        <DataTable
          columns={columns}
          rows={rows}
          getRowKey={(t) => t.id}
          renderExpanded={(t) => (
            <ExpandedDetail
              workspaceSlug={workspaceSlug}
              toolCall={t}
            />
          )}
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

function ExpandedDetail({
  workspaceSlug,
  toolCall,
}: {
  workspaceSlug: string;
  toolCall: LoadedToolCall;
}) {
  const runHref = `/${workspaceSlug}/agents/${encodeURIComponent(toolCall.agentName)}/runs/${toolCall.runId}`;
  return (
    <div className="flex flex-col gap-2 pt-1">
      {toolCall.ok === false && toolCall.errorMessage && (
        <div>
          <span className="text-foreground-weak text-xs font-medium uppercase tracking-wide">
            Error
          </span>
          <pre className="text-foreground-sentiment-negative mt-1 whitespace-pre-wrap font-mono text-xs leading-5">
            {toolCall.errorMessage}
          </pre>
        </div>
      )}
      <div>
        <Link
          href={runHref}
          className="text-foreground-weak hover:text-foreground text-sm underline"
        >
          View run →
        </Link>
      </div>
    </div>
  );
}

function OutcomeBadge({ ok }: { ok: boolean | null }) {
  if (ok === true) {
    return (
      <Badge variant="green" size="small">
        OK
      </Badge>
    );
  }
  if (ok === false) {
    return (
      <Badge variant="red" size="small">
        Failed
      </Badge>
    );
  }
  return (
    <Badge variant="gray" size="small">
      No result
    </Badge>
  );
}

function When({ iso }: { iso: string }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  // eslint-disable-next-line react-hooks/purity
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < RELATIVE_MS) return <span>{formatRelativeAgo(ms)}</span>;
  return <LocalTime iso={iso} style="relative" />;
}

function formatRelativeAgo(diffMs: number): string {
  if (diffMs < 0) return "just now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
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

function toggle<T>(value: T, list: T[], set: (next: T[]) => void) {
  set(list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);
}
