"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
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
import { ALL_AUDIT_SOURCES, type AuditSource } from "@/lib/audit";
import { getMcpProvider } from "@/lib/mcp-providers";

import { loadAuditAction } from "./actions";
import type { LoadedAuditEntry } from "./shape";

type SinceKey = "24h" | "7d" | "30d" | "all";

const SINCE_PRESETS: { key: SinceKey; label: string; ms: number | null }[] = [
  { key: "24h", label: "24h", ms: 24 * 60 * 60 * 1000 },
  { key: "7d", label: "7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { key: "30d", label: "30 days", ms: 30 * 24 * 60 * 60 * 1000 },
  { key: "all", label: "All", ms: null },
];

const PAGE_SIZE = 100;

type Actor = { userId: string; displayName: string | null; email: string };

type Props = {
  workspaceSlug: string;
  actors: Actor[];
  initial: LoadedAuditEntry[];
  initialFilters: {
    sources: AuditSource[];
    actor: string;
    agent: string;
    since: SinceKey;
  };
};

export function AuditTimeline({
  workspaceSlug,
  actors,
  initial,
  initialFilters,
}: Props) {
  const router = useRouter();
  // Filter state syncs to the URL via applyFilters → router.push.
  // We also re-sync from initialFilters whenever the props change so
  // browser back/forward navigation keeps the chip UI in sync with
  // the URL the server just rendered.
  const [sources, setSources] = useState<AuditSource[]>(initialFilters.sources);
  const [actor, setActor] = useState<string>(initialFilters.actor);
  const [agent, setAgent] = useState<string>(initialFilters.agent);
  const [since, setSince] = useState<SinceKey>(initialFilters.since);

  const filtersKey = JSON.stringify({
    sources: initialFilters.sources,
    actor: initialFilters.actor,
    agent: initialFilters.agent,
    since: initialFilters.since,
  });
  const prevFiltersKey = useRef(filtersKey);
  useEffect(() => {
    if (prevFiltersKey.current !== filtersKey) {
      setSources(initialFilters.sources);
      setActor(initialFilters.actor);
      setAgent(initialFilters.agent);
      setSince(initialFilters.since);
      prevFiltersKey.current = filtersKey;
    }
    // initialFilters is a fresh object each render, so we depend on
    // the serialized key instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey]);

  // Rows render directly from `initial` (which the server re-fetches
  // when filters change) plus any pages appended via "Load more."
  // `appended` resets whenever the filter set changes so we don't
  // mix pages across filter contexts.
  const [appended, setAppended] = useState<LoadedAuditEntry[]>([]);
  const [more, setMore] = useState<boolean>(initial.length >= PAGE_SIZE);
  useEffect(() => {
    // Server props changed after URL filter navigation; discard client-only
    // appended pages so rows never mix filter contexts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAppended([]);
    setMore(initial.length >= PAGE_SIZE);
  }, [filtersKey, initial.length]);
  const rows = useMemo(() => [...initial, ...appended], [initial, appended]);

  const [pending, startTransition] = useTransition();

  const actorOptions = useMemo(
    () => [
      { value: "", label: "Any actor" },
      ...actors.map((a) => ({
        value: a.userId,
        label: a.displayName ?? a.email,
      })),
    ],
    [actors],
  );

  // Filter changes drive a URL navigation so the server re-renders
  // the initial page with the new filter set, and the URL stays
  // shareable. Cheaper than a parallel client-side fetch path.
  function applyFilters(next: {
    sources?: AuditSource[];
    actor?: string;
    agent?: string;
    since?: SinceKey;
  }) {
    const u = buildFilterParams({
      sources: next.sources ?? sources,
      actor: next.actor ?? actor,
      agent: next.agent ?? agent,
      since: next.since ?? since,
    });
    const qs = u.toString();
    router.push(`/${workspaceSlug}/audit${qs ? `?${qs}` : ""}`);
  }

  // Export href mirrors the current filter set so "Export JSON" hands
  // off exactly the rows the user is seeing in the table. Recomputes
  // on filter change without a network round-trip.
  const exportHref = useMemo(() => {
    const u = buildFilterParams({ sources, actor, agent, since });
    const qs = u.toString();
    return `/api/workspaces/${workspaceSlug}/audit/export${qs ? `?${qs}` : ""}`;
  }, [workspaceSlug, sources, actor, agent, since]);

  const sinceIso = useMemo(() => {
    const preset = SINCE_PRESETS.find((p) => p.key === since);
    if (!preset || preset.ms === null) return undefined;
    // Client-side filter preset needs the current browser clock when applied.
    // eslint-disable-next-line react-hooks/purity
    return new Date(Date.now() - preset.ms).toISOString();
  }, [since]);

  const onLoadMore = useCallback(() => {
    if (rows.length === 0) return;
    const last = rows[rows.length - 1];
    startTransition(async () => {
      const next = await loadAuditAction({
        workspaceSlug,
        filters: {
          sources: sources.length ? sources : undefined,
          actor: actor || undefined,
          agent: agent || undefined,
          since: sinceIso,
        },
        beforeIso: last.at,
      });
      setAppended((prev) => [...prev, ...next]);
      setMore(next.length >= PAGE_SIZE);
    });
  }, [rows, workspaceSlug, sources, actor, agent, sinceIso]);

  function toggleSource(s: AuditSource) {
    const next = sources.includes(s)
      ? sources.filter((x) => x !== s)
      : [...sources, s];
    setSources(next);
    applyFilters({ sources: next });
  }

  const columns: Column<LoadedAuditEntry>[] = [
    {
      key: "when",
      header: "When",
      thClassName: "w-[140px]",
      cell: (r) => (
        <span className="text-foreground-weak whitespace-nowrap text-sm">
          <LocalTime iso={r.at} style="relative" />
        </span>
      ),
    },
    {
      key: "actor",
      header: "Actor",
      thClassName: "w-[160px]",
      cell: (r) => (
        <span className="text-foreground whitespace-nowrap text-sm">
          {r.actorDisplayName ?? (
            <span className="text-foreground-muted italic">System</span>
          )}
        </span>
      ),
    },
    {
      key: "source",
      header: "Source",
      thClassName: "w-[140px]",
      cell: (r) => (
        <Badge variant={SOURCE_TONE[r.source]} size="small">
          {SOURCE_LABELS[r.source]}
        </Badge>
      ),
    },
    {
      key: "event",
      header: "Event",
      cell: (r) => (
        <div className="flex flex-col gap-0.5">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-medium">{humanKind(r.kind)}</span>
            <TargetLink entry={r} workspaceSlug={workspaceSlug} />
          </div>
          <EventSummary entry={r} />
          <RawPayload payload={r.payload} />
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      {/* Filter row */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-foreground-weak w-20 shrink-0 text-sm uppercase tracking-wide">
            Source
          </span>
          {ALL_AUDIT_SOURCES.map((s) => (
            <FilterChip
              key={s}
              active={sources.includes(s)}
              onClick={() => toggleSource(s)}
              label={SOURCE_LABELS[s]}
            />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-foreground-weak w-20 shrink-0 text-sm uppercase tracking-wide">
            Window
          </span>
          {SINCE_PRESETS.map((p) => (
            <FilterChip
              key={p.key}
              active={since === p.key}
              onClick={() => {
                setSince(p.key);
                applyFilters({ since: p.key });
              }}
              label={p.label}
            />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-foreground-weak w-20 shrink-0 text-sm uppercase tracking-wide">
            Actor
          </span>
          <Select
            value={actor}
            onValueChange={(v) => {
              setActor(v);
              applyFilters({ actor: v });
            }}
            options={actorOptions}
            ariaLabel="Filter by actor"
            className="min-w-[200px]"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label
            htmlFor="audit-agent"
            className="text-foreground-weak w-20 shrink-0 text-sm uppercase tracking-wide"
          >
            Agent
          </label>
          <Input
            id="audit-agent"
            type="search"
            placeholder="agent name"
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            onBlur={() => applyFilters({ agent })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyFilters({ agent });
              }
            }}
            className="max-w-xs"
            maxLength={120}
          />
        </div>
      </div>

      <hr className="border-[var(--color-border-weak)]" />

      <div className="flex items-center justify-between gap-3">
        <div className="text-foreground-weak text-sm">
          {pending
            ? "Loading…"
            : rows.length === 0
              ? "No events match these filters."
              : `${rows.length} event${rows.length === 1 ? "" : "s"}${more ? "+" : ""}`}
        </div>
        {rows.length > 0 && (
          <a
            href={exportHref}
            // `download` is advisory; the route also sets
            // Content-Disposition: attachment so the browser saves
            // regardless of how the link gets opened.
            download
            className="text-foreground-weak hover:text-foreground text-sm hover:underline"
          >
            Export JSON →
          </a>
        )}
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(r) => `${r.origin}:${r.id}`}
        empty={null}
      />

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

// Full detail for any event, on demand. The per-kind summary above is a glance;
// this <details> (no JS) exposes the complete payload — the source of truth for
// fields the summary doesn't render. Hidden when the payload is empty.
function RawPayload({ payload }: { payload: Record<string, unknown> }) {
  const keys = Object.keys(payload ?? {});
  if (keys.length === 0) return null;
  return (
    <details className="group mt-0.5">
      <summary className="text-foreground-muted hover:text-foreground-weak cursor-pointer text-xs select-none">
        Details
      </summary>
      <pre className="bg-surface-secondary text-foreground-weak mt-1 overflow-x-auto rounded-md p-2 text-xs">
        {JSON.stringify(payload, null, 2)}
      </pre>
    </details>
  );
}

function TargetLink({
  entry,
  workspaceSlug,
}: {
  entry: LoadedAuditEntry;
  workspaceSlug: string;
}) {
  // Click-through targets vary by event type. Run/improvement origins
  // get their natural detail page; agent-scoped explicit events get
  // the per-agent detail page; everything else just shows the name
  // unlinked.
  if (entry.origin === "run" && entry.targetId && entry.agentName) {
    return (
      <Link
        href={`/${workspaceSlug}/agents/${encodeURIComponent(entry.agentName)}/runs/${entry.targetId}`}
        className="text-foreground-weak hover:underline text-sm"
      >
        on {entry.agentName} →
      </Link>
    );
  }
  if (entry.origin === "improvement" && entry.agentName) {
    return (
      <Link
        href={`/${workspaceSlug}/improvements`}
        className="text-foreground-weak hover:underline text-sm"
      >
        on {entry.agentName} →
      </Link>
    );
  }
  if (entry.agentName) {
    return (
      <Link
        href={`/${workspaceSlug}/agents/${encodeURIComponent(entry.agentName)}`}
        className="text-foreground-weak hover:underline text-sm"
      >
        on {entry.agentName} →
      </Link>
    );
  }
  return null;
}

function EventSummary({ entry }: { entry: LoadedAuditEntry }) {
  const p = entry.payload;
  // Per-kind summaries kept brief — full payload is JSON-encoded
  // available behind a "View" toggle later if we add one. For v0.4-01
  // MVP, the inline summary covers the audit-needs-to-glance use
  // case.
  switch (entry.kind) {
    case "run.succeeded":
    case "run.failed":
    case "run.running":
    case "run.queued": {
      const status = String(p.status ?? "");
      const environment = p.environment
        ? ` · ${String(p.environment)}`
        : "";
      const cost = p.costUsd ? ` · ~$${Number(p.costUsd).toFixed(4)}` : "";
      const dur = p.durationMs
        ? ` · ${(Number(p.durationMs) / 1000).toFixed(1)}s`
        : "";
      const err = p.errorMessage
        ? ` · ${String(p.errorMessage).slice(0, 80)}`
        : "";
      return (
        <span className="text-foreground-weak text-sm">
          {status}
          {environment}
          {dur}
          {cost}
          {err}
        </span>
      );
    }
    case "improvement.submitted":
    case "improvement.pr_opened":
    case "improvement.merged":
    case "improvement.closed":
      return (
        <span className="text-foreground-weak truncate text-sm">
          {String(p.improvementText ?? "")}
        </span>
      );
    case "automation.created":
    case "automation.updated":
    case "automation.deleted":
    case "automation.enabled":
    case "automation.disabled":
      return (
        <span className="text-foreground-weak text-sm">
          {String(p.name ?? "")}
          {p.cron ? ` · ${String(p.cron)}` : ""}
        </span>
      );
    case "trigger.created":
    case "trigger.deleted":
    case "trigger.enabled":
    case "trigger.disabled":
      return (
        <span className="text-foreground-weak text-sm">
          {String(p.toolkit ?? "")} · {String(p.triggerType ?? "")}
        </span>
      );
    case "connection.authorized":
    case "connection.disconnected": {
      const provider = connectionProviderLabel(p);
      const tag = connectionSourceTag(p);
      return (
        <span className="text-foreground-weak text-sm">
          {provider || "connection"} · {String(p.name ?? "default")}
          {tag ? ` · ${tag}` : ""}
        </span>
      );
    }
    case "connection.renamed": {
      // Composio uses oldName/newName; native-MCP uses old_name/new_name.
      const oldName = String(p.oldName ?? p.old_name ?? "");
      const newName = String(p.newName ?? p.new_name ?? "");
      const provider = connectionProviderLabel(p);
      return (
        <span className="text-foreground-weak text-sm">
          {provider ? `${provider} · ` : ""}
          {oldName} → {newName}
        </span>
      );
    }
    case "workspace.renamed":
      return (
        <span className="text-foreground-weak text-sm">
          {String(p.fromName ?? "")} → {String(p.toName ?? "")}
          {p.fromSlug !== p.toSlug
            ? ` · /${String(p.fromSlug ?? "")} → /${String(p.toSlug ?? "")}`
            : ""}
        </span>
      );
    case "workspace.commit_mode_changed":
      return (
        <span className="text-foreground-weak text-sm">
          {commitModeLabel(p.from)} → {commitModeLabel(p.to)}
        </span>
      );
    case "skill.installed":
    case "skill.removed":
      return (
        <span className="text-foreground-weak text-sm">
          {String(p.name ?? "")}
          {p.source ? ` · ${String(p.source)}` : ""}
        </span>
      );
    case "secret.set":
    case "secret.rotated":
    case "secret.removed":
      return (
        <span className="text-foreground-weak text-sm">
          {String(p.secretKind ?? "")}
        </span>
      );
    case "member.added": {
      const role = String(p.role ?? "");
      // Two flavors: an admin adding an existing user (payload has `email`;
      // the actor column is the admin), or a user accepting their own invite
      // (the actor column is that user; `invitedBy` records who invited them).
      if (p.via === "invite_accepted") {
        return (
          <span className="text-foreground-weak text-sm">
            accepted invite{role ? ` as ${role}` : ""}
            {p.invitedBy ? ` · invited by ${String(p.invitedBy)}` : ""}
          </span>
        );
      }
      const t = p.target as { name?: string; email?: string } | undefined;
      const who = String(p.email ?? t?.name ?? t?.email ?? "");
      return (
        <span className="text-foreground-weak text-sm">
          {who}
          {role ? ` as ${role}` : ""}
        </span>
      );
    }
    case "member.role_changed": {
      const t = p.target as { name?: string; email?: string } | undefined;
      const who = t?.name ?? t?.email ?? "";
      return (
        <span className="text-foreground-weak text-sm">
          {who} · {String(p.previousRole ?? "")} → {String(p.newRole ?? "")}
        </span>
      );
    }
    case "member.removed": {
      const t = p.target as { name?: string; email?: string } | undefined;
      const who = t?.name ?? t?.email ?? "";
      return (
        <span className="text-foreground-weak text-sm">
          {who}
          {p.previousRole ? ` (was ${String(p.previousRole)})` : ""}
        </span>
      );
    }
    case "audit.exported": {
      const f = p.filters as Record<string, unknown> | undefined;
      const rc = p.rowCount as number | undefined;
      const parts: string[] = [];
      if (rc !== undefined) parts.push(`${rc} rows`);
      if (f?.agent) parts.push(`agent: ${String(f.agent)}`);
      if (Array.isArray(f?.sources))
        parts.push(`sources: ${(f.sources as string[]).join(", ")}`);
      return (
        <span className="text-foreground-weak text-sm">
          {parts.join(" · ")}
        </span>
      );
    }
    case "member.invited":
      return (
        <span className="text-foreground-weak text-sm">
          {String(p.email ?? "")}
          {p.role ? ` as ${String(p.role)}` : ""}
        </span>
      );
    case "member.invite_revoked":
      return (
        <span className="text-foreground-weak text-sm">
          {String(p.email ?? "")}
        </span>
      );
    case "auth.login": {
      const parts: string[] = [];
      if (p.ipAddress) parts.push(String(p.ipAddress));
      if (p.userAgent) parts.push(shortUserAgent(String(p.userAgent)));
      return parts.length ? (
        <span className="text-foreground-weak text-sm">{parts.join(" · ")}</span>
      ) : null;
    }
    case "repo.connected":
      return (
        <span className="text-foreground-weak text-sm">
          {String(p.repo ?? "")}
          {p.defaultBranch ? ` · ${String(p.defaultBranch)}` : ""}
        </span>
      );
    case "workspace.created":
      return (
        <span className="text-foreground-weak text-sm">
          {String(p.name ?? "")}
          {p.slug ? ` · /${String(p.slug)}` : ""}
        </span>
      );
    case "slack_app.created":
    case "slack_app.deleted":
      return (
        <span className="text-foreground-weak text-sm">{String(p.name ?? "")}</span>
      );
    case "slack_app.updated": {
      const rotated = Array.isArray(p.rotatedSecrets)
        ? (p.rotatedSecrets as string[])
        : [];
      return (
        <span className="text-foreground-weak text-sm">
          {String(p.name ?? "")}
          {rotated.length ? ` · rotated ${rotated.join(", ")}` : ""}
        </span>
      );
    }
    case "slack_message.sent":
      return (
        <span className="text-foreground-weak text-sm">
          {String(p.slackApp ?? "")} → {String(p.destination ?? "")}
        </span>
      );
    case "webhook.created":
    case "webhook.rotated":
    case "webhook.enabled":
    case "webhook.disabled":
    case "webhook.deleted":
      return (
        <span className="text-foreground-weak text-sm">{String(p.name ?? "")}</span>
      );
    case "native_oauth_client.set":
    case "native_oauth_client.removed":
      return (
        <span className="text-foreground-weak text-sm">
          {connectionProviderLabel(p)}
          {p.instance ? ` · ${String(p.instance)}` : ""}
        </span>
      );
    case "native_mcp_provider.enabled":
    case "native_mcp_provider.disabled":
      return (
        <span className="text-foreground-weak text-sm">
          {connectionProviderLabel(p)}
        </span>
      );
    case "secret_connection.set":
    case "secret_connection.rotated":
    case "secret_connection.removed":
      return (
        <span className="text-foreground-weak text-sm">
          {String(p.slug ?? "")}
        </span>
      );
    case "agent.version.promoted":
      return (
        <span className="text-foreground-weak text-sm">
          {p.versionNumber ? `v${String(p.versionNumber)}` : ""}
        </span>
      );
    case "guidance.synced":
      return (
        <span className="text-foreground-weak text-sm">
          {p.trigger === "schedule"
            ? `${String(p.cadence ?? "Scheduled")} refresh · `
            : "Manual refresh · "}
          agents/AGENTS.md + per-framework guides
        </span>
      );
    case "guidance.cadence_changed":
      return (
        <span className="text-foreground-weak text-sm">
          {String(p.from ?? "off")} → {String(p.to ?? "off")}
        </span>
      );
    case "api_key.created":
    case "api_key.enabled":
    case "api_key.disabled":
    case "api_key.deleted":
      return (
        <span className="text-foreground-weak text-sm">
          {String(p.name ?? "")}
        </span>
      );
    case "slack_app.installed":
      return (
        <span className="text-foreground-weak text-sm">
          {p.teamId ? `Slack team ${String(p.teamId)}` : ""}
        </span>
      );
    case "slack.dispatch":
      return (
        <span className="text-foreground-weak text-sm">
          {String(p.slackAppName ?? "")}
          {p.channel ? ` · ${String(p.channel)}` : ""}
        </span>
      );
    default:
      return null;
  }
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
      className={`flex items-center rounded-full border px-2.5 py-1 text-sm transition-colors ${
        active
          ? "border-foreground bg-surface-raised text-foreground"
          : "border-border bg-surface text-foreground-weak hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}

const SOURCE_LABELS: Record<AuditSource, string> = {
  chat: "Chat",
  pr: "PR",
  hitl_response: "HITL",
  dashboard_event: "Dashboard",
  correction: "Correction",
  human_action: "Human",
  policy_change: "Policy",
  system: "System",
};

const SOURCE_TONE: Record<
  AuditSource,
  "gray" | "blue" | "green" | "yellow" | "red" | "purple"
> = {
  chat: "blue",
  pr: "purple",
  hitl_response: "yellow",
  dashboard_event: "gray",
  correction: "red",
  human_action: "green",
  policy_change: "yellow",
  system: "gray",
};

function buildFilterParams(args: {
  sources: AuditSource[];
  actor: string;
  agent: string;
  since: SinceKey;
}): URLSearchParams {
  const u = new URLSearchParams();
  for (const s of args.sources) u.append("source", s);
  if (args.actor) u.set("actor", args.actor);
  if (args.agent) u.set("agent", args.agent);
  // "30d" is the default the page applies when ?since is missing, so
  // omit it from the URL to keep the canonical form clean.
  if (args.since !== "30d") u.set("since", args.since);
  return u;
}

function commitModeLabel(v: unknown): string {
  if (v === "direct") return "YOLO";
  if (v === "pull_request") return "Always PR";
  return String(v ?? "");
}

// Condense a User-Agent string to a recognizable browser/OS for the login row;
// fall back to a truncated raw string. Full UA stays in the raw-payload details.
function shortUserAgent(ua: string): string {
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /OPR\/|Opera/.test(ua) ? "Opera"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Safari\//.test(ua) ? "Safari"
    : null;
  const os =
    /Mac OS X/.test(ua) ? "macOS"
    : /Windows/.test(ua) ? "Windows"
    : /Android/.test(ua) ? "Android"
    : /(iPhone|iPad)/.test(ua) ? "iOS"
    : /Linux/.test(ua) ? "Linux"
    : null;
  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  return ua.length > 40 ? `${ua.slice(0, 40)}…` : ua;
}

// Connection events come from two stacks with different payload keys: Composio
// records `toolkit` (a slug), native-MCP records `provider` (a slug we map to a
// display name). Prefer the human name so a row reads "Attio", not blank.
function connectionProviderLabel(p: Record<string, unknown>): string {
  if (typeof p.provider === "string") {
    return getMcpProvider(p.provider)?.displayName ?? p.provider;
  }
  if (typeof p.toolkit === "string") return p.toolkit;
  return "";
}

// A short tag for which connection stack the event came from.
function connectionSourceTag(p: Record<string, unknown>): string | null {
  if (p.source === "native-mcp") return "Native MCP";
  if (p.source === "secret") return "secret";
  if (typeof p.toolkit === "string") return "Composio";
  return null;
}

function humanKind(kind: string): string {
  // Lookup table for common kinds; fall back to the dotted form for
  // anything we haven't named. New event types render readably without
  // requiring this table to be updated.
  const map: Record<string, string> = {
    "run.queued": "Run queued",
    "run.running": "Run started",
    "run.succeeded": "Run succeeded",
    "run.failed": "Run failed",
    "improvement.submitted": "Improvement submitted",
    "improvement.pr_opened": "Improvement PR opened",
    "improvement.merged": "Improvement merged",
    "improvement.closed": "Improvement closed",
    "automation.created": "Automation created",
    "automation.updated": "Automation updated",
    "automation.deleted": "Automation deleted",
    "automation.enabled": "Automation enabled",
    "automation.disabled": "Automation disabled",
    "trigger.created": "Trigger created",
    "trigger.deleted": "Trigger deleted",
    "trigger.enabled": "Trigger enabled",
    "trigger.disabled": "Trigger disabled",
    "connection.authorized": "Connection authorized",
    "connection.disconnected": "Connection disconnected",
    "connection.renamed": "Connection renamed",
    "secret.set": "Secret saved",
    "secret.rotated": "Secret rotated",
    "secret.removed": "Secret removed",
    "agent.deleted": "Agent deleted",
    "agent.restored": "Agent restored",
    "repo.connected": "Repository connected",
    "repo.disconnected": "Repository disconnected",
    "workspace.created": "Workspace created",
    "workspace.renamed": "Workspace renamed",
    "workspace.commit_mode_changed": "Delivery mode changed",
    "guidance.synced": "Agent guidance synced",
    "guidance.cadence_changed": "Guidance refresh changed",
    "skill.installed": "Skill installed",
    "skill.removed": "Skill removed",
    "slack_app.created": "Slack app created",
    "slack_app.updated": "Slack app updated",
    "slack_app.deleted": "Slack app deleted",
    "slack_message.sent": "Slack message sent",
    "member.added": "Member added",
    "member.invited": "Member invited",
    "member.invite_revoked": "Invitation revoked",
    "member.role_changed": "Member role changed",
    "member.removed": "Member removed",
    "auth.login": "Signed in",
    "audit.exported": "Audit exported",
    "api_key.created": "API key created",
    "api_key.enabled": "API key enabled",
    "api_key.disabled": "API key disabled",
    "api_key.deleted": "API key deleted",
    "agent.version.promoted": "Agent version promoted",
    "agent.owner.changed": "Agent owner changed",
    "webhook.created": "Webhook created",
    "webhook.rotated": "Webhook secret rotated",
    "webhook.enabled": "Webhook enabled",
    "webhook.disabled": "Webhook disabled",
    "webhook.deleted": "Webhook deleted",
    "secret_connection.set": "Secret connection saved",
    "secret_connection.rotated": "Secret connection rotated",
    "secret_connection.removed": "Secret connection removed",
    "native_oauth_client.set": "MCP OAuth app saved",
    "native_oauth_client.removed": "MCP OAuth app removed",
    "native_mcp_provider.enabled": "MCP provider enabled",
    "native_mcp_provider.disabled": "MCP provider disabled",
    "slack_app.installed": "Slack app installed",
    "slack.dispatch": "Run launched from Slack",
    "improvement.dismissed": "Pending agent dismissed",
  };
  return map[kind] ?? kind;
}
