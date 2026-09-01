import { notFound } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { toolkitLabel } from "@/lib/composio-label";
import { resolveConnectionsView } from "@/lib/connections-view";
import { getMcpProvider, isDcrProvider } from "@/lib/mcp-providers";
import { getServerSession } from "@/lib/session";
import { getWorkspaceBySlug } from "@/lib/workspace";

import { renameComposioConnectionAction } from "../../../settings/actions";
import { loadConnection, parseConnectionRef } from "../../connection-ref";
import {
  renameNativeMcpConnectionAction,
  setNativeMcpApiKeyAction,
} from "../../native-mcp-actions";
import { ConnectionApiKeyField } from "./connection-api-key-field";
import { ConnectionRenameField } from "./connection-rename-field";
import { SecretEditForm } from "./secret-edit-form";

export const dynamic = "force-dynamic";

export default async function EditConnectionPage({
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
  const loaded = await loadConnection(
    workspace.id,
    view.userId,
    ref,
    view.viewingOther ? undefined : session.user.id,
  );
  if (!loaded) notFound();

  // Native manual / self-key connections have nothing to edit (name is fixed) —
  // the detail view hides their Edit button, so reaching here is a stray URL.
  // DCR providers (incl. the unset default — Attio etc.) are editable.
  if (
    loaded.kind === "native" &&
    !isDcrProvider(getMcpProvider(loaded.conn.type))
  ) {
    notFound();
  }
  // Manual-credential edits are done via the connect form (/connections/new),
  // not this rename/rotate page.
  if (loaded.kind === "manual-cred") notFound();
  if (
    loaded.kind === "secret" &&
    (view.viewingOther ||
      view.role === "viewer" ||
      (loaded.secret.scope === "workspace" && !view.isAdmin))
  ) {
    notFound();
  }

  const userQs = view.viewingOther
    ? `?user=${encodeURIComponent(view.userId)}`
    : "";
  const backHref = `/${workspace.slug}/connections/${id}${userQs}`;

  const title =
    loaded.kind === "secret"
      ? loaded.secret.slug
      : loaded.kind === "native"
        ? (getMcpProvider(loaded.conn.type)?.displayName ?? loaded.conn.type)
        : toolkitLabel(loaded.conn.toolkit);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-col gap-2">
        <BackLink href={backHref} label={title} />
        <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
          Edit {title}
        </h1>
      </div>

      <hr className="border-[var(--color-border-weak)]" />

      {loaded.kind === "secret" ? (
        <SecretEditForm
          workspaceSlug={workspace.slug}
          id={loaded.secret.id}
          slug={loaded.secret.slug}
          description={loaded.secret.description}
        />
      ) : loaded.kind === "composio" ? (
        <ConnectionRenameField
          action={renameComposioConnectionAction}
          workspaceSlug={workspace.slug}
          connectionId={loaded.conn.id}
          currentName={loaded.conn.name}
        />
      ) : (
        <>
          <ConnectionRenameField
            action={renameNativeMcpConnectionAction}
            workspaceSlug={workspace.slug}
            connectionId={loaded.conn.id}
            currentName={loaded.conn.name}
          />
          <hr className="border-[var(--color-border-weak)]" />
          <ConnectionApiKeyField
            action={setNativeMcpApiKeyAction}
            workspaceSlug={workspace.slug}
            connectionId={loaded.conn.id}
            providerLabel={title}
            hint={getMcpProvider(loaded.conn.type)?.auxKeyHint ?? null}
            isSet={loaded.conn.hasApiKey}
          />
        </>
      )}
    </div>
  );
}
