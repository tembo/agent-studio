import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { BackLink } from "@/components/back-link";
import { LocalTime } from "@/components/local-time";
import { McpProviderLogo } from "@/components/mcp-provider-logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toolkitLabel } from "@/lib/composio-label";
import { resolveConnectionsView } from "@/lib/connections-view";
import { getMcpProvider, isDcrProvider } from "@/lib/mcp-providers";
import { listToolsForConnection } from "@/lib/mcp-tools";
import { getServerSession } from "@/lib/session";
import { getWorkspaceBySlug } from "@/lib/workspace";

import {
  loadConnection,
  parseConnectionRef,
  type StatusVariant,
} from "../connection-ref";
import { DisconnectComposioConnectionForm } from "../../settings/disconnect-composio-connection-form";
import { RefreshComposioToolsForm } from "../../settings/refresh-composio-tools-form";
import { DisconnectNativeMcpConnectionForm } from "../disconnect-native-mcp-connection-form";
import { DisconnectManualCredentialForm } from "../disconnect-manual-credential-form";
import { RefreshNativeMcpToolsForm } from "../refresh-native-mcp-tools-form";

export const dynamic = "force-dynamic";

export default async function ConnectionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspace: slug, id } = await params;
  const sp = await searchParams;

  const session = await getServerSession();
  if (!session) notFound();
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();

  const ref = parseConnectionRef(id);
  if (!ref) notFound();

  const requestedUser = typeof sp.user === "string" ? sp.user : undefined;
  const view = await resolveConnectionsView(
    workspace.id,
    session.user.id,
    requestedUser,
  );
  const loaded = await loadConnection(workspace.id, view.userId, ref);
  if (!loaded) notFound();

  const userQs = view.viewingOther
    ? `?user=${encodeURIComponent(view.userId)}`
    : "";
  const editHref = `/${workspace.slug}/connections/${id}/edit${userQs}`;
  const resultParam = typeof sp.result === "string" ? sp.result : undefined;
  const detailParam = typeof sp.detail === "string" ? sp.detail : undefined;

  let title: string;
  let logoSlug: string | null;
  let editable = false;
  // Provider-specific "you need an API key with these scopes" note (Attio etc.).
  let auxKeyNote: string | null = null;
  let refreshHealth: {
    message: string;
    retryAt: Date | null;
    reconnectHref: string;
    needsReconnect: boolean;
  } | null = null;
  const rows: { label: string; value: ReactNode }[] = [];
  const actions: ReactNode[] = [];

  if (loaded.kind === "secret") {
    const s = loaded.secret;
    title = s.slug;
    logoSlug = null;
    editable = true;
    rows.push(
      { label: "Type", value: "Secret" },
      { label: "Value", value: <code className="text-foreground">••••••••{s.last4}</code> },
      ...(s.description ? [{ label: "Description", value: s.description }] : []),
      { label: "Updated", value: <LocalTime iso={s.updatedAt} /> },
      {
        label: "Used by agents",
        value: (
          <code className="text-foreground">
            tas_tools.secret(&quot;{s.slug}&quot;)
          </code>
        ),
      },
    );
  } else if (loaded.kind === "native") {
    const c = loaded.conn;
    const provider = getMcpProvider(c.type);
    const tools = await listToolsForConnection(
      workspace.id,
      view.userId,
      "native-mcp",
      c.type,
      c.name,
    );
    const isManual = provider?.authMode === "manual";
    editable = isDcrProvider(provider);
    if (editable) auxKeyNote = provider?.auxKeyHint ?? null;
    title = provider?.displayName ?? c.type;
    logoSlug = c.type;
    const reconnect = `/api/connections/native/${c.type}/authorize?workspace=${encodeURIComponent(
      workspace.slug,
    )}&${isManual ? "app" : "name"}=${encodeURIComponent(c.name)}`;
    if (c.refreshErrorMessage) {
      refreshHealth = {
        message: c.refreshErrorMessage,
        retryAt: c.refreshRetryAt,
        reconnectHref: reconnect,
        needsReconnect: c.status !== "active",
      };
    }
    rows.push(
      { label: "Type", value: "Native MCP" },
      { label: "Connection", value: <code className="text-foreground">{c.name}</code> },
      { label: "Status", value: <Badge variant={nativeVariant(c.status)} size="small">{c.status}</Badge> },
      { label: "Auth", value: c.authType === "pat" ? "API key" : "OAuth" },
      // The optional supplementary API key (set via Edit) — only meaningful for
      // editable (DCR) connections, where the aux-key field lives.
      ...(editable
        ? [
            {
              label: "API key",
              value: c.hasApiKey ? (
                <Badge variant="green" size="small">
                  Set
                </Badge>
              ) : (
                <span className="text-foreground-muted">Not set</span>
              ),
            },
          ]
        : []),
      { label: "Connected", value: <LocalTime iso={c.createdAt.toISOString()} /> },
      ...(c.tokenExpiresAt
        ? [{ label: "Token expires", value: <LocalTime iso={c.tokenExpiresAt.toISOString()} /> }]
        : []),
      {
        label: "Tools",
        value: (
          <Link
            href={`/${workspace.slug}/tools?source=native-mcp&provider=${encodeURIComponent(c.type)}&connection=${encodeURIComponent(c.name)}`}
            className="text-foreground underline underline-offset-2"
          >
            {tools.length} cached
          </Link>
        ),
      },
    );
    actions.push(
      <RefreshNativeMcpToolsForm key="refresh" workspaceSlug={workspace.slug} connectionId={c.id} />,
    );
    if (!view.viewingOther) {
      actions.push(
        <Button key="reconnect" asChild variant="secondary">
          <a href={reconnect}>Reconnect</a>
        </Button>,
        <DisconnectNativeMcpConnectionForm key="disconnect" workspaceSlug={workspace.slug} connectionId={c.id} />,
      );
    }
  } else if (loaded.kind === "manual-cred") {
    const { provider, fields } = loaded;
    title = provider.displayName;
    // Same logo CDN as the list view (LinkedIn et al.); glyph fallback on 404.
    logoSlug = provider.slug;
    rows.push({ label: "Type", value: "Manual credential" });
    for (const { field, preview } of fields) {
      rows.push({
        label: field.label,
        value: preview ? (
          <code className="text-foreground">••••••••{preview.last4}</code>
        ) : (
          <span className="text-foreground-muted">Not set</span>
        ),
      });
    }
    if (!view.viewingOther) {
      actions.push(
        <Button key="edit" asChild variant="secondary">
          <Link href={`/${workspace.slug}/connections/new?type=manual&provider=${encodeURIComponent(provider.slug)}`}>
            Edit credentials
          </Link>
        </Button>,
        <DisconnectManualCredentialForm
          key="disconnect"
          workspaceSlug={workspace.slug}
          providerSlug={provider.slug}
        />,
      );
    }
  } else {
    const c = loaded.conn;
    const tools = await listToolsForConnection(
      workspace.id,
      view.userId,
      "composio",
      c.toolkit,
      c.name,
    );
    editable = true;
    title = toolkitLabel(c.toolkit);
    logoSlug = c.toolkit;
    const reconnect = `/api/connections/composio/authorize?workspace=${encodeURIComponent(
      workspace.slug,
    )}&toolkit=${encodeURIComponent(c.toolkit)}&name=${encodeURIComponent(c.name)}`;
    rows.push(
      { label: "Type", value: "Composio" },
      { label: "Connection", value: <code className="text-foreground">{c.name}</code> },
      { label: "Status", value: <Badge variant={c.status.toLowerCase() === "active" ? "green" : "yellow"} size="small">{c.status.toLowerCase()}</Badge> },
      { label: "Updated", value: <LocalTime iso={c.updatedAt.toISOString()} /> },
      {
        label: "Tools",
        value: (
          <Link
            href={`/${workspace.slug}/tools?source=composio&provider=${encodeURIComponent(c.toolkit)}&connection=${encodeURIComponent(c.name)}`}
            className="text-foreground underline underline-offset-2"
          >
            {tools.length} cached
          </Link>
        ),
      },
    );
    actions.push(
      <RefreshComposioToolsForm key="refresh" workspaceSlug={workspace.slug} connectionId={c.id} />,
    );
    if (!view.viewingOther) {
      actions.push(
        <Button key="reconnect" asChild variant="secondary">
          <a href={reconnect}>Reconnect</a>
        </Button>,
        <DisconnectComposioConnectionForm key="disconnect" workspaceSlug={workspace.slug} connectionId={c.id} />,
      );
    }
  }

  // Edit only when the connection has something to edit (rename / rotate) and
  // we're not viewing another member. Placed first so it leads the cluster.
  if (editable && !view.viewingOther) {
    actions.unshift(
      <Button key="edit" asChild variant="secondary">
        <Link href={editHref}>Edit</Link>
      </Button>,
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-col gap-2">
        <BackLink href={`/${workspace.slug}/connections${userQs}`} label="Connections" />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {logoSlug ? (
              <McpProviderLogo slug={logoSlug} label={title} size={24} />
            ) : (
              <span
                className="bg-surface-secondary text-foreground-muted inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-sm"
                aria-hidden
              >
                ⚿
              </span>
            )}
            <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
              {title}
            </h1>
          </div>
          {actions.length > 0 && (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {actions}
            </div>
          )}
        </div>
      </div>

      <hr className="border-[var(--color-border-weak)]" />

      {resultParam === "ok" && (
        <div className="border-sentiment-positive rounded-lg border bg-[var(--color-sentiment-positive-subtle)] px-3 py-2 text-sm">
          <span className="text-foreground">Connected.</span>
        </div>
      )}
      {resultParam === "error" && (
        <div className="border-sentiment-negative rounded-lg border bg-[var(--color-input-error)] px-3 py-2 text-sm">
          <span className="text-foreground">
            Connection failed{detailParam ? `: ${detailParam}` : "."}
          </span>
        </div>
      )}

      {refreshHealth && (
        <div className="border-sentiment-caution rounded-lg border bg-[var(--color-sentiment-caution-subtle)] px-3 py-2.5 text-sm">
          <p className="text-foreground font-medium">
            {refreshHealth.needsReconnect
              ? "This connection needs attention."
              : "Token refresh will retry automatically."}
          </p>
          <p className="text-foreground-weak mt-1 leading-5">
            {refreshHealth.message}
          </p>
          {!refreshHealth.needsReconnect && refreshHealth.retryAt && (
            <p className="text-foreground-muted mt-1">
              Next retry after <LocalTime iso={refreshHealth.retryAt.toISOString()} />.
            </p>
          )}
          {refreshHealth.needsReconnect && !view.viewingOther && (
            <a
              href={refreshHealth.reconnectHref}
              className="text-foreground mt-2 inline-block underline underline-offset-2"
            >
              Reconnect now
            </a>
          )}
        </div>
      )}

      <dl className="grid gap-x-6 gap-y-2.5 text-sm sm:grid-cols-[10rem_1fr]">
        {rows.map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-foreground-muted">{r.label}</dt>
            <dd className="text-foreground-weak flex items-center">{r.value}</dd>
          </div>
        ))}
      </dl>

      {auxKeyNote && (
        <div className="border-sentiment-caution rounded-lg border bg-[var(--color-sentiment-caution-subtle)] px-3 py-2.5 text-sm">
          <p className="text-foreground-weak leading-5">{auxKeyNote}</p>
          {editable && !view.viewingOther && (
            <Link
              href={editHref}
              className="text-foreground mt-1 inline-block underline underline-offset-2"
            >
              Add API key
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function nativeVariant(
  status: "active" | "stale" | "expired" | "revoked",
): StatusVariant {
  return status === "active"
    ? "green"
    : status === "revoked"
      ? "red"
      : "yellow";
}
