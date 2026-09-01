import "server-only";

import { decryptSecret, encryptSecret, last4 } from "@/lib/crypto";
import { aadSecretConnection } from "@/lib/crypto-aad";
import { db } from "@/lib/db";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

export type SecretConnectionScope = "personal" | "workspace";

export function isValidSecretSlug(slug: string): boolean {
  return slug.length >= 2 && slug.length <= 64 && SLUG_RE.test(slug);
}

/** Masked, client-safe view of a secret. Plaintext is never selected here. */
export type SecretConnectionPreview = {
  id: string;
  slug: string;
  description: string | null;
  last4: string;
  scope: SecretConnectionScope;
  updatedAt: string;
};

type PreviewRow = {
  id: string;
  slug: string;
  description: string | null;
  last4: string;
  user_id: string | null;
  updated_at: Date;
};

function preview(row: PreviewRow): SecretConnectionPreview {
  return {
    id: row.id,
    slug: row.slug,
    description: row.description,
    last4: row.last4,
    scope: row.user_id === null ? "workspace" : "personal",
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Shared secrets plus the supplied user's own personal secrets. */
export async function listSecretConnections(
  workspaceId: string,
  userId?: string,
): Promise<SecretConnectionPreview[]> {
  const { rows } = await db.query<PreviewRow>(
    `SELECT id, slug, description, last4, user_id, updated_at
       FROM workspace_secret_connection
      WHERE workspace_id = $1
        AND (user_id IS NULL OR user_id = $2)
      ORDER BY slug, user_id NULLS LAST`,
    [workspaceId, userId ?? null],
  );
  return rows.map(preview);
}

/** Exact scoped row lookup; another user's personal row is indistinguishable from missing. */
export async function getSecretConnectionById(
  workspaceId: string,
  id: string,
  userId?: string,
): Promise<SecretConnectionPreview | null> {
  const { rows } = await db.query<PreviewRow>(
    `SELECT id, slug, description, last4, user_id, updated_at
       FROM workspace_secret_connection
      WHERE workspace_id = $1 AND id = $2
        AND (user_id IS NULL OR user_id = $3)
      LIMIT 1`,
    [workspaceId, id, userId ?? null],
  );
  return rows[0] ? preview(rows[0]) : null;
}

export type UpsertSecretResult =
  | { ok: true; rotated: boolean; id: string }
  | { ok: false; error: "bad-slug" | "empty-value" };

/** Insert or rotate one secret in the requested owner scope. */
export async function upsertSecretConnection(args: {
  workspaceId: string;
  slug: string;
  value: string;
  description: string | null;
  actorUserId: string;
  ownerUserId: string | null;
}): Promise<UpsertSecretResult> {
  const slug = args.slug.trim().toLowerCase();
  if (!isValidSecretSlug(slug)) return { ok: false, error: "bad-slug" };
  if (!args.value) return { ok: false, error: "empty-value" };

  const { rows: existingRows } = await db.query<{ id: string }>(
    `SELECT id FROM workspace_secret_connection
      WHERE workspace_id = $1 AND slug = $2
        AND user_id IS NOT DISTINCT FROM $3
      LIMIT 1`,
    [args.workspaceId, slug, args.ownerUserId],
  );
  const ciphertext = encryptSecret(
    args.value,
    aadSecretConnection(args.workspaceId, slug, args.ownerUserId),
  );
  const conflict = args.ownerUserId
    ? `(workspace_id, user_id, slug) WHERE user_id IS NOT NULL`
    : `(workspace_id, slug) WHERE user_id IS NULL`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO workspace_secret_connection
       (workspace_id, slug, description, ciphertext, last4, created_by, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT ${conflict}
       DO UPDATE SET description = EXCLUDED.description,
                     ciphertext = EXCLUDED.ciphertext,
                     last4 = EXCLUDED.last4,
                     updated_at = NOW()
       RETURNING id`,
    [
      args.workspaceId,
      slug,
      args.description?.trim() || null,
      ciphertext,
      last4(args.value),
      args.actorUserId,
      args.ownerUserId,
    ],
  );
  return { ok: true, rotated: existingRows.length > 0, id: rows[0].id };
}

/** Rotate an exact row after the caller has enforced owner/admin policy. */
export async function updateSecretConnection(args: {
  workspaceId: string;
  id: string;
  slug: string;
  value: string;
  description: string | null;
  ownerUserId: string | null;
}): Promise<boolean> {
  if (!args.value) return false;
  const ciphertext = encryptSecret(
    args.value,
    aadSecretConnection(args.workspaceId, args.slug, args.ownerUserId),
  );
  const { rowCount } = await db.query(
    `UPDATE workspace_secret_connection
        SET description = $3, ciphertext = $4, last4 = $5, updated_at = NOW()
      WHERE workspace_id = $1 AND id = $2
        AND user_id IS NOT DISTINCT FROM $6`,
    [
      args.workspaceId,
      args.id,
      args.description?.trim() || null,
      ciphertext,
      last4(args.value),
      args.ownerUserId,
    ],
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteSecretConnection(
  workspaceId: string,
  id: string,
  ownerUserId: string | null,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `DELETE FROM workspace_secret_connection
      WHERE workspace_id = $1 AND id = $2
        AND user_id IS NOT DISTINCT FROM $3`,
    [workspaceId, id, ownerUserId],
  );
  return (rowCount ?? 0) > 0;
}

/** Manual-credential bundles remain workspace-shared and address fields by slug. */
export async function deleteSharedSecretConnection(
  workspaceId: string,
  slug: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `DELETE FROM workspace_secret_connection
      WHERE workspace_id = $1 AND slug = $2 AND user_id IS NULL`,
    [workspaceId, slug],
  );
  return (rowCount ?? 0) > 0;
}

/** Shared-only plaintext lookup for workspace integrations such as LinkedIn. */
export async function getSecretConnectionValue(
  workspaceId: string,
  slug: string,
): Promise<string | null> {
  const { rows } = await db.query<{ ciphertext: Buffer }>(
    `SELECT ciphertext FROM workspace_secret_connection
      WHERE workspace_id = $1 AND slug = $2 AND user_id IS NULL`,
    [workspaceId, slug],
  );
  if (rows.length === 0) return null;
  return decryptSecret(rows[0].ciphertext, aadSecretConnection(workspaceId, slug));
}
