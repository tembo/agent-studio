"use server";

import { redirect } from "next/navigation";
import { notFound } from "next/navigation";

import { authorizeWorkspace, DENIED_MESSAGE } from "@/lib/auth-server";
import { getManualCredentialProvider } from "@/lib/manual-credential-providers";
import {
  deleteSharedSecretConnection,
  listSecretConnections,
  upsertSecretConnection,
} from "@/lib/secret-connections";

// Manage a "manual credential" connection (LinkedIn, …). Each provider field is
// stored as a workspace secret under field.key, so the runtime is unchanged —
// this just writes/deletes the group atomically with setup instructions. Admin
// only, like secrets.

export type ManualCredFormState = { error?: string };

export async function setManualCredentialAction(
  _prev: ManualCredFormState,
  formData: FormData,
): Promise<ManualCredFormState> {
  const slug = String(formData.get("workspace") ?? "");
  const providerSlug = String(formData.get("provider") ?? "");

  const auth = await authorizeWorkspace(slug, "workspace_admin");
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
    (await listSecretConnections(workspace.id)).map((s) => s.slug),
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
      ownerUserId: null,
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

  const auth = await authorizeWorkspace(slug, "workspace_admin");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }
  const { workspace } = auth;

  const provider = getManualCredentialProvider(providerSlug);
  if (!provider) return { error: "Unknown provider." };

  for (const f of provider.fields) {
    await deleteSharedSecretConnection(workspace.id, f.key);
  }

  redirect(`/${slug}/connections`);
}
