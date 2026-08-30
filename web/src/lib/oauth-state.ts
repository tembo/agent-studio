import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Signed state token for OAuth flows. The OAuth provider echoes the
// `state` value back unchanged on callback; we use it to (a) prove
// the callback request originated from our own /authorize step and
// (b) carry the workspace + connection-name context so the callback
// handler can store the credential against the right row.
//
// We sign with the BETTER_AUTH_SECRET — already present, already
// 32+ bytes of high-entropy randomness shared by the server side.

const SIG_LEN = 32; // sha-256 output

// OAuth / install state is short-lived: reject anything older than this so a
// leaked callback URL (referer, logs, history) can't be replayed indefinitely
// (#46). `iat` lives inside the HMAC-signed body, so it can't be forged.
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes — flows complete in seconds

function isStateFresh(iat: number): boolean {
  const now = Date.now();
  // Reject stale; tolerate small clock skew on the future side.
  return iat <= now + 60_000 && now - iat <= STATE_TTL_MS;
}

function getSecret(): Buffer {
  const raw = process.env.BETTER_AUTH_SECRET;
  if (!raw) {
    throw new Error(
      "BETTER_AUTH_SECRET is required to sign OAuth state tokens. " +
        "Generate one with: openssl rand -base64 32",
    );
  }
  return Buffer.from(raw, "utf8");
}

// Native-MCP OAuth state — for the v0.4 substrate that bypasses
// Composio and authenticates directly with a provider (Attio etc).
// Shape parallels ComposioStatePayload below; `provider` replaces
// `toolkit` because Composio's catalog and TAS's native-MCP catalog
// don't overlap by definition.

export type NativeMcpStatePayload = {
  workspaceId: string;
  workspaceSlug: string;
  /** Owner of the connection (the user who clicked Connect). */
  userId: string;
  /** Native-MCP provider slug from lib/mcp-providers. */
  provider: string;
  /** Workspace-scoped name slot for the connection. */
  connectionName: string;
  /** PKCE verifier (raw, base64url). The provider receives only the
   *  derived S256 challenge in the /authorize redirect; we present
   *  the verifier on the callback's token exchange to complete the
   *  PKCE proof. Embedded in the state because it never crosses
   *  our trust boundary — state is HMAC-signed and opaque to the
   *  provider. */
  pkceVerifier: string;
  /** OAuth client_id issued by Dynamic Client Registration. Reconnects reuse
   *  the connection's saved client so provider registration limits are not
   *  consumed for every new authorization grant. */
  clientId: string;
  /** Authorization server token endpoint, captured during
   *  discovery so the callback doesn't need to re-discover. */
  tokenEndpoint: string;
  /** OAuth client mode.
   *   - absent/"dcr": public client (PKCE only, no secret).
   *   - "manual": confidential BYO app — callback adds the admin-stored
   *     client_secret (client_secret_post) read by `instance`.
   *   - "dcr_confidential": the server's DCR issued a confidential client
   *     (it returned a client_secret); callback presents it via HTTP Basic.
   *     The secret rides in `clientSecretCiphertext` (encrypted), NOT plaintext —
   *     state is signed but readable, and the provider echoes it back. */
  authMode?: "dcr" | "manual" | "dcr_confidential";
  /** For manual providers: which BYO OAuth-app instance this flow used
   *  (slug in workspace_native_oauth_client). The callback re-reads the
   *  secret by this instance, and it's stored on the connection so refresh
   *  presents the right client_secret. Absent for DCR. */
  instance?: string;
  /** How to present the confidential client at the token endpoint.
   *  Zoom only supports client_secret_basic; HubSpot uses client_secret_post.
   *  Absent → client_secret_post (legacy default for manual). */
  tokenEndpointAuthMethod?: "client_secret_post" | "client_secret_basic";
  /** dcr_confidential only: the DCR-issued client_secret, AES-256-GCM encrypted
   *  (master key, AAD = the connection's native_connection AAD), base64. The
   *  callback decrypts it for the token exchange and persists it (encrypted) on
   *  the connection so refresh can present it. Never plaintext in the URL. */
  clientSecretCiphertext?: string;
  /** Instance-based providers only: the per-connection MCP server URL resolved
   *  from the operator-entered host. The callback stores it on the row (the
   *  catalog `mcpServerUrl` is empty) and trusts its origin (same-origin OAuth). */
  mcpServerUrl?: string;
  /** Short random nonce — defends against state replay across users. */
  nonce: string;
  /** Issued-at (epoch ms); states older than STATE_TTL_MS are rejected (#46). */
  iat: number;
};

export function signNativeMcpState(
  payload: Omit<NativeMcpStatePayload, "nonce" | "iat">,
): string {
  const full: NativeMcpStatePayload = {
    ...payload,
    nonce: randomBytes(8).toString("base64url"),
    iat: Date.now(),
  };
  const body = Buffer.from(JSON.stringify(full), "utf8");
  const sig = createHmac("sha256", getSecret()).update(body).digest();
  return Buffer.concat([body, sig]).toString("base64url");
}

export function verifyNativeMcpState(
  state: string,
): NativeMcpStatePayload | null {
  let combined: Buffer;
  try {
    combined = Buffer.from(state, "base64url");
  } catch {
    return null;
  }
  if (combined.length <= SIG_LEN) return null;
  const body = combined.subarray(0, combined.length - SIG_LEN);
  const sig = combined.subarray(combined.length - SIG_LEN);
  const expected = createHmac("sha256", getSecret()).update(body).digest();
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(sig, expected)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  if (!isNativeMcpStatePayload(parsed)) return null;
  if (!isStateFresh(parsed.iat)) return null;
  return parsed;
}

function isNativeMcpStatePayload(value: unknown): value is NativeMcpStatePayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.workspaceId === "string" &&
    typeof v.workspaceSlug === "string" &&
    typeof v.userId === "string" &&
    typeof v.provider === "string" &&
    typeof v.connectionName === "string" &&
    typeof v.pkceVerifier === "string" &&
    typeof v.clientId === "string" &&
    typeof v.tokenEndpoint === "string" &&
    typeof v.nonce === "string" &&
    typeof v.iat === "number"
  );
}

// Composio-flavored state. Separate from NativeMcpStatePayload because
// Composio gives us the connected_account_id at /authorize time (in
// the `link()` response), and we want to pass that opaque id through
// to the callback so we can `connectedAccounts.get(id)` it and only
// commit a row when the status reports ACTIVE.

export type ComposioStatePayload = {
  workspaceId: string;
  workspaceSlug: string;
  /** Owner of the connection (the user who clicked Connect). */
  userId: string;
  toolkit: string;
  /** Workspace-scoped name slot for the connection (e.g. "default", "work"). */
  connectionName: string;
  nonce: string;
  /** Issued-at (epoch ms); states older than STATE_TTL_MS are rejected (#46). */
  iat: number;
};

export function signComposioState(
  payload: Omit<ComposioStatePayload, "nonce" | "iat">,
): string {
  const full: ComposioStatePayload = {
    ...payload,
    nonce: randomBytes(8).toString("base64url"),
    iat: Date.now(),
  };
  const body = Buffer.from(JSON.stringify(full), "utf8");
  const sig = createHmac("sha256", getSecret()).update(body).digest();
  return Buffer.concat([body, sig]).toString("base64url");
}

export function verifyComposioState(state: string): ComposioStatePayload | null {
  let combined: Buffer;
  try {
    combined = Buffer.from(state, "base64url");
  } catch {
    return null;
  }
  if (combined.length <= SIG_LEN) return null;
  const body = combined.subarray(0, combined.length - SIG_LEN);
  const sig = combined.subarray(combined.length - SIG_LEN);
  const expected = createHmac("sha256", getSecret()).update(body).digest();
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(sig, expected)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  if (!isComposioStatePayload(parsed)) return null;
  if (!isStateFresh(parsed.iat)) return null;
  return parsed;
}

function isComposioStatePayload(value: unknown): value is ComposioStatePayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.workspaceId === "string" &&
    typeof v.workspaceSlug === "string" &&
    typeof v.userId === "string" &&
    typeof v.toolkit === "string" &&
    typeof v.connectionName === "string" &&
    typeof v.nonce === "string" &&
    typeof v.iat === "number"
  );
}

// Slack "Add to Slack" install state — proves the callback came from our
// own /install step and carries which workspace_slack_app row (+ its
// workspace) the resulting bot token should be stored against.

export type SlackInstallStatePayload = {
  /** Our workspace_slack_app row id. */
  slackAppId: string;
  workspaceId: string;
  workspaceSlug: string;
  nonce: string;
  /** Issued-at (epoch ms); states older than STATE_TTL_MS are rejected (#46). */
  iat: number;
};

export function signSlackInstallState(
  payload: Omit<SlackInstallStatePayload, "nonce" | "iat">,
): string {
  const full: SlackInstallStatePayload = {
    ...payload,
    nonce: randomBytes(8).toString("base64url"),
    iat: Date.now(),
  };
  const body = Buffer.from(JSON.stringify(full), "utf8");
  const sig = createHmac("sha256", getSecret()).update(body).digest();
  return Buffer.concat([body, sig]).toString("base64url");
}

export function verifySlackInstallState(
  state: string,
): SlackInstallStatePayload | null {
  let combined: Buffer;
  try {
    combined = Buffer.from(state, "base64url");
  } catch {
    return null;
  }
  if (combined.length <= SIG_LEN) return null;
  const body = combined.subarray(0, combined.length - SIG_LEN);
  const sig = combined.subarray(combined.length - SIG_LEN);
  const expected = createHmac("sha256", getSecret()).update(body).digest();
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(sig, expected)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  if (!isSlackInstallStatePayload(parsed)) return null;
  if (!isStateFresh(parsed.iat)) return null;
  return parsed;
}

function isSlackInstallStatePayload(
  value: unknown,
): value is SlackInstallStatePayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.slackAppId === "string" &&
    typeof v.workspaceId === "string" &&
    typeof v.workspaceSlug === "string" &&
    typeof v.nonce === "string" &&
    typeof v.iat === "number"
  );
}
