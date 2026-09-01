"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { writeAuditEvent } from "@/lib/audit-db";
import { authorizeWorkspace, DENIED_MESSAGE } from "@/lib/auth-server";
import { canManageSecretScope } from "@/lib/secret-connection-policy";
import {
  deleteSecretConnection,
  getSecretConnectionById,
  isValidSecretSlug,
  updateSecretConnection,
  upsertSecretConnection,
  type SecretConnectionScope,
} from "@/lib/secret-connections";

export type SecretActionState = {
  message?: string;
  error?: string;
};

function requestedScope(formData: FormData): SecretConnectionScope {
  return formData.get("scope") === "workspace" ? "workspace" : "personal";
}

function revalidateConnections(workspaceSlug: string) {
  revalidatePath(`/${workspaceSlug}/connections`, "layout");
  revalidatePath(`/${workspaceSlug}`, "layout");
}

/** Add a scoped secret or rotate the exact row selected from its detail page. */
export async function setSecretConnectionAction(
  _prev: SecretActionState,
  formData: FormData,
): Promise<SecretActionState> {
  const workspaceSlug = String(formData.get("workspace") ?? "");
  const id = String(formData.get("id") ?? "").trim();
  const slug = String(formData.get("slug") ?? "").trim().toLowerCase();
  const value = String(formData.get("value") ?? "");
  const description = String(formData.get("description") ?? "");

  const auth = await authorizeWorkspace(workspaceSlug, "operator");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }
  const { workspace, userId, role } = auth;

  if (!isValidSecretSlug(slug)) {
    return {
      error:
        "Name must be 2–64 chars: lowercase letters, digits, hyphens, or underscores.",
    };
  }
  if (!value.trim()) return { error: "Enter the secret value." };

  let secretId: string;
  let scope: SecretConnectionScope;
  let rotated: boolean;

  if (id) {
    const existing = await getSecretConnectionById(workspace.id, id, userId);
    if (!existing || existing.slug !== slug) {
      return { error: "Secret no longer exists." };
    }
    if (!canManageSecretScope(role, existing.scope)) {
      return { error: DENIED_MESSAGE };
    }
    const ownerUserId = existing.scope === "personal" ? userId : null;
    const updated = await updateSecretConnection({
      workspaceId: workspace.id,
      id,
      slug,
      value,
      description,
      ownerUserId,
    });
    if (!updated) return { error: "Secret no longer exists." };
    secretId = id;
    scope = existing.scope;
    rotated = true;
  } else {
    scope = requestedScope(formData);
    if (!canManageSecretScope(role, scope)) return { error: DENIED_MESSAGE };
    const result = await upsertSecretConnection({
      workspaceId: workspace.id,
      slug,
      value,
      description,
      actorUserId: userId,
      ownerUserId: scope === "personal" ? userId : null,
    });
    if (!result.ok) {
      return {
        error:
          result.error === "bad-slug"
            ? "Invalid secret name."
            : "Enter the secret value.",
      };
    }
    secretId = result.id;
    rotated = result.rotated;
  }

  await writeAuditEvent({
    workspaceId: workspace.id,
    actorUserId: userId,
    source: "human_action",
    kind: rotated ? "secret_connection.rotated" : "secret_connection.set",
    targetType: "connection",
    targetId: secretId,
    agentName: null,
    payload: { slug, scope, source: "secret" },
  });

  revalidateConnections(workspaceSlug);
  redirect(`/${workspaceSlug}/connections/secret~${secretId}`);
}

/** Remove the exact scoped row selected from its detail page. */
export async function removeSecretConnectionAction(
  _prev: SecretActionState,
  formData: FormData,
): Promise<SecretActionState> {
  const workspaceSlug = String(formData.get("workspace") ?? "");
  const id = String(formData.get("id") ?? "").trim();

  const auth = await authorizeWorkspace(workspaceSlug, "operator");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }
  const { workspace, userId, role } = auth;
  const existing = await getSecretConnectionById(workspace.id, id, userId);
  if (!existing) return { error: "Secret no longer exists." };
  if (!canManageSecretScope(role, existing.scope)) {
    return { error: DENIED_MESSAGE };
  }

  const ownerUserId = existing.scope === "personal" ? userId : null;
  const ok = await deleteSecretConnection(workspace.id, id, ownerUserId);
  if (!ok) return { error: "Secret no longer exists." };

  await writeAuditEvent({
    workspaceId: workspace.id,
    actorUserId: userId,
    source: "human_action",
    kind: "secret_connection.removed",
    targetType: "connection",
    targetId: id,
    agentName: null,
    payload: { slug: existing.slug, scope: existing.scope, source: "secret" },
  });

  revalidateConnections(workspaceSlug);
  redirect(`/${workspaceSlug}/connections`);
}
