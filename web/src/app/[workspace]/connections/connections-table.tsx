"use client";

import { useMemo, useState } from "react";

import { McpProviderLogo } from "@/components/mcp-provider-logo";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column, type SortDir } from "@/components/ui/data-table";

import type { ConnectionRow } from "./connection-ref";

// Client-side searchable/filterable/sortable table for the Connections index,
// modeled on the Tools tab. Row counts are small (a member's connections +
// workspace secrets), so all of it happens in JS. Default sort is Name ascending
// (alphabetical).

type SortKey = "title" | "typeLabel" | "statusLabel";

export function ConnectionsTable({
  workspaceSlug,
  rows,
  viewUserId,
}: {
  workspaceSlug: string;
  rows: ConnectionRow[];
  viewUserId?: string;
}) {
  const [search, setSearch] = useState("");
  const [type, setType] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("title");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const typeOptions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.typeLabel))).sort(),
    [rows],
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const out = rows.filter((r) => {
      if (type !== "all" && r.typeLabel !== type) return false;
      if (!needle) return true;
      return (
        r.title.toLowerCase().includes(needle) ||
        (r.slot?.toLowerCase().includes(needle) ?? false) ||
        r.typeLabel.toLowerCase().includes(needle)
      );
    });
    const dir = sortDir === "asc" ? 1 : -1;
    return out.sort((a, b) => {
      const primary = a[sortKey].localeCompare(b[sortKey]) * dir;
      // Stable secondary sort by title so equal keys keep a predictable order.
      return primary !== 0 ? primary : a.title.localeCompare(b.title);
    });
  }, [rows, search, type, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function hrefFor(r: ConnectionRow): string {
    return `/${workspaceSlug}/connections/${r.ref}${
      viewUserId ? `?user=${encodeURIComponent(viewUserId)}` : ""
    }`;
  }

  const columns: Column<ConnectionRow>[] = [
    {
      key: "title",
      header: "Name",
      sortable: true,
      cell: (r) => (
        <div className="flex min-w-0 items-center gap-2.5">
          {r.logoSlug ? (
            <McpProviderLogo slug={r.logoSlug} label={r.title} size={20} />
          ) : (
            <span
              className="bg-surface-secondary text-foreground-muted inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-xs"
              aria-hidden
            >
              ⚿
            </span>
          )}
          <span className="text-foreground font-medium">{r.title}</span>
          {r.slot && (
            <span className="text-foreground-muted truncate text-sm">
              · {r.slot}
            </span>
          )}
        </div>
      ),
    },
    {
      key: "typeLabel",
      header: "Type",
      sortable: true,
      thClassName: "w-[160px]",
      cell: (r) => (
        <span className="text-foreground-muted text-sm">{r.typeLabel}</span>
      ),
    },
    {
      key: "statusLabel",
      header: "Status",
      sortable: true,
      thClassName: "w-[120px]",
      cell: (r) => (
        <span title={r.statusDetail ?? undefined}>
          <Badge variant={r.statusVariant} size="small">
            {r.statusLabel}
          </Badge>
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-[240px] flex-1 flex-col gap-1">
          <label
            htmlFor="conn-search"
            className="text-foreground-weak text-sm font-medium uppercase tracking-wide"
          >
            Search
          </label>
          <input
            id="conn-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="name, slot, or type"
            className="bg-input border-border text-foreground rounded-md border px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring-color,#009eff)]"
          />
        </div>
        <div className="flex min-w-[160px] flex-col gap-1">
          <label
            htmlFor="conn-type"
            className="text-foreground-weak text-sm font-medium uppercase tracking-wide"
          >
            Type
          </label>
          <select
            id="conn-type"
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="bg-input border-border text-foreground rounded-md border px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring-color,#009eff)]"
          >
            <option value="all">All types</option>
            {typeOptions.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={filtered}
        getRowKey={(r) => r.ref}
        rowHref={(r) => hrefFor(r)}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={(key) => toggleSort(key as SortKey)}
        empty={
          <p className="text-foreground-weak text-base">
            No connections match the current filters.
          </p>
        }
      />
    </div>
  );
}
