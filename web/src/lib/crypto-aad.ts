import "server-only";

// Canonical AAD strings that bind a ciphertext to its row (#49). Passed to
// encryptSecret/decryptSecret; the same string must be used on both the
// encrypt and decrypt of a given row. For rows the Rust runtime also touches
// (workspace secrets, native connection credentials, native OAuth client
// secrets, Slack bot tokens, Twilio auth tokens), api/src/crypto.rs builds BYTE-IDENTICAL strings —
// keep the two in lockstep or those rows stop decrypting cross-language.
//
// Fields are joined with a unit separator (0x1f) so a value that happens to
// contain a separator-like character (':'/'|') can't be reshaped into a
// different context. UUIDs are the lowercase-hyphenated Postgres text form on
// both sides; `kind`/`type`/`slug`/`name` are passed through verbatim.
const SEP = "\x1f";

/** `workspace_secret` row, keyed by (workspace_id, kind). */
export function aadWorkspaceSecret(workspaceId: string, kind: string): string {
  return `workspace_secret${SEP}${workspaceId}${SEP}${kind}`;
}

/** `workspace_user_secret`, keyed by (workspace_id, user_id, kind). */
export function aadWorkspaceUserSecret(
  workspaceId: string,
  userId: string,
  kind: string,
): string {
  return `workspace_user_secret${SEP}${workspaceId}${SEP}${userId}${SEP}${kind}`;
}

/** Shared secret AAD stays byte-identical; personal secrets also bind owner. */
export function aadSecretConnection(
  workspaceId: string,
  slug: string,
  userId?: string | null,
): string {
  const shared = `secret_connection${SEP}${workspaceId}${SEP}${slug}`;
  return userId ? `${shared}${SEP}${userId}` : shared;
}

/** `workspace_connection` (native-MCP creds), keyed by its unique tuple. */
export function aadNativeConnection(
  workspaceId: string,
  userId: string,
  type: string,
  name: string,
): string {
  return `workspace_connection${SEP}${workspaceId}${SEP}${userId}${SEP}${type}${SEP}${name}`;
}

/** `workspace_native_oauth_client` row, keyed by (workspace_id, provider, instance). */
export function aadNativeOauthClient(
  workspaceId: string,
  provider: string,
  instance: string,
): string {
  return `native_oauth_client${SEP}${workspaceId}${SEP}${provider}${SEP}${instance}`;
}

/** A secret column on a `workspace_slack_app` row, keyed by (id, column). */
export function aadSlackSecret(slackAppId: string, column: string): string {
  return `slack_app${SEP}${slackAppId}${SEP}${column}`;
}

/** Twilio auth token on a `workspace_sms_channel` row, keyed by channel id. */
export function aadSmsSecret(smsChannelId: string): string {
  return `sms_channel${SEP}${smsChannelId}${SEP}auth_token`;
}

/** `workspace_webhook` token, keyed by (workspace_id, id). */
export function aadWebhookToken(workspaceId: string, id: string): string {
  return `webhook${SEP}${workspaceId}${SEP}${id}`;
}

/** `workspace_webhook` Svix signing secret, keyed by (workspace_id, id). */
export function aadWebhookSigningSecret(workspaceId: string, id: string): string {
  return `webhook_signing${SEP}${workspaceId}${SEP}${id}`;
}

/** `workspace_api_key` token, keyed by (workspace_id, id). */
export function aadApiKeyToken(workspaceId: string, id: string): string {
  return `api_key${SEP}${workspaceId}${SEP}${id}`;
}
