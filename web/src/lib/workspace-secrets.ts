import "server-only";

import { decryptSecret, encryptSecret, last4 } from "@/lib/crypto";
import { aadWorkspaceSecret } from "@/lib/crypto-aad";
import { db } from "@/lib/db";

export type WorkspaceSecretKind =
  | "tembo_api_key"
  | "github_pat"
  | "anthropic_api_key"
  | "openai_api_key"
  | "fireworks_api_key"
  | "scaledown_api_key"
  | "composio_api_key"
  | "composio_webhook_secret";

export type WorkspaceSecretPreview = {
  last4: string;
  updatedAt: Date;
};

export async function getWorkspaceSecretPreview(
  workspaceId: string,
  kind: WorkspaceSecretKind,
): Promise<WorkspaceSecretPreview | null> {
  const { rows } = await db.query<{ last4: string; updated_at: Date }>(
    `SELECT last4, updated_at
       FROM workspace_secret
      WHERE workspace_id = $1 AND kind = $2`,
    [workspaceId, kind],
  );
  if (!rows[0]) return null;
  return { last4: rows[0].last4, updatedAt: rows[0].updated_at };
}

/**
 * Returns the decrypted secret. Runtime use only — never serialize to a
 * client. Throws if the secret does not exist for (workspace, kind).
 */
export async function getWorkspaceSecretPlaintext(
  workspaceId: string,
  kind: WorkspaceSecretKind,
): Promise<string> {
  const { rows } = await db.query<{ ciphertext: Buffer }>(
    `SELECT ciphertext FROM workspace_secret WHERE workspace_id = $1 AND kind = $2`,
    [workspaceId, kind],
  );
  if (!rows[0]) {
    throw new Error(`workspace secret not found: ${kind}`);
  }
  return decryptSecret(rows[0].ciphertext, aadWorkspaceSecret(workspaceId, kind));
}

export type SetWorkspaceSecretError =
  | "empty"
  | "too-short"
  | "too-long"
  | "bad-prefix";

export type SetWorkspaceSecretResult =
  | { ok: true }
  | { ok: false; error: SetWorkspaceSecretError };

// Per-provider prefix sniffs. Cheap shape check that catches the
// most common misclick (pasting an error page or unrelated text
// into the form). We never reject on prefix mismatch alone for
// providers we don't have a known prefix for — the rates change
// across plans/SKUs and locking that down would create more
// false-negative pain than it prevents.
const SECRET_PREFIXES: Partial<Record<WorkspaceSecretKind, string[]>> = {
  composio_api_key: ["ak_"],
  anthropic_api_key: ["sk-ant-"],
  openai_api_key: ["sk-"],
};

export async function setWorkspaceSecret(
  workspaceId: string,
  kind: WorkspaceSecretKind,
  plaintext: string,
): Promise<SetWorkspaceSecretResult> {
  const trimmed = plaintext.trim();
  if (trimmed.length === 0) return { ok: false, error: "empty" };
  // Conservative shape checks — keep the application from storing junk while
  // still tolerating whatever format Tembo issues today vs tomorrow.
  if (trimmed.length < 16) return { ok: false, error: "too-short" };
  if (trimmed.length > 512) return { ok: false, error: "too-long" };
  const expectedPrefixes = SECRET_PREFIXES[kind];
  if (
    expectedPrefixes &&
    !expectedPrefixes.some((p) => trimmed.startsWith(p))
  ) {
    return { ok: false, error: "bad-prefix" };
  }

  const ciphertext = encryptSecret(trimmed, aadWorkspaceSecret(workspaceId, kind));
  await db.query(
    `INSERT INTO workspace_secret (workspace_id, kind, ciphertext, last4)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, kind)
       DO UPDATE SET ciphertext = EXCLUDED.ciphertext,
                     last4 = EXCLUDED.last4,
                     updated_at = NOW()`,
    [workspaceId, kind, ciphertext, last4(trimmed)],
  );
  return { ok: true };
}

export async function removeWorkspaceSecret(
  workspaceId: string,
  kind: WorkspaceSecretKind,
): Promise<void> {
  await db.query(
    `DELETE FROM workspace_secret WHERE workspace_id = $1 AND kind = $2`,
    [workspaceId, kind],
  );
}
