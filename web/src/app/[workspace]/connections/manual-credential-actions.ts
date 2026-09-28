"use server";

import { redirect } from "next/navigation";
import { notFound } from "next/navigation";

import { authorizeWorkspace, DENIED_MESSAGE } from "@/lib/auth-server";
import { getManualCredentialProvider } from "@/lib/manual-credential-providers";
import {
  deleteSecretConnection,
  listSecretConnections,
  upsertSecretConnection,
} from "@/lib/secret-connections";

export type ManualCredFormState = { error?: string };

export async function setManualCredentialAction(
  _prev: ManualCredFormState,
  formData: FormData,
): Promise<ManualCredFormState> {
  const slug = String(formData.get("workspace") ?? "");
  const providerSlug = String(formData.get("provider") ?? "");

  const auth = await authorizeWorkspace(slug, "operator");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }
  const { workspace, userId } = auth;

  const provider = getManualCredentialProvider(providerSlug);
  if (!provider) return { error: "Unknown provider." };

  // Existing field secrets — a blank input on a field that's already set means
  // "keep it" (so re-connecting doesn't force re-pasting every value).
  const existing = new Set(
    (await listSecretConnections(workspace.id, userId))
      .filter((secret) => secret.scope === "personal")
      .map((secret) => secret.slug),
  );

  // Validate required fields are satisfied (provided now, or already set).
  for (const f of provider.fields) {
    const v = String(formData.get(f.key) ?? "").trim();
    if (f.required && !v && !existing.has(f.key)) {
      return { error: `${f.label} is required.` };
    }
  }

  for (const f of provider.fields) {
    const v = String(formData.get(f.key) ?? "").trim();
    if (!v) continue; // keep existing
    const res = await upsertSecretConnection({
      workspaceId: workspace.id,
      slug: f.key,
      value: v,
      description: `${provider.displayName} · ${f.label}`,
      actorUserId: userId,
      ownerUserId: userId,
    });
    if (!res.ok) {
      return { error: `Couldn't save ${f.label} (${res.error}).` };
    }
  }

  redirect(`/${slug}/connections/manual-cred~${provider.slug}`);
}

export async function removeManualCredentialAction(
  _prev: ManualCredFormState,
  formData: FormData,
): Promise<ManualCredFormState> {
  const slug = String(formData.get("workspace") ?? "");
  const providerSlug = String(formData.get("provider") ?? "");

  const auth = await authorizeWorkspace(slug, "operator");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }
  const { workspace, userId } = auth;

  const provider = getManualCredentialProvider(providerSlug);
  if (!provider) return { error: "Unknown provider." };

  const fieldSlugs = new Set(provider.fields.map((field) => field.key));
  const secrets = await listSecretConnections(workspace.id, userId);
  for (const secret of secrets) {
    if (secret.scope === "personal" && fieldSlugs.has(secret.slug)) {
      await deleteSecretConnection(workspace.id, secret.id, userId);
    }
  }

  redirect(`/${slug}/connections`);
}
