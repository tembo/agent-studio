import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { IconApiConnection } from "central-icons";

import { BackLink } from "@/components/back-link";
import { Markdown } from "@/components/markdown";
import { McpProviderLogo } from "@/components/mcp-provider-logo";
import { Button } from "@/components/ui/button";
import { listAllToolkits, type CatalogToolkit } from "@/lib/composio";
import {
  getManualCredentialProvider,
  listManualCredentialProviders,
} from "@/lib/manual-credential-providers";
import { CATEGORY_META } from "@/lib/connection-categories";
import { listMcpProviders, type McpProvider } from "@/lib/mcp-providers";
import {
  getProviderEnableMap,
  isProviderAdminEnabled,
} from "@/lib/native-mcp-providers-admin";
import { listNativeOAuthClients } from "@/lib/native-oauth-clients";
import { getServerSession } from "@/lib/session";
import {
  getWorkspaceBySlug,
  getWorkspaceRole,
  getWorkspaceSecretPlaintext,
  getWorkspaceSecretPreview,
} from "@/lib/workspace";

import { ConnectNativeMcpAppForm } from "../connect-native-mcp-app-form";
import { ManualCredentialConnectForm } from "../manual-credential-connect-form";
import { ToolkitPicker } from "../toolkit-picker";
import { NewConnectionChooser } from "./new-connection-chooser";
import { NativeConnectForm } from "./native-connect-form";
import { NativeMcpProviderTable } from "./native-mcp-provider-table";
import { NativePatConnectForm } from "./native-pat-connect-form";
import { SecretAddForm } from "./secret-add-form";

export const dynamic = "force-dynamic";

// Add a connection in two steps. The first page picks one of the four
// connection TYPES (Native MCP / Composio / Manual credential / Secret); the
// individual native-MCP providers are nested under "Native MCP" rather than at
// the top level. ?type=<kind> drills into a type, then ?provider=<slug> (native)
// or ?type=manual&provider=<slug> picks the specific provider's form.
export default async function NewConnectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ provider?: string; type?: string; toolkit?: string }>;
}) {
  const { workspace: slug } = await params;
  const {
    provider: providerParam,
    type: typeParam,
    toolkit: toolkitParam,
  } = await searchParams;

  const session = await getServerSession();
  if (!session) notFound();
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();
  const role = await getWorkspaceRole(workspace.id, session.user.id);
  const isAdmin = role === "workspace_admin";

  const [oauthClients, enableMap, composioPreview] = await Promise.all([
    listNativeOAuthClients(workspace.id),
    getProviderEnableMap(workspace.id),
    getWorkspaceSecretPreview(workspace.id, "composio_api_key"),
  ]);
  const instancesByProvider = new Map<
    string,
    { instance: string; label: string | null }[]
  >();
  for (const c of oauthClients) {
    const arr = instancesByProvider.get(c.provider) ?? [];
    arr.push({ instance: c.instance, label: c.label });
    instancesByProvider.set(c.provider, arr);
  }
  const catalog = listMcpProviders();
  const newHref = `/${workspace.slug}/connections/new`;
  const backToTypes = <BackLink href={newHref} label="New connection" />;

  // ── A manual-credential provider's form ─────────────────────────────
  if (typeParam === "manual" && providerParam) {
    const provider = getManualCredentialProvider(providerParam);
    if (!provider) notFound();
    return (
      <FormShell
        back={<BackLink href={`${newHref}?type=manual`} label="Manual credential" />}
        title={`Connect ${provider.displayName}`}
        logo={
          <McpProviderLogo slug={provider.slug} label={provider.displayName} size={24} />
        }
      >
        {isAdmin ? (
          <>
            <div className="text-foreground-weak text-sm [&_a]:underline [&_code]:text-foreground">
              <Markdown>{provider.instructions}</Markdown>
            </div>
            <ManualCredentialConnectForm
              workspaceSlug={workspace.slug}
              provider={provider}
            />
          </>
        ) : (
          <p className="text-foreground-muted text-sm">
            Only workspace admins can add credentials.
          </p>
        )}
      </FormShell>
    );
  }

  // ── A specific native-MCP provider's form ───────────────────────────
  if (providerParam) {
    const provider = catalog.find((p) => p.slug === providerParam);
    if (!provider || !isProviderAdminEnabled(provider, enableMap)) notFound();
    const instances = instancesByProvider.get(provider.slug) ?? [];
    return (
      <FormShell
        back={<BackLink href={`${newHref}?type=native`} label="Native MCP" />}
        title={`Connect ${provider.displayName}`}
        logo={
          <McpProviderLogo slug={provider.slug} label={provider.displayName} size={24} />
        }
      >
        {provider.authMode === "manual" ? (
          instances.length > 0 ? (
            <ConnectNativeMcpAppForm
              workspaceSlug={workspace.slug}
              providerSlug={provider.slug}
              instances={instances}
            />
          ) : isAdmin ? (
            <p className="text-foreground-weak text-sm">
              {provider.displayName} needs an OAuth app first.{" "}
              <Link
                href={`/${workspace.slug}/connections/providers`}
                className="text-foreground underline underline-offset-2"
              >
                Configure it on Manage providers →
              </Link>
            </p>
          ) : (
            <p className="text-foreground-muted text-sm">
              {provider.displayName} needs an admin to set up its OAuth app first.
            </p>
          )
        ) : provider.authMode === "pat" ? (
          <NativePatConnectForm
            workspaceSlug={workspace.slug}
            providerSlug={provider.slug}
            displayName={provider.displayName}
            patHint={provider.patHint}
          />
        ) : (
          <NativeConnectForm
            workspaceSlug={workspace.slug}
            providerSlug={provider.slug}
            selfKey={provider.authMode === "self-key"}
            instanceUrlLabel={
              provider.instanceUrlTemplate
                ? (provider.instanceUrlLabel ?? "Instance URL")
                : undefined
            }
          />
        )}
      </FormShell>
    );
  }

  // ── Native MCP: list the providers ──────────────────────────────────
  // Full table view (same chrome as /connections) — not a card grid. Search,
  // auth filter, and sortable columns live in NativeMcpProviderTable.
  if (typeParam === "native") {
    const providerRows = catalog
      .filter((p) => isProviderAdminEnabled(p, enableMap))
      .map((p) => ({
        slug: p.slug,
        displayName: p.displayName,
        authLabel: authModeLabel(p),
        categoryLabel: categoryLabelForSlug(p.slug),
        href: `${newHref}?provider=${encodeURIComponent(p.slug)}`,
      }));
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-8">
        <div className="flex flex-col gap-2">
          <BackLink href={newHref} label="New connection" />
          <div className="flex items-center gap-2.5">
            <IconApiConnection
              size={24}
              className="text-foreground-muted shrink-0"
            />
            <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
              Native MCP
            </h1>
          </div>
          <p className="text-foreground-weak text-sm">
            Official provider MCP servers — OAuth, API token, or built-in.
            Connections are yours (per-user). Click a row to connect.
          </p>
        </div>
        <NativeMcpProviderTable rows={providerRows} />
      </div>
    );
  }

  // ── Manual credential: list the providers ───────────────────────────
  if (typeParam === "manual") {
    return (
      <FormShell back={backToTypes} title="Manual credential" logo={<Glyph />}>
        <p className="text-foreground-weak text-sm">
          Services with no OAuth — connect by pasting a few values with setup
          instructions. Stored as workspace secrets.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {listManualCredentialProviders().map((p) => (
            <OptionCard
              key={p.slug}
              href={`${newHref}?type=manual&provider=${encodeURIComponent(p.slug)}`}
              logo={<McpProviderLogo slug={p.slug} label={p.displayName} size={24} />}
              title={p.displayName}
              sublabel={`${p.fields.length} field${p.fields.length === 1 ? "" : "s"}`}
            />
          ))}
        </div>
      </FormShell>
    );
  }

  // ── Composio ────────────────────────────────────────────────────────
  if (typeParam === "composio") {
    const toolkitCatalog: CatalogToolkit[] = composioPreview
      ? await getWorkspaceSecretPlaintext(workspace.id, "composio_api_key")
          .then((k) => listAllToolkits(k))
          .catch(() => [])
      : [];
    // Prefill from ?toolkit= (landing search deep-link).
    const prefillToolkit =
      typeof toolkitParam === "string" &&
      /^[a-z0-9_-]+$/i.test(toolkitParam.trim())
        ? toolkitParam.trim().toLowerCase()
        : "";
    return (
      <FormShell
        back={backToTypes}
        title="Connect a Composio toolkit"
        logo={<IconApiConnection size={24} className="text-foreground-muted" />}
      >
        {composioPreview ? (
          <form
            method="get"
            action="/api/connections/composio/authorize"
            className="flex flex-col gap-4"
          >
            <input type="hidden" name="workspace" value={workspace.slug} />
            <div className="grid gap-1.5">
              <label className="text-foreground-weak text-sm font-medium">Toolkit</label>
              <ToolkitPicker
                fieldName="toolkit"
                catalog={toolkitCatalog}
                defaultValue={prefillToolkit}
              />
            </div>
            <div className="grid gap-1.5">
              <label htmlFor="composio-name" className="text-foreground-weak text-sm font-medium">
                Connection name
              </label>
              <input
                id="composio-name"
                name="name"
                type="text"
                defaultValue="default"
                pattern="[a-z0-9_-]+"
                autoComplete="off"
                spellCheck={false}
                className="bg-input border-border text-foreground rounded-md border px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring-color,#009eff)]"
              />
            </div>
            <div>
              <Button type="submit" variant="primary">
                Connect →
              </Button>
            </div>
          </form>
        ) : (
          <p className="text-foreground-muted text-sm">
            Composio needs a workspace API key.{" "}
            <Link
              href={`/${workspace.slug}/settings/composio`}
              className="text-foreground underline underline-offset-2"
            >
              Set it in Settings →
            </Link>
          </p>
        )}
      </FormShell>
    );
  }

  // ── Secret ──────────────────────────────────────────────────────────
  if (typeParam === "secret") {
    return (
      <FormShell back={backToTypes} title="Add a secret" logo={<Glyph />}>
        {role === "operator" || isAdmin ? (
          <SecretAddForm workspaceSlug={workspace.slug} isAdmin={isAdmin} />
        ) : (
          <p className="text-foreground-muted text-sm">
            Operators and workspace admins can add secrets.
          </p>
        )}
      </FormShell>
    );
  }

  if (typeParam || providerParam) notFound();

  // ── Landing: search any provider, or pick a connection type ─────────
  // Pull Composio toolkits when a workspace key is set so search spans
  // Native MCP + Manual + Composio (~300 toolkits; cached 1h in-process).
  const composioToolkits: CatalogToolkit[] = composioPreview
    ? await getWorkspaceSecretPlaintext(workspace.id, "composio_api_key")
        .then((k) => listAllToolkits(k))
        .catch(() => [])
    : [];

  const searchable = [
    ...catalog
      .filter((p) => isProviderAdminEnabled(p, enableMap))
      .map((p) => ({
        slug: p.slug,
        displayName: p.displayName,
        authLabel: authModeLabel(p),
        categoryLabel: categoryLabelForSlug(p.slug),
        kind: "native" as const,
        href: `${newHref}?provider=${encodeURIComponent(p.slug)}`,
      })),
    ...(isAdmin
      ? listManualCredentialProviders().map((p) => ({
          slug: p.slug,
          displayName: p.displayName,
          authLabel: "Paste credentials",
          categoryLabel: "",
          kind: "manual" as const,
          href: `${newHref}?type=manual&provider=${encodeURIComponent(p.slug)}`,
        }))
      : []),
    ...composioToolkits.map((t) => ({
      slug: t.slug,
      displayName: t.name,
      authLabel: "Composio OAuth",
      categoryLabel: "",
      kind: "composio" as const,
      // Prefills the Composio toolkit picker; user confirms connection name.
      href: `${newHref}?type=composio&toolkit=${encodeURIComponent(t.slug)}`,
    })),
  ];

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-col gap-2">
        <BackLink href={`/${workspace.slug}/connections`} label="Connections" />
        <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
          New connection
        </h1>
        <p className="text-foreground-weak text-base">
          Search Native MCP, Composio, and manual credentials — or pick a type.
        </p>
      </div>

      <hr className="border-[var(--color-border-weak)]" />

      <NewConnectionChooser
        workspaceSlug={workspace.slug}
        providers={searchable}
        showManual={isAdmin}
        showSecret={role === "operator" || isAdmin}
      />
    </div>
  );
}

function authModeLabel(p: McpProvider): string {
  if (p.authMode === "manual") return "OAuth · your app";
  if (p.authMode === "self-key") return "Built-in";
  if (p.authMode === "pat") return "API token";
  return "OAuth";
}

/** First matching Agent Library category for a native-MCP slug, if any. */
function categoryLabelForSlug(slug: string): string {
  const s = slug.toLowerCase();
  for (const meta of Object.values(CATEGORY_META)) {
    if (meta.slugs.some((x) => x.toLowerCase() === s)) return meta.label;
  }
  return "";
}

function OptionCard({
  href,
  logo,
  title,
  sublabel,
}: {
  href: string;
  logo: ReactNode;
  title: string;
  sublabel: string;
}) {
  return (
    <Link
      href={href}
      className="border-border bg-surface hover:bg-surface-secondary group flex items-center gap-3 rounded-lg border px-4 py-3 transition-colors"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center">{logo}</span>
      <span className="flex min-w-0 flex-col">
        <span className="text-foreground group-hover:underline font-medium">{title}</span>
        <span className="text-foreground-muted truncate text-sm">{sublabel}</span>
      </span>
    </Link>
  );
}

function FormShell({
  back,
  title,
  logo,
  children,
}: {
  back: ReactNode;
  title: string;
  logo: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-col gap-2">
        {back}
        <div className="flex items-center gap-2.5">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center">{logo}</span>
          <h1 className="text-foreground-title text-2xl font-bold tracking-tight">{title}</h1>
        </div>
      </div>
      <hr className="border-[var(--color-border-weak)]" />
      {children}
    </div>
  );
}

function Glyph() {
  return (
    <span
      className="bg-surface-secondary text-foreground-muted inline-flex h-6 w-6 items-center justify-center rounded text-sm"
      aria-hidden
    >
      ⚿
    </span>
  );
}
