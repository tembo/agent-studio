import "server-only";

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { decryptSecret, encryptSecret, last4 } from "@/lib/crypto";
import { aadWebhookSigningSecret, aadWebhookToken } from "@/lib/crypto-aad";
import { db } from "@/lib/db";
import { verifySvixRequest } from "@/lib/svix-verify";

// External webhook triggers — an inbound HTTP endpoint that fires an agent run.
// An outside system POSTs JSON to /api/hooks/webhook/<id>; TAS queues a run of
// the bound agent acting as the webhook's owner. The row `id` is the public URL
// selector. Auth is one of two modes:
//   - bearer (default): caller sends `Authorization: Bearer <token>` (Clay).
//   - signed (Svix): caller signs each delivery and we verify it against the
//     stored signing secret (Clerk, which can't set a custom header).
// Both secrets are encrypted at rest; the bearer token is shown once on create.
//
// Modeled on lib/triggers-db.ts (Composio event triggers), minus the Composio
// integration — these are TAS-owned endpoints with no third party.

/** Masked, client-safe view — never carries a plaintext secret. */
export type WebhookPreview = {
  id: string;
  workspaceId: string;
  agentName: string;
  ownerUserId: string;
  name: string;
  tokenLast4: string;
  /** True when this webhook authenticates by Svix signature (Clerk) rather than
   *  a bearer token. */
  hasSigningSecret: boolean;
  enabled: boolean;
  lastFiredAt: Date | null;
  lastFireError: string | null;
  lastFireEventId: string | null;
  createdAt: Date;
};

/** Full row including the ciphertexts — server-only, for inbound verification. */
export type WebhookRow = WebhookPreview & {
  tokenCiphertext: Buffer;
  signingSecretCiphertext: Buffer | null;
};

const PREVIEW_COLS = `id, workspace_id, agent_name, owner_user_id, name,
  token_last4, (signing_secret_ciphertext IS NOT NULL) AS has_signing_secret,
  enabled, last_fired_at, last_fire_error, last_fire_event_id, created_at`;

type PreviewDbRow = {
  id: string;
  workspace_id: string;
  agent_name: string;
  owner_user_id: string;
  name: string;
  token_last4: string;
  has_signing_secret: boolean;
  enabled: boolean;
  last_fired_at: Date | null;
  last_fire_error: string | null;
  last_fire_event_id: string | null;
  created_at: Date;
};

function toPreview(r: PreviewDbRow): WebhookPreview {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    agentName: r.agent_name,
    ownerUserId: r.owner_user_id,
    name: r.name,
    tokenLast4: r.token_last4,
    hasSigningSecret: r.has_signing_secret,
    enabled: r.enabled,
    lastFiredAt: r.last_fired_at,
    lastFireError: r.last_fire_error,
    lastFireEventId: r.last_fire_event_id,
    createdAt: r.created_at,
  };
}

/** A fresh bearer token: URL-safe, high-entropy, with a `whk_` prefix so it's
 *  recognizable in a header. */
function generateToken(): string {
  return `whk_${randomBytes(32).toString("base64url")}`;
}

export async function listWebhooksForAgent(
  workspaceId: string,
  agentName: string,
): Promise<WebhookPreview[]> {
  const { rows } = await db.query<PreviewDbRow>(
    `SELECT ${PREVIEW_COLS}
       FROM workspace_webhook
      WHERE workspace_id = $1 AND agent_name = $2
      ORDER BY created_at ASC`,
    [workspaceId, agentName],
  );
  return rows.map(toPreview);
}

export async function listWebhooksForWorkspace(
  workspaceId: string,
): Promise<WebhookPreview[]> {
  const { rows } = await db.query<PreviewDbRow>(
    `SELECT ${PREVIEW_COLS}
       FROM workspace_webhook
      WHERE workspace_id = $1
      ORDER BY agent_name ASC, created_at ASC`,
    [workspaceId],
  );
  return rows.map(toPreview);
}

export async function getWebhookPreview(
  workspaceId: string,
  id: string,
): Promise<WebhookPreview | null> {
  const { rows } = await db.query<PreviewDbRow>(
    `SELECT ${PREVIEW_COLS} FROM workspace_webhook
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id],
  );
  return rows[0] ? toPreview(rows[0]) : null;
}

/**
 * Inbound lookup by URL id (no workspace scope — the id is globally unique and
 * is what the public endpoint has). Returns the ciphertext so the route can
 * verify the presented bearer token.
 */
export async function getWebhookForInbound(
  id: string,
): Promise<WebhookRow | null> {
  const { rows } = await db.query<
    PreviewDbRow & {
      token_ciphertext: Buffer;
      signing_secret_ciphertext: Buffer | null;
    }
  >(
    `SELECT ${PREVIEW_COLS}, token_ciphertext, signing_secret_ciphertext
       FROM workspace_webhook
      WHERE id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    ...toPreview(r),
    tokenCiphertext: r.token_ciphertext,
    signingSecretCiphertext: r.signing_secret_ciphertext,
  };
}

/** Constant-time check that a presented token matches the stored one. */
export function webhookTokenMatches(
  row: WebhookRow,
  presented: string,
): boolean {
  let stored: string;
  try {
    stored = decryptSecret(
      row.tokenCiphertext,
      aadWebhookToken(row.workspaceId, row.id),
    );
  } catch {
    return false;
  }
  const a = Buffer.from(stored, "utf8");
  const b = Buffer.from(presented, "utf8");
  // timingSafeEqual throws on length mismatch — guard first (the length itself
  // isn't secret), then compare in constant time.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Verify a Svix-signed inbound (Clerk) against the webhook's stored signing
 * secret. Returns false if this webhook isn't a signed one or the signature
 * doesn't verify. The raw body must be the exact bytes the sender signed.
 */
export function webhookSvixMatches(
  row: WebhookRow,
  args: {
    rawBody: string;
    svixId: string | null;
    svixTimestamp: string | null;
    svixSignature: string | null;
  },
): boolean {
  if (!row.signingSecretCiphertext) return false;
  let secret: string;
  try {
    secret = decryptSecret(
      row.signingSecretCiphertext,
      aadWebhookSigningSecret(row.workspaceId, row.id),
    );
  } catch {
    return false;
  }
  return verifySvixRequest({ signingSecret: secret, ...args }).ok;
}

export async function createWebhook(args: {
  workspaceId: string;
  agentName: string;
  ownerUserId: string;
  name: string;
  createdBy: string;
  /** Optional Svix signing secret (`whsec_...`). When set, the webhook
   *  authenticates by signature (Clerk) instead of the bearer token. */
  signingSecret?: string | null;
}): Promise<{ webhook: WebhookPreview; token: string }> {
  const token = generateToken();
  // Generate the id up front so the secret AADs can bind to it at encrypt time.
  const id = randomUUID();
  const signing = args.signingSecret?.trim() || null;
  const { rows } = await db.query<PreviewDbRow>(
    `INSERT INTO workspace_webhook
       (id, workspace_id, agent_name, owner_user_id, name, token_ciphertext,
        token_last4, signing_secret_ciphertext, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${PREVIEW_COLS}`,
    [
      id,
      args.workspaceId,
      args.agentName,
      args.ownerUserId,
      args.name,
      encryptSecret(token, aadWebhookToken(args.workspaceId, id)),
      last4(token),
      signing
        ? encryptSecret(signing, aadWebhookSigningSecret(args.workspaceId, id))
        : null,
      args.createdBy,
    ],
  );
  return { webhook: toPreview(rows[0]), token };
}

export async function rotateWebhookToken(
  workspaceId: string,
  id: string,
): Promise<string | null> {
  const token = generateToken();
  const { rowCount } = await db.query(
    `UPDATE workspace_webhook
        SET token_ciphertext = $3, token_last4 = $4, updated_at = NOW()
      WHERE workspace_id = $1 AND id = $2`,
    [
      workspaceId,
      id,
      encryptSecret(token, aadWebhookToken(workspaceId, id)),
      last4(token),
    ],
  );
  return (rowCount ?? 0) > 0 ? token : null;
}

export async function setWebhookEnabled(
  workspaceId: string,
  id: string,
  enabled: boolean,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE workspace_webhook
        SET enabled = $3, updated_at = NOW()
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id, enabled],
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteWebhook(
  workspaceId: string,
  id: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `DELETE FROM workspace_webhook WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Safety-valve rate guard: how many event runs this agent has had in the
 * trailing window. Not per-webhook precise (it counts all `trigger='event'`
 * runs for the agent), but it reliably blunts a runaway Clay loop without a
 * separate fire-log table. The caller caps it generously.
 */
export async function countRecentEventRuns(
  workspaceId: string,
  agentName: string,
  seconds: number,
): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM run
      WHERE workspace_id = $1 AND agent_name = $2 AND trigger = 'event'
        AND created_at > NOW() - ($3 || ' seconds')::interval`,
    [workspaceId, agentName, String(seconds)],
  );
  return Number(rows[0]?.n ?? 0);
}
