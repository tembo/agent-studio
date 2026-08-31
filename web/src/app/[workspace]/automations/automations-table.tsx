"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { LocalTime } from "@/components/local-time";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { nextFireAfter, validateCron } from "@/lib/cron";

import { ToggleEnabledForm } from "./toggle-enabled-form";

// One table for EVERY way an agent fires on its own — schedules, Composio event
// triggers, and inbound webhooks — across the whole workspace. Schedules are
// created + toggled here; triggers/webhooks are configured on the owning agent
// (we link out to manage them). Client-side search / type / agent / status
// filters over the full list (rarely enough automations to need server paging).

export type AutomationKind = "schedule" | "trigger" | "webhook";

export type AutomationRow = {
  id: string;
  kind: AutomationKind;
  /** Human label: schedule/webhook name, or the trigger event. */
  name: string;
  agentName: string;
  /** Whose credentials the run uses (display label), or "—" if unknown. */
  runAs: string;
  enabled: boolean;
  lastFiredAtIso: string | null;
  lastFireError: string | null;
  lastFireEventId: string | null;
  /** Where a row click + the row's primary action go. */
  href: string;
  // Per-kind detail shown in the "Trigger" column.
  cron?: string; // schedule
  toolkitSlug?: string; // trigger
  triggerType?: string; // trigger
  tokenLast4?: string | null; // webhook
};

type KindFilter = "all" | AutomationKind;
type StatusFilter = "all" | "enabled" | "disabled" | "error";

const KIND_META: Record<
  AutomationKind,
  { label: string; variant: "blue" | "purple" | "teal" }
> = {
  schedule: { label: "Schedule", variant: "blue" },
  trigger: { label: "Trigger", variant: "purple" },
  webhook: { label: "Webhook", variant: "teal" },
};

export function AutomationsTable({
  rows,
  workspaceSlug,
}: {
  rows: AutomationRow[];
  workspaceSlug: string;
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [agent, setAgent] = useState("");
  const [runAs, setRunAs] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");

  const agentOptions = useMemo(
    () => [
      { value: "", label: "All agents" },
      ...[...new Set(rows.map((r) => r.agentName))]
        .sort()
        .map((n) => ({ value: n, label: n })),
    ],
    [rows],
  );
  const runAsOptions = useMemo(
    () => [
      { value: "", label: "Anyone" },
      ...[...new Set(rows.map((r) => r.runAs).filter((o) => o && o !== "—"))]
        .sort()
        .map((o) => ({ value: o, label: o })),
    ],
    [rows],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (kind !== "all" && r.kind !== kind) return false;
      if (agent && r.agentName !== agent) return false;
      if (runAs && r.runAs !== runAs) return false;
      if (status === "enabled" && !(r.enabled && !r.lastFireError)) return false;
      if (status === "disabled" && r.enabled) return false;
      if (status === "error" && !r.lastFireError) return false;
      if (
        q &&
        !`${r.name} ${r.agentName} ${r.cron ?? ""} ${r.toolkitSlug ?? ""} ${r.triggerType ?? ""}`
          .toLowerCase()
          .includes(q)
      )
        return false;
      return true;
    });
  }, [rows, query, kind, agent, runAs, status]);

  const columns: Column<AutomationRow>[] = [
    {
      key: "kind",
      header: "Type",
      cell: (r) => (
        <Badge variant={KIND_META[r.kind].variant} size="small">
          {KIND_META[r.kind].label}
        </Badge>
      ),
    },
    {
      key: "name",
      header: "Name",
      tdClassName: "max-w-xs",
      cell: (r) => (
        <Link href={r.href} className="text-foreground font-medium hover:underline">
          {r.name}
        </Link>
      ),
    },
    {
      key: "agent",
      header: "Agent",
      cell: (r) => (
        <Link
          href={`/${workspaceSlug}/agents/${encodeURIComponent(r.agentName)}`}
          className="text-foreground hover:underline"
        >
          {r.agentName}
        </Link>
      ),
    },
    {
      key: "detail",
      header: "Trigger",
      cell: (r) => <TriggerDetail row={r} />,
    },
    {
      key: "lastFired",
      header: "Last fired",
      tdClassName: "text-foreground-weak text-sm",
      cell: (r) =>
        r.lastFiredAtIso ? (
          <LocalTime iso={r.lastFiredAtIso} style="relative" />
        ) : (
          <span className="text-foreground-muted">Never</span>
        ),
    },
    {
      key: "runAs",
      header: "Run as",
      tdClassName: "text-foreground-weak text-sm",
      cell: (r) => r.runAs,
    },
    {
      key: "status",
      header: "Status",
      cell: (r) => (
        <>
          <StatusBadge enabled={r.enabled} error={r.lastFireError} />
          {r.lastFireError &&
            (r.lastFireEventId ? (
              <Link
                href={`/${workspaceSlug}/automations/history/${r.lastFireEventId}`}
                className="text-sentiment-negative mt-1 block max-w-[220px] text-sm leading-4 hover:underline"
              >
                {r.lastFireError}
              </Link>
            ) : (
              <p className="text-sentiment-negative mt-1 max-w-[220px] text-sm leading-4">
                {r.lastFireError}
              </p>
            ))}
        </>
      ),
    },
    {
      key: "actions",
      header: "Actions",
      align: "right",
      cell: (r) => (
        <div className="flex justify-end gap-2">
          {r.kind === "schedule" ? (
            <>
              <ToggleEnabledForm
                workspaceSlug={workspaceSlug}
                id={r.id}
                enabled={r.enabled}
              />
              <Link
                href={r.href}
                className="text-foreground-weak hover:text-foreground text-sm"
              >
                Edit
              </Link>
            </>
          ) : (
            <Link
              href={r.href}
              className="text-foreground-weak hover:text-foreground text-sm"
            >
              Manage →
            </Link>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          placeholder="Search automations…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-xs"
          aria-label="Search automations"
        />
        <Select
          value={kind}
          onValueChange={(v) => setKind(v as KindFilter)}
          options={[
            { value: "all", label: "All types" },
            { value: "schedule", label: "Schedules" },
            { value: "trigger", label: "Triggers" },
            { value: "webhook", label: "Webhooks" },
          ]}
          ariaLabel="Filter by type"
          className="min-w-[130px]"
        />
        <Select
          value={agent}
          onValueChange={setAgent}
          options={agentOptions}
          ariaLabel="Filter by agent"
          className="min-w-[150px]"
        />
        <Select
          value={runAs}
          onValueChange={setRunAs}
          options={runAsOptions}
          ariaLabel="Filter by run-as owner"
          className="min-w-[150px]"
        />
        <Select
          value={status}
          onValueChange={(v) => setStatus(v as StatusFilter)}
          options={[
            { value: "all", label: "Any status" },
            { value: "enabled", label: "Enabled" },
            { value: "disabled", label: "Disabled" },
            { value: "error", label: "Error" },
          ]}
          ariaLabel="Filter by status"
          className="min-w-[130px]"
        />
        <span className="text-foreground-weak ml-auto text-sm">
          {filtered.length} of {rows.length}
        </span>
      </div>

      <DataTable
        columns={columns}
        rows={filtered}
        getRowKey={(r) => `${r.kind}:${r.id}`}
        rowHref={(r) => r.href}
        empty={
          <p className="text-foreground-weak rounded-lg border border-dashed border-[var(--color-border)] px-4 py-6 text-center text-sm">
            {rows.length === 0
              ? "No automations yet. Click New automation to schedule an agent or wire up a trigger."
              : "No automations match these filters."}
          </p>
        }
      />
    </div>
  );
}

function TriggerDetail({ row }: { row: AutomationRow }) {
  if (row.kind === "schedule" && row.cron) {
    const preview = validateCron(row.cron);
    const nextFire =
      row.enabled && preview.ok ? nextFireAfter(row.cron, new Date()) : null;
    return (
      <div className="flex flex-col gap-0.5">
        <code className="text-foreground text-sm">{row.cron}</code>
        {preview.ok && (
          <span className="text-foreground-weak text-sm">
            {preview.humanReadable}{" "}
            <span className="text-foreground-muted">(UTC)</span>
          </span>
        )}
        {nextFire && (
          <span className="text-foreground-muted text-sm">
            next <LocalTime iso={nextFire.toISOString()} style="relative" />
          </span>
        )}
      </div>
    );
  }
  if (row.kind === "trigger") {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="text-foreground text-sm">{row.toolkitSlug}</span>
        <code className="text-foreground-weak text-sm">{row.triggerType}</code>
      </div>
    );
  }
  return (
    <span className="text-foreground-weak text-sm">
      Inbound POST{" "}
      {row.tokenLast4 ? (
        <code className="text-foreground-muted">···{row.tokenLast4}</code>
      ) : null}
    </span>
  );
}

function StatusBadge({
  enabled,
  error,
}: {
  enabled: boolean;
  error: string | null;
}) {
  if (!enabled)
    return (
      <Badge variant="gray" size="small">
        Disabled
      </Badge>
    );
  if (error)
    return (
      <Badge variant="red" size="small">
        Error
      </Badge>
    );
  return (
    <Badge variant="green" size="small">
      Enabled
    </Badge>
  );
}
