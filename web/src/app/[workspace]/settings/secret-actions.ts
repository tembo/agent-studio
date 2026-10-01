"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { writeAuditEvent } from "@/lib/audit-db";
import {
  authorizeWorkspace as authorizeWorkspaceShared,
  DENIED_MESSAGE,
} from "@/lib/auth-server";
import { type WorkspaceRole } from "@/lib/rbac";
import {
  getWorkspaceSecretPreview,
  setWorkspaceSecret,
  removeWorkspaceSecret,
  type WorkspaceSecretKind,
  type SetWorkspaceSecretError,
} from "@/lib/workspace-secrets";

// Keep the union narrow — only kinds the settings UI lets you manage
// land here. The repo-connect flow writes github_pat; the runtime stores
// keys through this surface only.
type SettingsKind = Extract<
  WorkspaceSecretKind,
  | "tembo_api_key"
  | "anthropic_api_key"
  | "openai_api_key"
  | "fireworks_api_key"
  | "scaledown_api_key"
  | "composio_api_key"
  | "composio_webhook_secret"
>;

const SETTINGS_KIND_LABELS: Record<SettingsKind, string> = {
  tembo_api_key: "Tembo API key",
  anthropic_api_key: "Anthropic API key",
  openai_api_key: "OpenAI API key",
  fireworks_api_key: "Fireworks API key",
  scaledown_api_key: "ScaleDown API key",
  composio_api_key: "Composio API key",
  composio_webhook_secret: "Composio webhook secret",
};

function isSettingsKind(v: string): v is SettingsKind {
  return (
    v === "tembo_api_key" ||
    v === "anthropic_api_key" ||
    v === "openai_api_key" ||
    v === "fireworks_api_key" ||
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
