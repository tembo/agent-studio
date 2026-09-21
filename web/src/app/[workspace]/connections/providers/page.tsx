import { notFound } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { Section } from "@/components/section";
import { Badge } from "@/components/ui/badge";
import { listMcpProviders, redirectUriFor } from "@/lib/mcp-providers";
import {
  getProviderEnableMap,
  isProviderAdminEnabled,
} from "@/lib/native-mcp-providers-admin";
import {
  listNativeOAuthClients,
  type NativeOAuthClientPreview,
} from "@/lib/native-oauth-clients";
import { getServerSession } from "@/lib/session";
import { getWorkspaceBySlug, getWorkspaceRole } from "@/lib/workspace";

import {
  AddNativeOAuthAppInstanceForm,
  CopyableField,
  NativeOAuthAppInstanceCard,
  ProviderEnableToggle,
} from "../native-mcp-admin-forms";

// Where to create the OAuth app, per manual provider.
const SETUP_URLS: Record<string, string> = {
  hubspot:
    "https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server",
  gmail:
    "https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server",
  zoom: "https://developers.zoom.us/docs/guides/tools-and-extensions/mcp/",
  slack: "https://docs.slack.dev/ai/slack-mcp-server",
  gong: "https://mcp.gong.io",
  zoominfo: "https://docs.zoominfo.com/docs/standard-app",
};

// Extra provider-specific setup beyond "create an app + register the redirect
// URI" — rendered inline so the steps that are easy to miss are in-app.
const SETUP_NOTES: Record<string, string> = {
  gmail:
    "In Google Cloud also enable the Gmail API and the Gmail MCP API, set the OAuth consent screen to Internal with the scope https://mail.google.com/ (full Gmail — the MCP tools require it), and choose Web application as the client type.",
  zoom:
    "Create a Zoom OAuth app (General app / user-managed), register the redirect URI shown on this card, and enable the MCP scopes you need (meetings, recordings, Docs, …). Zoom uses client_secret_basic — paste the Client ID and Client Secret from the app credentials page.",
  zoominfo:
    "Create a Standard App (Authorization Code + PKCE) in the ZoomInfo Developer Portal or GTM.ai Developer tab. Register the redirect URI, enable MCP scopes (zi_mcp, api:data:mcp), then paste the Client ID and Client Secret. ZoomInfo's public DCR is limited to approved partner vendors, so TAS cannot self-register.",
};

export const dynamic = "force-dynamic";

// Admin-only: decide which native-MCP providers members can connect, and
// register the bring-your-own OAuth apps that confidential providers (HubSpot)
// need. Reached from the Connections list's "Manage providers" button.
export default async function ManageProvidersPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;

  const session = await getServerSession();
  if (!session) notFound();
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();
  const role = await getWorkspaceRole(workspace.id, session.user.id);
  if (role !== "workspace_admin") notFound();

  const [enableMap, oauthClients] = await Promise.all([
    getProviderEnableMap(workspace.id),
    listNativeOAuthClients(workspace.id),
  ]);

  const catalog = listMcpProviders();
  const dcrProviders = catalog.filter((p) => p.authMode !== "manual");
  const manualProviders = catalog.filter((p) => p.authMode === "manual");

  const instancesByProvider = new Map<string, NativeOAuthClientPreview[]>();
  for (const c of oauthClients) {
    const arr = instancesByProvider.get(c.provider) ?? [];
    arr.push(c);
    instancesByProvider.set(c.provider, arr);
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-col gap-2">
        <BackLink href={`/${workspace.slug}/connections`} label="Connections" />
        <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
          Manage providers
        </h1>
        <p className="text-foreground-weak text-base">
          Choose which native-MCP providers members can connect, and configure
          the OAuth apps that confidential providers require.
        </p>
      </div>

      <hr className="border-[var(--color-border-weak)]" />

      <Section
        title="Simple MCPs"
        description="Zero-config providers — TAS-managed OAuth, built-in, or paste-a-token. Toggle which ones members can connect."
      >
        <ul className="divide-border bg-surface border-border flex flex-col divide-y overflow-hidden rounded-lg border">
          {dcrProviders.map((p) => (
            <li
              key={p.slug}
              className="flex flex-wrap items-center justify-between gap-3 px-3 py-3"
            >
              <span className="text-foreground text-sm font-medium">
                {p.displayName}
              </span>
              <ProviderEnableToggle
                workspaceSlug={workspace.slug}
                providerSlug={p.slug}
                enabled={isProviderAdminEnabled(p, enableMap)}
              />
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="Custom-OAuth MCPs"
        description="Providers that need your own OAuth app. Register one or more app instances; members pick which to connect."
      >
        <div className="flex flex-col gap-4">
          {manualProviders.map((p) => {
            const instances = instancesByProvider.get(p.slug) ?? [];
            const enabled = isProviderAdminEnabled(p, enableMap);
            const setupUrl = SETUP_URLS[p.slug];
            const setupNote = SETUP_NOTES[p.slug];
            return (
              <div
                key={p.slug}
                className="border-border bg-surface flex flex-col gap-3 rounded-lg border p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-foreground text-sm font-medium">
                      {p.displayName}
                    </span>
                    {instances.length === 0 && (
                      <Badge variant="gray" size="small">
                        No apps yet
                      </Badge>
                    )}
                  </div>
                  <ProviderEnableToggle
                    workspaceSlug={workspace.slug}
                    providerSlug={p.slug}
                    enabled={enabled}
                    note={
                      enabled && instances.length === 0
                        ? "add an app below to make it usable"
                        : undefined
                    }
                  />
                </div>

                <p className="text-foreground-weak text-sm leading-5">
                  {p.displayName} doesn&apos;t support auto-registration. Create
                  an OAuth app at {p.displayName}
                  {setupUrl ? (
                    <>
                      {" ("}
                      <a
                        href={setupUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-foreground hover:underline"
                      >
                        guide →
                      </a>
                      {")"}
                    </>
                  ) : null}
                  , register this redirect URI on it, then add its credentials
                  below. Add more than one app to give members separate accounts.
                </p>

                {setupNote && (
                  <p className="text-foreground-weak border-border-weak bg-surface-secondary rounded-md border px-3 py-2 text-xs leading-5">
                    {setupNote}
                  </p>
                )}

                <CopyableField
                  label="Redirect URI to register"
                  value={redirectUriFor(p.slug)}
                />

                {instances.length > 0 && (
                  <div className="flex flex-col gap-2">
                    {instances.map((inst) => (
                      <NativeOAuthAppInstanceCard
                        key={inst.instance}
                        workspaceSlug={workspace.slug}
                        providerSlug={p.slug}
                        providerDisplayName={p.displayName}
                        instance={inst.instance}
                        label={inst.label}
                        clientId={inst.clientId}
                        secretLast4={inst.secretLast4}
                      />
                    ))}
                  </div>
                )}

                <div>
                  <AddNativeOAuthAppInstanceForm
                    workspaceSlug={workspace.slug}
                    providerSlug={p.slug}
                    providerDisplayName={p.displayName}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </Section>
    </div>
  );
}
