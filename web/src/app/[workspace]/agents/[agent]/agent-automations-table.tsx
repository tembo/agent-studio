"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";

import { LocalTime } from "@/components/local-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type Column, type SortDir } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { toolkitLabel } from "@/lib/composio-label";
import { nextFireAfter, validateCron } from "@/lib/cron";
import { useActionToast } from "@/lib/use-action-toast";

import { ToggleEnabledForm } from "../../automations/toggle-enabled-form";
import { DeleteTriggerForm } from "./delete-trigger-form";
import { ToggleTriggerForm } from "./toggle-trigger-form";
import {
  deleteWebhookAction,
  rotateWebhookAction,
  toggleWebhookAction,
  type WebhookActionState,
} from "./webhooks-actions";

export type AgentAutomationKind = "schedule" | "trigger" | "webhook";

export type AgentAutomationRow = {
  id: string;
  kind: AgentAutomationKind;
  name: string;
  runAs: string;
  enabled: boolean;
  lastFiredAtIso: string | null;
  lastFireError: string | null;
  lastFireEventId: string | null;
  href: string | null;
  cron?: string;
  toolkitSlug?: string;
  triggerType?: string;
  tokenLast4?: string | null;
  webhookUrl?: string;
  /** Webhook authenticates by Svix signature (Clerk) rather than a bearer token. */
  signed?: boolean;
};

type KindFilter = "all" | AgentAutomationKind;
type StatusFilter = "all" | "enabled" | "disabled" | "error";
type SortKey = "kind" | "name" | "detail" | "lastFired" | "runAs" | "status";

const WEBHOOK_INITIAL: WebhookActionState = {};

const KIND_META: Record<
  AgentAutomationKind,
  { label: string; variant: "blue" | "purple" | "teal" }
> = {
  schedule: { label: "Schedule", variant: "blue" },
  trigger: { label: "Trigger", variant: "purple" },
  webhook: { label: "Webhook", variant: "teal" },
};

export function AgentAutomationsTable({
  rows,
  workspaceSlug,
  canManageWebhooks,
}: {
  rows: AgentAutomationRow[];
  workspaceSlug: string;
  canManageWebhooks: boolean;
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [runAs, setRunAs] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

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
    const out = rows.filter((r) => {
      if (kind !== "all" && r.kind !== kind) return false;
      if (runAs && r.runAs !== runAs) return false;
      if (status === "enabled" && !(r.enabled && !r.lastFireError)) return false;
      if (status === "disabled" && r.enabled) return false;
      if (status === "error" && !r.lastFireError) return false;
      if (
        q &&
        !`${r.name} ${r.cron ?? ""} ${r.toolkitSlug ?? ""} ${r.triggerType ?? ""} ${r.tokenLast4 ?? ""}`
          .toLowerCase()
          .includes(q)
      ) {
        return false;
      }
      return true;
    });
    const dir = sortDir === "asc" ? 1 : -1;
    return out.sort((a, b) => {
      const primary =
        sortValue(a, sortKey).localeCompare(sortValue(b, sortKey)) * dir;
      return primary !== 0 ? primary : a.name.localeCompare(b.name);
    });
  }, [rows, query, kind, runAs, status, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const columns: Column<AgentAutomationRow>[] = [
    {
      key: "kind",
      header: "Type",
      sortable: true,
      cell: (r) => (
        <Badge variant={KIND_META[r.kind].variant} size="small">
          {KIND_META[r.kind].label}
        </Badge>
      ),
    },
    {
      key: "name",
      header: "Name",
      sortable: true,
      tdClassName: "max-w-xs",
      cell: (r) =>
        r.href ? (
          <Link href={r.href} className="text-foreground font-medium hover:underline">
            {r.name}
          </Link>
        ) : (
          <span className="text-foreground font-medium">{r.name}</span>
        ),
    },
    {
      key: "detail",
      header: "Trigger",
      sortable: true,
      cell: (r) => <TriggerDetail row={r} />,
    },
    {
      key: "lastFired",
      header: "Last fired",
      sortable: true,
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
      sortable: true,
      tdClassName: "text-foreground-weak text-sm",
      cell: (r) => r.runAs,
    },
    {
      key: "status",
      header: "Status",
      sortable: true,
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
        <AgentAutomationActions
          row={r}
          workspaceSlug={workspaceSlug}
          canManageWebhooks={canManageWebhooks}
        />
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          placeholder="Search automations..."
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
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={(key) => toggleSort(key as SortKey)}
        empty={
          <p className="text-foreground-weak rounded-lg border border-dashed border-[var(--color-border)] px-4 py-6 text-center text-sm">
            {rows.length === 0
              ? "No automations yet. Add a schedule, trigger, or webhook below."
              : "No automations match these filters."}
          </p>
        }
      />
    </div>
  );
}

function AgentAutomationActions({
  row,
  workspaceSlug,
  canManageWebhooks,
}: {
  row: AgentAutomationRow;
  workspaceSlug: string;
  canManageWebhooks: boolean;
}) {
  if (row.kind === "schedule") {
    return (
      <div className="flex justify-end gap-2">
        <ToggleEnabledForm
          workspaceSlug={workspaceSlug}
          id={row.id}
          enabled={row.enabled}
        />
        {row.href && (
          <Link
            href={row.href}
            className="text-foreground-weak hover:text-foreground text-sm"
          >
            Edit
          </Link>
        )}
      </div>
    );
  }

  if (row.kind === "trigger") {
    return (
      <div className="flex justify-end gap-3">
        <ToggleTriggerForm
          workspaceSlug={workspaceSlug}
          id={row.id}
          nextEnabled={!row.enabled}
        />
        <DeleteTriggerForm workspaceSlug={workspaceSlug} id={row.id} />
      </div>
    );
  }

  return (
    <WebhookActions
      row={row}
      workspaceSlug={workspaceSlug}
      canManage={canManageWebhooks}
    />
  );
}

function WebhookActions({
  row,
  workspaceSlug,
  canManage,
}: {
  row: AgentAutomationRow;
  workspaceSlug: string;
  canManage: boolean;
}) {
  const [toggleState, toggleAction, togglePending] = useActionState(
    toggleWebhookAction,
    WEBHOOK_INITIAL,
  );
  const [rotateState, rotateAction, rotatePending] = useActionState(
    rotateWebhookAction,
    WEBHOOK_INITIAL,
  );
  const [deleteState, deleteAction, deletePending] = useActionState(
    deleteWebhookAction,
    WEBHOOK_INITIAL,
  );
  useActionToast(toggleState);
  useActionToast(rotateState);
  useActionToast(deleteState);

  if (!canManage) return <span className="text-foreground-muted text-sm">-</span>;

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex justify-end gap-2">
        <form action={toggleAction}>
          <input type="hidden" name="workspace" value={workspaceSlug} />
          <input type="hidden" name="id" value={row.id} />
          <input
            type="hidden"
            name="enabled"
            value={row.enabled ? "false" : "true"}
          />
          <Button
            type="submit"
            variant="ghost"
            size="small"
            disabled={togglePending}
          >
            {row.enabled ? "Disable" : "Enable"}
          </Button>
        </form>
        {/* Signed (Clerk) webhooks authenticate by signature, not the bearer
            token, so there's nothing to rotate — hide it. */}
        {!row.signed && (
          <form action={rotateAction}>
            <input type="hidden" name="workspace" value={workspaceSlug} />
            <input type="hidden" name="id" value={row.id} />
            <Button
              type="submit"
              variant="ghost"
              size="small"
              disabled={rotatePending}
            >
              Rotate
            </Button>
          </form>
        )}
        <form action={deleteAction}>
          <input type="hidden" name="workspace" value={workspaceSlug} />
          <input type="hidden" name="id" value={row.id} />
          <Button
            type="submit"
            variant="ghost"
            size="small"
            disabled={deletePending}
          >
            Remove
          </Button>
        </form>
      </div>
      {rotateState.secret && (
        <div className="border-sentiment-caution bg-[var(--color-sentiment-caution-subtle)] max-w-sm rounded-lg border p-2 text-left">
          <p className="text-foreground text-sm font-medium">
            Copy these now. The token is shown only once.
          </p>
          <code className="text-foreground-weak block truncate text-xs">
            {rotateState.secret.url}
          </code>
          <code className="text-foreground-weak block truncate text-xs">
            {rotateState.secret.token}
          </code>
        </div>
      )}
    </div>
  );
}

function sortValue(row: AgentAutomationRow, key: SortKey): string {
  switch (key) {
    case "kind":
      return KIND_META[row.kind].label;
    case "name":
      return row.name;
    case "detail":
      if (row.kind === "schedule") return row.cron ?? "";
      if (row.kind === "trigger") {
        return `${row.toolkitSlug ?? ""} ${row.triggerType ?? ""}`;
      }
      return row.tokenLast4 ? `webhook ${row.tokenLast4}` : "webhook";
    case "lastFired":
      return row.lastFiredAtIso ?? "";
    case "runAs":
      return row.runAs;
    case "status":
      if (row.lastFireError) return "0 Error";
      if (!row.enabled) return "1 Disabled";
      return "2 Enabled";
  }
}

function TriggerDetail({ row }: { row: AgentAutomationRow }) {
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
        <span className="text-foreground text-sm">
          {toolkitLabel(row.toolkitSlug ?? "")}
        </span>
        <code className="text-foreground-weak text-sm">{row.triggerType}</code>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-foreground-weak text-sm">
        Inbound POST{" "}
        {row.signed ? (
          <span className="text-foreground-muted">signed (Svix)</span>
        ) : row.tokenLast4 ? (
          <code className="text-foreground-muted">...{row.tokenLast4}</code>
        ) : null}
      </span>
      {row.webhookUrl && (
        <code className="text-foreground-muted max-w-[260px] truncate text-xs">
          {row.webhookUrl}
        </code>
      )}
    </div>
  );
}

function StatusBadge({
  enabled,
  error,
}: {
  enabled: boolean;
  error: string | null;
}) {
  if (!enabled) {
    return (
      <Badge variant="gray" size="small">
        Disabled
      </Badge>
    );
  }
  if (error) {
    return (
      <Badge variant="red" size="small">
        Error
      </Badge>
    );
  }
  return (
    <Badge variant="green" size="small">
      Enabled
    </Badge>
  );
}
