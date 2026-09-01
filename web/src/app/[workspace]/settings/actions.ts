"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { writeAuditEvent } from "@/lib/audit-db";
import {
  authorizeWorkspace as authorizeWorkspaceShared,
  DENIED_MESSAGE,
} from "@/lib/auth-server";
import { deleteRemoteConnection } from "@/lib/composio";
import {
  deleteComposioConnection,
  getComposioConnectionById,
  renameComposioConnection,
} from "@/lib/composio-connections";
import { fetchComposioToolkitTools } from "@/lib/composio-tools";
import {
  deleteToolsForConnection,
  replaceToolsForConnection,
} from "@/lib/mcp-tools";
import { type WorkspaceRole } from "@/lib/rbac";
import {
  restoreAgent,
  type RestoreAgentError,
} from "@/lib/workspace-agents";
import {
  DEFAULT_FAVICON_KINDS,
  deleteWorkspace,
  disconnectWorkspaceRepo,
  getWorkspaceSecretPlaintext,
  getWorkspaceSecretPreview,
  removeWorkspaceSecret,
  renameWorkspace,
  setFaviconCustom,
  setFaviconDefault,
  setWorkspaceCommitMode,
  setWorkspaceSecret,
  type FaviconKind,
  type RenameWorkspaceError,
  type SetFaviconError,
  type SetWorkspaceSecretError,
  type WorkspaceSecretKind,
} from "@/lib/workspace";
import {
  COMMIT_MODE_LABELS,
  isCommitMode,
} from "@/lib/commit-mode-constants";

// Keep the union narrow — only kinds the settings UI lets you manage
// land here. The repo-connect flow writes github_pat; the runtime stores
// keys through this surface only.
type SettingsKind = Extract<
  WorkspaceSecretKind,
  | "tembo_api_key"
  | "anthropic_api_key"
  | "openai_api_key"
  | "scaledown_api_key"
  | "composio_api_key"
  | "composio_webhook_secret"
>;

const SETTINGS_KIND_LABELS: Record<SettingsKind, string> = {
  tembo_api_key: "Tembo API key",
  anthropic_api_key: "Anthropic API key",
  openai_api_key: "OpenAI API key",
  scaledown_api_key: "ScaleDown API key",
  composio_api_key: "Composio API key",
  composio_webhook_secret: "Composio webhook secret",
};

function isSettingsKind(v: string): v is SettingsKind {
  return (
    v === "tembo_api_key" ||
    v === "anthropic_api_key" ||
    v === "openai_api_key" ||
    v === "scaledown_api_key" ||
    v === "composio_api_key" ||
    v === "composio_webhook_secret"
  );
}

export type SecretFormState = {
  message?: string;
  error?: string;
};

function saveErrorMessage(
  kind: SettingsKind,
  err: SetWorkspaceSecretError,
): string {
  const label = SETTINGS_KIND_LABELS[kind];
  switch (err) {
    case "empty":
      return `Please paste your ${label}.`;
    case "too-short":
      return `That key looks too short to be a ${label}.`;
    case "too-long":
      return `That key is longer than we expected. Double-check what you pasted.`;
    case "bad-prefix":
      return `That doesn't look like a ${label} — check that you copied the whole key from the provider's developer console.`;
  }
}

// Authorize for a settings mutation. Default minRole is
// workspace_admin — every operation in this file touches workspace
// configuration. Operator-tier surfaces (own-connection rename /
// disconnect, agent restore) override at the call site.
//
// Returns the workspace + actor on success. On no-session /
// no-workspace we 404 (don't leak existence). On denial the caller
// surfaces DENIED_MESSAGE in its form state — never silent.
async function authorizeWorkspace(
  slug: string,
  minRole: WorkspaceRole = "workspace_admin",
) {
  const auth = await authorizeWorkspaceShared(slug, minRole);
  if (!auth.ok) {
    if (auth.reason === "denied") return { denied: true as const };
    notFound();
  }
  return {
    denied: false as const,
    workspace: auth.workspace,
    userId: auth.userId,
    role: auth.role,
  };
}

export async function saveSecretAction(
  _prev: SecretFormState,
  formData: FormData,
): Promise<SecretFormState> {
  const slug = String(formData.get("workspace") ?? "");
  const kindRaw = String(formData.get("kind") ?? "");
  const apiKey = String(formData.get("apiKey") ?? "");

  if (!isSettingsKind(kindRaw)) {
    return { error: "Unsupported secret kind." };
  }
  const kind: SettingsKind = kindRaw;

  const auth = await authorizeWorkspace(slug, "workspace_admin");
  if (auth.denied) return { error: DENIED_MESSAGE };
  const { workspace, userId } = auth;
  const existing = await getWorkspaceSecretPreview(workspace.id, kind);
  const result = await setWorkspaceSecret(workspace.id, kind, apiKey);
  if (!result.ok) {
    return { error: saveErrorMessage(kind, result.error) };
  }

  await writeAuditEvent({
    workspaceId: workspace.id,
    actorUserId: userId,
    source: "human_action",
    kind: existing ? "secret.rotated" : "secret.set",
    targetType: "secret",
    targetId: kind,
    agentName: null,
    payload: { secretKind: kind },
  });

  revalidatePath(`/${slug}/settings`);
  // Layout-level so the sidebar's "Action needed" LLM-key CTA toggles
  // without a manual refresh — it lives in the workspace layout, which
  // a page-only revalidate wouldn't re-render.
  revalidatePath(`/${slug}`, "layout");
  return { message: `${SETTINGS_KIND_LABELS[kind]} saved.` };
}

export async function removeSecretAction(
  _prev: SecretFormState,
  formData: FormData,
): Promise<SecretFormState> {
  const slug = String(formData.get("workspace") ?? "");
  const kindRaw = String(formData.get("kind") ?? "");

  if (!isSettingsKind(kindRaw)) {
    return { error: "Unsupported secret kind." };
  }
  const kind: SettingsKind = kindRaw;

  const auth = await authorizeWorkspace(slug, "workspace_admin");
  if (auth.denied) return { error: DENIED_MESSAGE };
  const { workspace, userId } = auth;
  await removeWorkspaceSecret(workspace.id, kind);

  await writeAuditEvent({
    workspaceId: workspace.id,
    actorUserId: userId,
    source: "human_action",
    kind: "secret.removed",
    targetType: "secret",
    targetId: kind,
    agentName: null,
    payload: { secretKind: kind },
  });

  revalidatePath(`/${slug}/settings`);
  // Layout-level so the sidebar's "Action needed" LLM-key CTA appears
  // immediately after the last provider key is removed.
  revalidatePath(`/${slug}`, "layout");
  return { message: `${SETTINGS_KIND_LABELS[kind]} removed.` };
}

export type DisconnectRepoFormState = {
  message?: string;
};

export type RestoreAgentFormState = {
  message?: string;
  error?: string;
};

const RESTORE_ERROR_MESSAGES: Record<RestoreAgentError, string> = {
  "no-repo": "Connect a Git repository before restoring an agent.",
  "not-found": "That deletion record no longer exists.",
  "already-restored": "Already restored.",
  "invalid-token":
    "The workspace's stored GitHub token is no longer valid. Reconnect the repo in Settings.",
  "path-exists":
    "An agent with the same filename exists. Delete or rename the live one first.",
  "branch-protected":
    "The default branch is protected. Ask an admin to relax protections or use v0.2's chat-to-PR flow.",
  "rate-limited":
    "GitHub rate-limited that request. Try again in a few minutes.",
  network: "Couldn't reach GitHub. Try again in a moment.",
};

export async function restoreAgentAction(
  _prev: RestoreAgentFormState,
  formData: FormData,
): Promise<RestoreAgentFormState> {
  const slug = String(formData.get("workspace") ?? "");
  const deletionId = String(formData.get("deletionId") ?? "");

  const auth = await authorizeWorkspace(slug, "operator");
  if (auth.denied) return { error: DENIED_MESSAGE };
  const { workspace, userId } = auth;
  const result = await restoreAgent(workspace.id, userId, deletionId);
  if (!result.ok) {
    return { error: RESTORE_ERROR_MESSAGES[result.error] };
  }
  await writeAuditEvent({
    workspaceId: workspace.id,
    actorUserId: userId,
    source: "human_action",
    kind: "agent.restored",
    targetType: "agent",
    targetId: result.agentName,
    agentName: result.agentName,
    payload: { deletionId },
  });
  revalidatePath(`/${slug}/settings`);
  revalidatePath(`/${slug}`);
  return { message: `Restored ${result.agentName}.` };
}

export type FaviconFormState = {
  message?: string;
  error?: string;
};

const FAVICON_ERROR_MESSAGES: Record<SetFaviconError, string> = {
  "no-workspace": "Workspace not found.",
  empty: "Pick a file to upload.",
  "too-large":
    "Favicons must be 200 KB or smaller. Compress the image and try again.",
  "unsupported-mime":
    "Use PNG, SVG, or ICO. Other formats aren't supported for favicons.",
};

function isDefaultFaviconKind(
  v: string,
): v is Exclude<FaviconKind, "custom"> {
  return (DEFAULT_FAVICON_KINDS as readonly string[]).includes(v);
}

export async function setFaviconDefaultAction(
  _prev: FaviconFormState,
  formData: FormData,
): Promise<FaviconFormState> {
  const slug = String(formData.get("workspace") ?? "");
  const kindRaw = String(formData.get("kind") ?? "");
  if (!isDefaultFaviconKind(kindRaw)) {
    return { error: "Unknown favicon kind." };
  }

  const auth = await authorizeWorkspace(slug, "workspace_admin");
  if (auth.denied) return { error: DENIED_MESSAGE };
  const { workspace } = auth;
  const result = await setFaviconDefault(workspace.id, kindRaw);
  if (!result.ok) {
    return { error: FAVICON_ERROR_MESSAGES[result.error] };
  }
  revalidatePath(`/${slug}/settings`);
  revalidatePath(`/${slug}`);
  return { message: "Favicon updated." };
}

export async function uploadFaviconAction(
  _prev: FaviconFormState,
  formData: FormData,
): Promise<FaviconFormState> {
  const slug = String(formData.get("workspace") ?? "");
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: FAVICON_ERROR_MESSAGES.empty };
  }

  const auth = await authorizeWorkspace(slug, "workspace_admin");
  if (auth.denied) return { error: DENIED_MESSAGE };
  const { workspace } = auth;
  const buffer = Buffer.from(await file.arrayBuffer());
  const result = await setFaviconCustom(workspace.id, {
    bytes: buffer,
    mime: file.type || "application/octet-stream",
  });
  if (!result.ok) {
    return { error: FAVICON_ERROR_MESSAGES[result.error] };
  }
  revalidatePath(`/${slug}/settings`);
  revalidatePath(`/${slug}`);
  return { message: "Custom favicon uploaded." };
}

export async function disconnectRepoAction(
  _prev: DisconnectRepoFormState,
  formData: FormData,
): Promise<DisconnectRepoFormState & { error?: string }> {
  const slug = String(formData.get("workspace") ?? "");
  const auth = await authorizeWorkspace(slug, "workspace_admin");
  if (auth.denied) return { message: undefined, error: DENIED_MESSAGE };
  const { workspace, userId } = auth;
  await disconnectWorkspaceRepo(workspace.id);

  await writeAuditEvent({
    workspaceId: workspace.id,
    actorUserId: userId,
    source: "human_action",
    kind: "repo.disconnected",
    targetType: "workspace",
    targetId: null,
    agentName: null,
    payload: {},
  });

  revalidatePath(`/${slug}/settings`);
  revalidatePath(`/${slug}`);
  return { message: "Repository disconnected." };
}

export type DisconnectComposioConnectionFormState = {
  message?: string;
  error?: string;
};

/**
 * Disconnect a Composio-managed connection. We try to revoke it
 * on Composio's side first, then drop the local cache row. If the
 * remote revoke fails (key removed, Composio down, etc.) we still
 * drop the local row — a stale orphan in Composio is harmless; the
 * user expects the in-app state to reflect what they just clicked.
 */
export async function disconnectComposioConnectionAction(
  _prev: DisconnectComposioConnectionFormState,
  formData: FormData,
): Promise<DisconnectComposioConnectionFormState> {
  const slug = String(formData.get("workspace") ?? "");
  const connectionId = String(formData.get("connectionId") ?? "");
  if (!connectionId) {
    return { error: "Missing connection id." };
  }

  const auth = await authorizeWorkspace(slug, "operator");
  if (auth.denied) return { error: DENIED_MESSAGE };
  const { workspace, userId } = auth;
  const row = await getComposioConnectionById(workspace.id, connectionId);
  if (!row) {
    return { error: "Connection not found." };
  }

  // Best-effort remote revoke. Needs the workspace's Composio key;
  // if the workspace already removed it we skip the remote step and
  // just clean up locally.
  const preview = await getWorkspaceSecretPreview(workspace.id, "composio_api_key");
  if (preview) {
    const apiKey = await getWorkspaceSecretPlaintext(
      workspace.id,
      "composio_api_key",
    );
    await deleteRemoteConnection({
      apiKey,
      connectedAccountId: row.composioConnectionId,
    });
  }
  await deleteComposioConnection(workspace.id, connectionId);

  // Drop the cached tool catalog for this slot too — a future
  // reconnect under the same (toolkit, name) starts fresh.
  await deleteToolsForConnection({
    workspaceId: workspace.id,
    userId: row.userId,
    source: "composio",
    provider: row.toolkit,
    connectionName: row.name,
  });

  await writeAuditEvent({
    workspaceId: workspace.id,
    actorUserId: userId,
    source: "human_action",
    kind: "connection.disconnected",
    targetType: "connection",
    targetId: connectionId,
    agentName: null,
    payload: { toolkit: row.toolkit, name: row.name },
  });

  revalidatePath(`/${slug}/settings`);
  revalidatePath(`/${slug}/connections`, "layout");
  // The detail page this was triggered from no longer resolves — go to the list.
  redirect(`/${slug}/connections`);
}

export type RefreshComposioToolsFormState = {
  message?: string;
  error?: string;
};

const REFRESH_COMPOSIO_TOOLS_EMPTY: RefreshComposioToolsFormState = {};

/**
 * Re-fetch Composio's curated tool list for a connection and
 * replace the cached rows. Owner of the connection (operator+) can
 * refresh their own; workspace_admin can refresh anyone's. Mirrors
 * the native-MCP refresh action.
 */
export async function refreshComposioToolsAction(
  _prev: RefreshComposioToolsFormState,
  formData: FormData,
): Promise<RefreshComposioToolsFormState> {
  const slug = String(formData.get("workspace") ?? "");
  const connectionId = String(formData.get("connectionId") ?? "");
  if (!connectionId) return { error: "Missing connection id." };

  const auth = await authorizeWorkspace(slug, "operator");
  if (auth.denied) return { error: DENIED_MESSAGE };
  const { workspace, userId, role } = auth;

  const row = await getComposioConnectionById(workspace.id, connectionId);
  if (!row) return { error: "Connection not found." };
  if (role !== "workspace_admin" && row.userId !== userId) {
    return { error: DENIED_MESSAGE };
  }

  const preview = await getWorkspaceSecretPreview(workspace.id, "composio_api_key");
  if (!preview) {
    return {
      error: "Set the workspace Composio API key in Settings first.",
    };
  }
  const apiKey = await getWorkspaceSecretPlaintext(
    workspace.id,
    "composio_api_key",
  );

  try {
    const tools = await fetchComposioToolkitTools(apiKey, row.toolkit);
    await replaceToolsForConnection({
      workspaceId: workspace.id,
      userId: row.userId,
      source: "composio",
      provider: row.toolkit,
      connectionName: row.name,
      tools: tools.map((t) => ({
        slug: t.slug,
        displayName: t.name,
        description: t.description,
      })),
    });
  } catch (e) {
    return { error: `Refresh failed: ${(e as Error).message.slice(0, 160)}` };
  }

  revalidatePath(`/${slug}/connections`, "layout");
  return { message: "Tools refreshed." };
}

export type RenameComposioConnectionFormState = {
  message?: string;
  error?: string;
};

/**
 * Rename a Composio connection slot. Updates only TAS's local
 * `name` column; Composio doesn't know about it. The caller is
 * responsible for telling the user that agent specs referencing
 * the old name need updating in lockstep.
 */
export async function renameComposioConnectionAction(
  _prev: RenameComposioConnectionFormState,
  formData: FormData,
): Promise<RenameComposioConnectionFormState> {
  const slug = String(formData.get("workspace") ?? "");
  const connectionId = String(formData.get("connectionId") ?? "");
  const newName = String(formData.get("newName") ?? "");
  if (!connectionId) return { error: "Missing connection id." };

  const auth = await authorizeWorkspace(slug, "operator");
  if (auth.denied) return { error: DENIED_MESSAGE };
  const { workspace, userId, role } = auth;
  const existing = await getComposioConnectionById(workspace.id, connectionId);
  if (!existing) return { error: "Connection not found." };
  // Operators may only rename their own connections; workspace admins
  // may rename any member's (matches the native-MCP rename gate).
  if (role !== "workspace_admin" && existing.userId !== userId) {
    return { error: DENIED_MESSAGE };
  }
  const result = await renameComposioConnection(
    workspace.id,
    connectionId,
    newName,
  );
  if (!result.ok) {
    switch (result.error) {
      case "bad-name-shape":
        return {
          error:
            "Use lowercase letters, digits, hyphens, or underscores only (e.g. work, customer-support).",
        };
      case "name-taken":
        return {
          error:
            "You already have a connection of this toolkit with that name — pick a different one.",
        };
      case "not-found":
        return { error: "Connection not found." };
    }
  }

  await writeAuditEvent({
    workspaceId: workspace.id,
    actorUserId: userId,
    source: "human_action",
    kind: "connection.renamed",
    targetType: "connection",
    targetId: connectionId,
    agentName: null,
    payload: {
      toolkit: existing?.toolkit ?? null,
      oldName: existing?.name ?? null,
      newName: newName.trim().toLowerCase(),
    },
  });

  revalidatePath(`/${slug}/settings`);
  revalidatePath(`/${slug}/connections`, "layout");
  return { message: "Renamed." };
}

// ─────────────────────────────────────────────────────────────────────
// General — rename workspace

export type RenameWorkspaceState = {
  message?: string;
  error?: string;
};

const RENAME_ERROR_MESSAGES: Record<RenameWorkspaceError, string> = {
  "name-required": "Enter a workspace name.",
  "slug-too-short":
    "That name produces too short a URL — use at least two letters or numbers.",
  "slug-too-long": "That name produces too long a URL (max 32 characters).",
  "slug-invalid-chars":
    "That name doesn't produce a usable URL — include some letters or numbers.",
  "slug-reserved": "That name maps to a reserved URL. Pick a different name.",
  "slug-taken": "Another workspace already uses that URL. Pick a different name.",
};

/**
 * Rename a workspace (workspace-admin only). The URL slug is re-derived from
 * the new name; if it changes, the old slug is kept as a redirect and we
 * redirect to the new settings URL. If only the display name changed, we stay
 * put and revalidate.
 */
export async function renameWorkspaceAction(
  _prev: RenameWorkspaceState,
  formData: FormData,
): Promise<RenameWorkspaceState> {
  const slug = String(formData.get("workspace") ?? "");
  const name = String(formData.get("name") ?? "");

  const auth = await authorizeWorkspace(slug, "workspace_admin");
  if (auth.denied) return { error: DENIED_MESSAGE };
  const { workspace, userId } = auth;

  if (name.trim() === workspace.name) {
    return { message: "No changes — that's already the name." };
  }

  const result = await renameWorkspace(workspace.id, workspace.slug, name);
  if (!result.ok) return { error: RENAME_ERROR_MESSAGES[result.error] };

  await writeAuditEvent({
    workspaceId: workspace.id,
    actorUserId: userId,
    source: "human_action",
    kind: "workspace.renamed",
    targetType: "workspace",
    targetId: workspace.id,
    agentName: null,
    payload: {
      fromName: workspace.name,
      toName: result.workspace.name,
      fromSlug: workspace.slug,
      toSlug: result.workspace.slug,
    },
  });

  if (result.slugChanged) {
    // The URL moved; everything under the old slug now redirects, but send the
    // admin straight to the canonical settings URL.
    redirect(`/${result.workspace.slug}/settings/general`);
  }

  revalidatePath(`/${slug}`, "layout");
  return { message: "Workspace name updated." };
}

// ─────────────────────────────────────────────────────────────────────
// Tembo Coding Agent — improvements delivery mode (PR vs YOLO)

export type CommitModeState = {
  message?: string;
  error?: string;
};

/**
 * Switch how the coding agent's changes ship: pull_request (review-gated) or
 * direct ("YOLO" — straight to the default branch). Workspace-admin only and
 * audited, since it changes how code lands.
 */
export async function setCommitModeAction(
  _prev: CommitModeState,
  formData: FormData,
): Promise<CommitModeState> {
  const slug = String(formData.get("workspace") ?? "");
  const modeRaw = String(formData.get("mode") ?? "");
  if (!isCommitMode(modeRaw)) return { error: "Unknown delivery mode." };

  const auth = await authorizeWorkspace(slug, "workspace_admin");
  if (auth.denied) return { error: DENIED_MESSAGE };
  const { workspace, userId } = auth;

  if (workspace.commitMode === modeRaw) {
    return { message: `Already set to ${COMMIT_MODE_LABELS[modeRaw]}.` };
  }

  const result = await setWorkspaceCommitMode(workspace.id, modeRaw);
  if (!result.ok) return { error: "Workspace not found." };

  await writeAuditEvent({
    workspaceId: workspace.id,
    actorUserId: userId,
    source: "human_action",
    kind: "workspace.commit_mode_changed",
    targetType: "workspace",
    targetId: workspace.id,
    agentName: null,
    payload: { from: workspace.commitMode, to: modeRaw },
  });

  revalidatePath(`/${slug}/settings`);
  revalidatePath(`/${slug}`, "layout");
  return {
    message:
      modeRaw === "direct"
        ? "YOLO on — changes now commit directly to the default branch."
        : "Always PR on — changes now open a pull request for review.",
  };
}

// ─────────────────────────────────────────────────────────────────────
// Danger zone — delete workspace

export type DeleteWorkspaceState = { error?: string };

/**
 * Permanently delete a workspace. Workspace-admin only, and the caller
 * must type the workspace name exactly to confirm. On success we redirect
 * to `/` — the workspace and all its data (including audit rows) are gone,
 * so there's nothing left to audit or revalidate in place.
 */
export async function deleteWorkspaceAction(
  _prev: DeleteWorkspaceState,
  formData: FormData,
): Promise<DeleteWorkspaceState> {
  const slug = String(formData.get("workspace") ?? "");
  const confirm = String(formData.get("confirm") ?? "").trim();

  const auth = await authorizeWorkspace(slug, "workspace_admin");
  if (auth.denied) return { error: DENIED_MESSAGE };
  const { workspace } = auth;

  if (confirm !== workspace.name) {
    return { error: "Type the workspace name exactly to confirm." };
  }

  await deleteWorkspace(workspace.id);
  redirect("/");
}
