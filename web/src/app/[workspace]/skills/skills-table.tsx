"use client";

import { useState } from "react";

import { DataTable, type Column } from "@/components/ui/data-table";
import type { SkillOwner } from "@/lib/skill-owners";

// Installed skills as a row-per-skill table (shared DataTable: hover + whole-row
// click to the skill's detail page). Fed plain rows by the server page.

export type SkillRow = {
  name: string;
  description: string | null;
  href: string;
  owner: SkillOwner | null;
};

export function filterSkillsByOwner(rows: SkillRow[], ownerFilter: string): SkillRow[] {
  return rows.filter((row) =>
    ownerFilter === "all" ||
    (ownerFilter === "unassigned" ? !row.owner : `user:${row.owner?.userId}` === ownerFilter),
  );
}

export function SkillsTable({ rows }: { rows: SkillRow[] }) {
  const [ownerFilter, setOwnerFilter] = useState("all");
  const owners = Array.from(new Map(
    rows.flatMap((row) => row.owner ? [[row.owner.userId, row.owner] as const] : []),
  ).values()).sort((first, second) => first.name.localeCompare(second.name));
  const filteredRows = filterSkillsByOwner(rows, ownerFilter);
  const columns: Column<SkillRow>[] = [
    {
      key: "name",
      header: "Skill",
      thClassName: "w-[240px]",
      cell: (s) => (
        <code className="text-foreground text-sm font-medium">{s.name}</code>
      ),
    },
    {
      key: "owner",
      header: "Owner",
      tdClassName: "text-foreground-weak text-sm",
      cell: (skill) => skill.owner?.name ?? "Unassigned",
    },
    {
      key: "description",
      header: "Description",
      tdClassName: "text-foreground-weak text-sm",
      cell: (s) =>
        s.description ? (
          <span className="line-clamp-2 leading-5">{s.description}</span>
        ) : (
          <span className="text-foreground-muted">—</span>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <label htmlFor="skill-owner-filter" className="text-foreground-weak text-sm">
          Owner
        </label>
        <select
          id="skill-owner-filter"
          value={ownerFilter}
          onChange={(event) => setOwnerFilter(event.target.value)}
          className="border-border bg-surface-raised text-foreground rounded-md border px-3 py-2 text-sm"
        >
          <option value="all">All owners</option>
          <option value="unassigned">Unassigned</option>
          {owners.map((owner) => (
            <option key={owner.userId} value={`user:${owner.userId}`}>
              {owner.name}
            </option>
          ))}
        </select>
        <span className="text-foreground-muted text-sm" role="status">
          {filteredRows.length} of {rows.length} skills
        </span>
      </div>
      <DataTable
        columns={columns}
        rows={filteredRows}
        getRowKey={(s) => s.name}
        rowHref={(s) => s.href}
        empty={
          <p className="text-foreground-weak py-8 text-center text-sm">
            No skills match this owner.
          </p>
        }
      />
    </div>
  );
}
