//! Minimal workspace queries needed by the runtime — secret lookup only.
//! The web layer owns the full CRUD surface; this stays narrow.

use anyhow::{anyhow, Context};
use sqlx::PgPool;

use crate::crypto::MasterKey;

#[derive(Debug, Clone, Copy)]
pub enum SecretKind {
    AnthropicApiKey,
    OpenAiApiKey,
    ComposioApiKey,
    ScaleDownApiKey,
}

impl SecretKind {
    fn as_db_str(self) -> &'static str {
        match self {
            SecretKind::AnthropicApiKey => "anthropic_api_key",
            SecretKind::OpenAiApiKey => "openai_api_key",
            SecretKind::ComposioApiKey => "composio_api_key",
            SecretKind::ScaleDownApiKey => "scaledown_api_key",
        }
    }
}

/// (toolkit_slug, name, composio_connection_id) tuples for the
/// ACTIVE connections owned by a specific user in a workspace.
/// The Pydantic runner serializes this into the nested JSON
/// `{toolkit: {name: connection_id}}` so the Python wrapper can
/// pin the right Composio session connections per declared
/// (toolkit, name) pair on the agent spec.
pub async fn list_active_composio_connections(
    pool: &PgPool,
    workspace_id: uuid::Uuid,
    user_id: &str,
) -> anyhow::Result<Vec<(String, String, String)>> {
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT toolkit_slug, name, composio_connection_id \
           FROM workspace_composio_connection \
          WHERE workspace_id = $1 AND user_id = $2 AND status = 'ACTIVE'",
    )
    .bind(workspace_id)
    .bind(user_id)
    .fetch_all(pool)
    .await
    .context("failed to list workspace_composio_connection")?;
    Ok(rows)
}

/// One resolved native-MCP connection slot ready for the Python
/// wrapper: the provider's MCP endpoint and the decrypted bearer
/// token the wrapper will set as `Authorization: Bearer …` on the
/// MCPServerStreamableHTTP transport.
#[derive(Debug, Clone)]
pub struct NativeMcpRow {
    pub provider: String,
    pub name: String,
    pub mcp_url: String,
    pub access_token: String,
    /// Optional supplementary API key the user attached to this connection (for
    /// privileged REST ops the MCP OAuth token can't do, e.g. Attio note/delete).
    /// `None` when unset; surfaced to the runtime as `tas_tools.connection().api_key`.
    pub api_key: Option<String>,
}

/// Decrypted native-MCP connections owned by a specific user in a
/// workspace. The runner serializes these into nested JSON
/// `{provider: {name: {mcp_url, access_token}}}` so the Python
/// wrapper can build one MCPServerStreamableHTTP per declared
/// (provider, name) pair without doing its own DB work or carrying
/// the encryption key.
///
/// Rows whose credentials fail to decrypt or whose plaintext isn't
/// the expected JSON shape are dropped with a warning rather than
/// killing the whole run — the worst case is the wrapper later
/// reports "connection missing" for that slot, which is the same
/// outcome as if the user never authorized it.
pub async fn list_active_native_connections(
    pool: &PgPool,
    key: &MasterKey,
    workspace_id: uuid::Uuid,
    user_id: &str,
) -> anyhow::Result<Vec<NativeMcpRow>> {
    let rows: Vec<(String, String, Option<String>, Vec<u8>, Option<Vec<u8>>)> = sqlx::query_as(
        "SELECT type, name, mcp_server_url, credentials, aux_secret_ciphertext \
           FROM workspace_connection \
          WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'",
    )
    .bind(workspace_id)
    .bind(user_id)
    .fetch_all(pool)
    .await
    .context("failed to list workspace_connection")?;

    let mut out = Vec::with_capacity(rows.len());
    for (provider, name, mcp_url, ciphertext, aux_ciphertext) in rows {
        let mcp_url = match mcp_url {
            Some(u) if !u.is_empty() => u,
            _ => {
                tracing::warn!(%provider, %name, "skipping native connection with no mcp_server_url");
                continue;
            }
        };
        let aad = crate::crypto::aad::native_connection(workspace_id, user_id, &provider, &name);
        let plaintext = match key.decrypt_aad(&ciphertext, aad.as_bytes()) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(?e, %provider, %name, "skipping native connection: decrypt failed");
                continue;
            }
        };
        let parsed: serde_json::Value = match serde_json::from_str(&plaintext) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(?e, %provider, %name, "skipping native connection: credentials not JSON");
                continue;
            }
        };
        let access_token = match parsed.get("access_token").and_then(|v| v.as_str()) {
            Some(t) if !t.is_empty() => t.to_string(),
            _ => {
                tracing::warn!(%provider, %name, "skipping native connection: no access_token in credentials");
                continue;
            }
        };
        // Optional supplementary API key, encrypted under the SAME AAD as
        // credentials. A decrypt failure is non-fatal: drop just the aux key (the
        // connection still works for everything the OAuth token covers).
        let api_key = aux_ciphertext.and_then(|ct| {
            match key.decrypt_aad(&ct, aad.as_bytes()) {
                Ok(s) if !s.is_empty() => Some(s),
                Ok(_) => None,
                Err(e) => {
                    tracing::warn!(?e, %provider, %name, "native connection aux key failed to decrypt; ignoring");
                    None
                }
            }
        });
        out.push(NativeMcpRow {
            provider,
            name,
            mcp_url,
            access_token,
            api_key,
        });
    }
    Ok(out)
}

/// Decrypted free-form secrets visible to an acting user. A personal value wins
/// when its slug matches a workspace-shared fallback. The runner serializes these
/// into a flat `{slug: value}` JSON and hands it to the wrapper as TAS_SECRETS,
/// where sidecar tools read it via `tas_tools.secret("<slug>")`.
///
/// Rows whose ciphertext fails to decrypt are dropped with a warning rather
/// than failing the run — the tool then raises a clear "secret not set" error.
pub async fn list_workspace_secret_connections(
    pool: &PgPool,
    key: &MasterKey,
    workspace_id: uuid::Uuid,
    acting_user_id: &str,
) -> anyhow::Result<Vec<(String, String)>> {
    let rows: Vec<(String, Vec<u8>, Option<String>)> = sqlx::query_as(
        "SELECT DISTINCT ON (slug) slug, ciphertext, user_id \
           FROM workspace_secret_connection \
          WHERE workspace_id = $1 \
            AND (user_id IS NULL OR user_id = $2) \
          ORDER BY slug, (user_id IS NOT NULL) DESC",
    )
    .bind(workspace_id)
    .bind(acting_user_id)
    .fetch_all(pool)
    .await
    .context("failed to list workspace_secret_connection")?;

    let mut out = Vec::with_capacity(rows.len());
    for (slug, ciphertext, user_id) in rows {
        let aad = crate::crypto::aad::secret_connection(workspace_id, &slug, user_id.as_deref());
        match key.decrypt_aad(&ciphertext, aad.as_bytes()) {
            Ok(value) => out.push((slug, value)),
            Err(e) => {
                tracing::warn!(?e, %slug, "skipping secret: decrypt failed")
            }
        }
    }
    Ok(out)
}

/// Returns the decrypted plaintext for a workspace secret. Mirrors the
/// TS-side `getWorkspaceSecretPlaintext` — the web app encrypts on save,
/// the runtime decrypts on use.
pub async fn get_workspace_secret_plaintext(
    pool: &PgPool,
    key: &MasterKey,
    workspace_id: uuid::Uuid,
    kind: SecretKind,
) -> anyhow::Result<String> {
    let row: Option<(Vec<u8>,)> = sqlx::query_as(
        "SELECT ciphertext FROM workspace_secret \
         WHERE workspace_id = $1 AND kind = $2",
    )
    .bind(workspace_id)
    .bind(kind.as_db_str())
    .fetch_optional(pool)
    .await
    .context("failed to read workspace_secret")?;

    let ciphertext = row
        .ok_or_else(|| anyhow!("workspace secret {} not set", kind.as_db_str()))?
        .0;
    key.decrypt_aad(
        &ciphertext,
        crate::crypto::aad::workspace_secret(workspace_id, kind.as_db_str()).as_bytes(),
    )
}
