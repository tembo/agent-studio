import "server-only";

import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { aadNativeConnection } from "@/lib/crypto-aad";
import { db } from "@/lib/db";
import { type McpProviderSlug } from "@/lib/mcp-providers";

// Workspace connections — the "Native MCP" half of TAS's connection
// substrate. Composio-backed connections live in
// workspace_composio_connection (lib/composio-connections.ts) and
// follow a separate path. This file owns the TAS-managed OAuth
// rows: tokens we got directly from the provider, MCP URL the
// agent runtime talks to, plus a cached tool list for the UI.
//
// Row identity is (workspace_id, user_id, type, name) — same
// per-user scoping the Composio table uses, so a workspace member
// can hold a "work" Attio and a "personal" Attio without collision,
// and audit/owner semantics align across the two connection modes.

export type NativeConnectionStatus = "active" | "stale" | "expired" | "revoked";

/**
 * Plaintext shape of the encrypted credential blob. Field set varies
 * slightly per provider but the OAuth 2.0 common ground is enough
 * for v0.4. PAT-based providers (when we add GitHub etc.) just
 * leave the refresh fields null.
 */
export type ConnectionCredentials = {
  access_token: string;
  refresh_token?: string;
  expires_at?: string; // ISO timestamp
  scope?: string;
  token_type?: string;
  /** dcr_confidential only: the DCR-issued confidential client the refresh
   *  exchange must present (HTTP Basic). Stored inside the encrypted blob and
   *  carried forward by the Rust refresh. */
  client_id?: string;
  client_secret?: string;
};

export type WorkspaceConnection = {
  id: string;
  workspaceId: string;
  userId: string;
  type: McpProviderSlug;
  name: string;
  mcpServerUrl: string;
  authType: "oauth2" | "pat";
  status: NativeConnectionStatus;
  tokenExpiresAt: Date | null;
  refreshErrorCode: string | null;
  refreshErrorMessage: string | null;
  refreshErrorAt: Date | null;
  refreshFailureCount: number;
  refreshRetryAt: Date | null;
  metadata: Record<string, unknown>;
  /** Whether a supplementary API key is attached (never the value — that's
   *  decrypted only in the runtime, never exposed to the UI). */
  hasApiKey: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

type ConnectionRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  type: string;
  name: string;
  mcp_server_url: string | null;
  auth_type: string | null;
  status: string;
  token_expires_at: Date | null;
  refresh_error_code: string | null;
  refresh_error_message: string | null;
  refresh_error_at: Date | null;
  refresh_failure_count: number;
  refresh_retry_at: Date | null;
  metadata: Record<string, unknown> | null;
  has_api_key: boolean;
  created_by: string;
  created_at: Date;
  updated_at: Date;
};

const COLUMNS = `id, workspace_id, user_id, type, name, mcp_server_url,
  auth_type, status, token_expires_at,
  refresh_error_code, refresh_error_message, refresh_error_at,
  refresh_failure_count, refresh_retry_at, metadata,
  (aux_secret_ciphertext IS NOT NULL) AS has_api_key,
  created_by, created_at, updated_at`;

function rowToConnection(r: ConnectionRow): WorkspaceConnection {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    userId: r.user_id,
    type: r.type as McpProviderSlug,
    name: r.name,
    mcpServerUrl: r.mcp_server_url ?? "",
    authType: (r.auth_type as "oauth2" | "pat") ?? "oauth2",
    status: (r.status as NativeConnectionStatus) ?? "active",
    tokenExpiresAt: r.token_expires_at,
    refreshErrorCode: r.refresh_error_code,
    refreshErrorMessage: r.refresh_error_message,
    refreshErrorAt: r.refresh_error_at,
    refreshFailureCount: r.refresh_failure_count ?? 0,
    refreshRetryAt: r.refresh_retry_at,
    metadata: r.metadata ?? {},
    hasApiKey: r.has_api_key ?? false,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * List the native-MCP connections a specific user holds in a
 * workspace. The Connections page UI merges this with the Composio
 * list to produce a unified row model.
 */
export async function listNativeConnectionsForUser(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceConnection[]> {
  const { rows } = await db.query<ConnectionRow>(
    `SELECT ${COLUMNS}
       FROM workspace_connection
      WHERE workspace_id = $1 AND user_id = $2
      ORDER BY type ASC, name ASC`,
    [workspaceId, userId],
  );
  return rows.map(rowToConnection);
}

/** Every active native-MCP connection across all workspaces/users — for the
 *  deploy/scheduled tool-cache reconcile (not a per-user view). */
export async function listAllActiveNativeConnections(): Promise<
  WorkspaceConnection[]
> {
  const { rows } = await db.query<ConnectionRow>(
    `SELECT ${COLUMNS}
       FROM workspace_connection
      WHERE status = 'active'
      ORDER BY workspace_id ASC, user_id ASC, type ASC, name ASC`,
  );
  return rows.map(rowToConnection);
}

export async function getNativeConnection(
  workspaceId: string,
  userId: string,
  type: McpProviderSlug,
  name: string,
): Promise<WorkspaceConnection | null> {
  const { rows } = await db.query<ConnectionRow>(
    `SELECT ${COLUMNS}
       FROM workspace_connection
      WHERE workspace_id = $1 AND user_id = $2 AND type = $3 AND name = $4
      LIMIT 1`,
    [workspaceId, userId, type, name],
  );
  return rows[0] ? rowToConnection(rows[0]) : null;
}

export async function getNativeConnectionById(
  workspaceId: string,
  id: string,
): Promise<WorkspaceConnection | null> {
  const { rows } = await db.query<ConnectionRow>(
    `SELECT ${COLUMNS}
       FROM workspace_connection
      WHERE workspace_id = $1 AND id = $2
      LIMIT 1`,
    [workspaceId, id],
  );
  return rows[0] ? rowToConnection(rows[0]) : null;
}

/**
 * Decrypt and return the stored OAuth tokens. Runtime use only.
 * Throws when the row is missing — never returns null so the
 * runtime can't accidentally proceed without credentials.
 */
export async function getNativeConnectionCredentials(
  connectionId: string,
): Promise<ConnectionCredentials> {
  const { rows } = await db.query<{
    workspace_id: string;
    user_id: string;
    type: string;
    name: string;
    credentials: Buffer;
  }>(
    `SELECT workspace_id, user_id, type, name, credentials
       FROM workspace_connection WHERE id = $1`,
    [connectionId],
  );
  if (!rows[0]) {
    throw new Error(`workspace_connection ${connectionId} not found`);
  }
  const r = rows[0];
  return JSON.parse(
    decryptSecret(
      r.credentials,
      aadNativeConnection(r.workspace_id, r.user_id, r.type, r.name),
    ),
  );
}

export type SaveNativeConnectionArgs = {
  workspaceId: string;
  userId: string;
  type: McpProviderSlug;
  name: string;
  mcpServerUrl: string;
  authType: "oauth2" | "pat";
  credentials: ConnectionCredentials;
  metadata: Record<string, unknown>;
};

/**
 * Upsert. On (workspace_id, user_id, type, name) conflict, replaces
 * the credentials + URL/auth + metadata. Stamps token_expires_at
 * from the credentials so the runner's "refresh-before-use" check
 * doesn't have to decrypt to know.
 */
export async function saveNativeConnection(
  args: SaveNativeConnectionArgs,
): Promise<WorkspaceConnection> {
  const ciphertext = encryptSecret(
    JSON.stringify(args.credentials),
    aadNativeConnection(args.workspaceId, args.userId, args.type, args.name),
  );
  const expiresAt = args.credentials.expires_at
    ? new Date(args.credentials.expires_at)
    : null;

  const { rows } = await db.query<ConnectionRow>(
    `INSERT INTO workspace_connection
       (workspace_id, user_id, type, name, credentials, mcp_server_url,
        auth_type, token_expires_at, status, metadata, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $2)
       ON CONFLICT (workspace_id, user_id, type, name)
       DO UPDATE SET credentials       = EXCLUDED.credentials,
                     mcp_server_url    = EXCLUDED.mcp_server_url,
                     auth_type         = EXCLUDED.auth_type,
                     token_expires_at  = EXCLUDED.token_expires_at,
                     status            = 'active',
                     refresh_error_code = NULL,
                     refresh_error_message = NULL,
                     refresh_error_at = NULL,
                     refresh_failure_count = 0,
                     refresh_retry_at = NULL,
                     metadata          = EXCLUDED.metadata,
                     updated_at        = NOW()
       RETURNING ${COLUMNS}`,
    [
      args.workspaceId,
      args.userId,
      args.type,
      args.name,
      ciphertext,
      args.mcpServerUrl,
      args.authType,
      expiresAt,
      JSON.stringify(args.metadata),
    ],
  );
  return rowToConnection(rows[0]);
}

export type RenameNativeConnectionError =
  | "bad-name-shape"
  | "name-taken"
  | "not-found";

export type RenameNativeConnectionResult =
  | { ok: true; oldName: string; newName: string }
  | { ok: false; error: RenameNativeConnectionError };

/**
 * Rename the slot identifier on an existing native-MCP connection.
 * Returns `name-taken` when the user already holds another
 * connection with the same (provider, new-name) tuple,
 * `bad-name-shape` when the name fails the slug regex, `not-found`
 * when the row id doesn't belong to the workspace. Mirrors the
 * Composio rename — `name` is purely a TAS-local label, the OAuth
 * tokens stay attached to the same row.
 *
 * Caller is responsible for: (a) updating cached tool rows in
 * workspace_mcp_tool so the (provider, name) bucket stays in
 * sync, and (b) surfacing that any agent file referencing the old
 * name will fail at run time until its `connections:` field is
 * updated.
 */
export async function renameNativeConnection(
  workspaceId: string,
  connectionId: string,
  newName: string,
): Promise<RenameNativeConnectionResult> {
  const normalized = newName.trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(normalized)) {
    return { ok: false, error: "bad-name-shape" };
  }
  const existing = await getNativeConnectionById(workspaceId, connectionId);
  if (!existing) return { ok: false, error: "not-found" };
  if (existing.name === normalized) {
    return { ok: true, oldName: existing.name, newName: normalized };
  }
  const { rowCount: collision } = await db.query(
    `SELECT 1 FROM workspace_connection
       WHERE workspace_id = $1 AND user_id = $2
         AND type = $3 AND name = $4 AND id <> $5
       LIMIT 1`,
    [workspaceId, existing.userId, existing.type, normalized, connectionId],
  );
  if ((collision ?? 0) > 0) {
    return { ok: false, error: "name-taken" };
  }
  await db.query(
    `UPDATE workspace_connection
        SET name = $2, updated_at = NOW()
      WHERE id = $1`,
    [connectionId, normalized],
  );
  return { ok: true, oldName: existing.name, newName: normalized };
}

export async function deleteNativeConnection(
  workspaceId: string,
  id: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `DELETE FROM workspace_connection WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Flip a row's status (e.g., to 'stale' when the runner detects a
 * rejected token at run time). Symmetric to the Composio
 * mark-stale path in the Rust runner.
 */
export async function setNativeConnectionStatus(
  connectionId: string,
  status: NativeConnectionStatus,
): Promise<void> {
  await db.query(
    `UPDATE workspace_connection
        SET status = $2, updated_at = NOW()
      WHERE id = $1`,
    [connectionId, status],
  );
}

/**
 * Set (or clear, when `apiKey` is null/blank) the supplementary API key on a
 * native-MCP connection. Encrypted under the SAME AAD as the credentials blob,
 * stored in `aux_secret_ciphertext` — independent of the OAuth token, so a token
 * refresh never disturbs it. Returns false when the row isn't in the workspace.
 */
export async function setNativeConnectionAuxSecret(
  workspaceId: string,
  connectionId: string,
  apiKey: string | null,
): Promise<boolean> {
  const conn = await getNativeConnectionById(workspaceId, connectionId);
  if (!conn) return false;
  const trimmed = apiKey?.trim() || null;
  const ciphertext = trimmed
    ? encryptSecret(
        trimmed,
        aadNativeConnection(workspaceId, conn.userId, conn.type, conn.name),
      )
    : null;
  const { rowCount } = await db.query(
    `UPDATE workspace_connection
        SET aux_secret_ciphertext = $3, updated_at = NOW()
      WHERE id = $1 AND workspace_id = $2`,
    [connectionId, workspaceId, ciphertext],
  );
  return (rowCount ?? 0) > 0;
}
