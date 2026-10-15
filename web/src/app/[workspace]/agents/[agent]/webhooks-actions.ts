"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";

import { writeAuditEvent } from "@/lib/audit-db";
import { authorizeWorkspace, DENIED_MESSAGE } from "@/lib/auth-server";
import { getPublicOrigin } from "@/lib/config";
import {
  createWebhook,
  deleteWebhook,
  getWebhookPreview,
  rotateWebhookToken,
  setWebhookEnabled,
} from "@/lib/webhooks-db";
import { listWorkspaceMembers } from "@/lib/workspace";

// Server actions for external webhook triggers. Operator-gated (same as the
// Composio trigger actions). create/rotate return the one-time token + the full
// endpoint URL so the UI can reveal it once.

export type WebhookActionState = {
  message?: string;
  error?: string;
  /** Present right after create/rotate — the UI reveals it once, then it's gone.
   *  `signed` webhooks (Clerk/Svix) authenticate by signature, so the bearer
   *  token is irrelevant and the reveal shows setup for the signing secret. */
  secret?: { id: string; url: string; token: string; signed: boolean };
};

function urlFor(id: string): string {
  return `${getPublicOrigin()}/api/hooks/webhook/${id}`;
}

function revalidateAgent(slug: string, agentName: string) {
  revalidatePath(`/${slug}/agents/${encodeURIComponent(agentName)}`);
}

export async function createWebhookAction(
  _prev: WebhookActionState,
  formData: FormData,
): Promise<WebhookActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const agentName = String(formData.get("agent") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const ownerRaw = String(formData.get("owner") ?? "").trim();
  const signingSecret = String(formData.get("signingSecret") ?? "").trim();

  const auth = await authorizeWorkspace(slug, "operator");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }
  const { workspace, userId, role } = auth;

  if (!name) return { error: "Give the webhook a name." };
  if (name.length > 64) return { error: "Name must be 64 characters or fewer." };
  // A signing secret is optional (bearer mode if absent). When present it's a
  // Svix/Clerk endpoint secret — sanity-check the shape so a paste error fails
  // here rather than silently never verifying.
  if (signingSecret && !/^whsec_[A-Za-z0-9+/=]{16,}$/.test(signingSecret)) {
    return {
      error: "Signing secret should look like `whsec_…` (the Svix signing secret from your webhook provider).",
    };
  }

  // Owner defaults to the creating user; an admin may run it as another member.
  let ownerUserId = userId;
  if (ownerRaw && ownerRaw !== userId) {
    if (role !== "workspace_admin") {
      return { error: "Only admins can set another member as the owner." };
    }
    const members = await listWorkspaceMembers(workspace.id);
    if (!members.some((m) => m.userId === ownerRaw)) {
      return { error: "Owner must be a member of this workspace." };
    }
    ownerUserId = ownerRaw;
  }

  const { webhook, token } = await createWebhook({
    workspaceId: workspace.id,
    agentName,
    ownerUserId,
    name,
    createdBy: userId,
    signingSecret: signingSecret || null,
  });

  await writeAuditEvent({
    workspaceId: workspace.id,
    actorUserId: userId,
    source: "human_action",
    kind: "webhook.created",
    targetType: "webhook",
    targetId: webhook.id,
    agentName,
    payload: { name, ownerUserId, signed: Boolean(signingSecret) },
  });

  revalidateAgent(slug, agentName);
  return {
    message: `Created "${name}".`,
    secret: {
      id: webhook.id,
      url: urlFor(webhook.id),
      token,
      signed: Boolean(signingSecret),
    },
  };
}

export async function rotateWebhookAction(
  _prev: WebhookActionState,
  formData: FormData,
): Promise<WebhookActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const id = String(formData.get("id") ?? "");

  const auth = await authorizeWorkspace(slug, "operator");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }
  const { workspace, userId, role } = auth;

  const existing = await getWebhookPreview(workspace.id, id);
  if (!existing) return { error: "Webhook no longer exists." };
  if (existing.ownerUserId !== userId && role !== "workspace_admin") {
    return { error: "Only the webhook owner or a workspace admin can modify it." };
  }

  const token = await rotateWebhookToken(workspace.id, id);
  if (!token) return { error: "Webhook no longer exists." };

  await writeAuditEvent({
    workspaceId: workspace.id,
    actorUserId: userId,
    source: "human_action",
    kind: "webhook.rotated",
    targetType: "webhook",
    targetId: id,
    agentName: existing.agentName,
    payload: { name: existing.name },
  });

  revalidateAgent(slug, existing.agentName);
  return {
    message: `Rotated "${existing.name}". The old token no longer works.`,
    // Render the reveal in the webhook's actual mode — a signed (Clerk) webhook
    // authenticates by signature, so never hand back a rotated bearer token the
    // receiver won't check. (The UI also hides Rotate for signed webhooks.)
    secret: { id, url: urlFor(id), token, signed: existing.hasSigningSecret },
  };
}

export async function toggleWebhookAction(
  _prev: WebhookActionState,
  formData: FormData,
): Promise<WebhookActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const id = String(formData.get("id") ?? "");
  const enabled = formData.get("enabled") === "true";

  const auth = await authorizeWorkspace(slug, "operator");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }
  const { workspace, userId, role } = auth;

  const existing = await getWebhookPreview(workspace.id, id);
  if (!existing) return { error: "Webhook no longer exists." };
  if (existing.ownerUserId !== userId && role !== "workspace_admin") {
    return { error: "Only the webhook owner or a workspace admin can modify it." };
  }

  await setWebhookEnabled(workspace.id, id, enabled);
  await writeAuditEvent({
    workspaceId: workspace.id,
    actorUserId: userId,
    source: "human_action",
    kind: enabled ? "webhook.enabled" : "webhook.disabled",
    targetType: "webhook",
    targetId: id,
    agentName: existing.agentName,
    payload: { name: existing.name },
  });

  revalidateAgent(slug, existing.agentName);
  return { message: enabled ? "Enabled." : "Disabled." };
}

export async function deleteWebhookAction(
  _prev: WebhookActionState,
  formData: FormData,
): Promise<WebhookActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const id = String(formData.get("id") ?? "");

  const auth = await authorizeWorkspace(slug, "operator");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }
  const { workspace, userId, role } = auth;

  const existing = await getWebhookPreview(workspace.id, id);
  if (!existing) return { message: "Already gone." };
  if (existing.ownerUserId !== userId && role !== "workspace_admin") {
    return { error: "Only the webhook owner or a workspace admin can modify it." };
  }

  await deleteWebhook(workspace.id, id);
  await writeAuditEvent({
    workspaceId: workspace.id,
    actorUserId: userId,
    source: "human_action",
    kind: "webhook.deleted",
    targetType: "webhook",
    targetId: id,
    agentName: existing.agentName,
    payload: { name: existing.name },
  });

  revalidateAgent(slug, existing.agentName);
  return { message: `Removed "${existing.name}".` };
}
