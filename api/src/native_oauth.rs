//! Lazy refresh of native-MCP OAuth access tokens, run by the runner
//! just before it reads tokens for a run.
//!
//! The web layer mints tokens at authorize time (and on a manual
//! "Reconnect") but has no refresh path. Native-MCP access tokens are
//! short-lived (Attio's are hours), so without this an expired token
//! reaches the agent and the run dies with a 401 — after which the
//! existing stale-marking path flips the connection to 'stale' and the
//! user has to reconnect by hand.
//!
//! Providers that support the `offline_access` scope (Attio does, and
//! TAS requests it) hand back a `refresh_token` at authorize time,
//! which we stored in the encrypted credentials blob. Here we spend it
//! for a fresh access token via `grant_type=refresh_token` and persist
//! the result in the exact shape the web `saveNativeConnection`
//! writes: the encrypted credentials JSON plus the denormalized
//! `token_expires_at` column.
//!
//! Everything is per-connection: retryable transport, rate-limit, and
//! provider failures leave the connection active and record a bounded retry;
//! revoked grants and client/configuration failures move it to an actionable
//! stale state. Concurrent runs serialize refreshes so rotating tokens are
//! spent and persisted exactly once.

use anyhow::{anyhow, Context};
use chrono::{DateTime, Duration, Utc};
use reqwest::StatusCode;
use serde::Deserialize;
use sqlx::PgPool;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::Duration as StdDuration;

use crate::crypto::MasterKey;

/// Refresh tokens already expired or within this window of expiring,
/// so a token can't die mid-run between the sweep and the agent's
/// first tool call.
const REFRESH_SKEW_SECS: i64 = 120;
const MAX_REFRESH_ATTEMPTS: usize = 3;
const REFRESH_RETRY_BASE_MILLIS: u64 = 150;

// The (mcp_server_url origin → allowed OAuth authorization-server origins)
// allowlist lives in native_oauth_allowlist.rs, GENERATED from the web catalog
// (web/src/lib/mcp-providers.ts) by web/scripts/gen-native-oauth-allowlist.ts.
// Never edit it by hand — regenerate with `npm run gen:allowlist` in web/.
use crate::native_oauth_allowlist::NATIVE_MCP_OAUTH_ALLOWLIST;

#[derive(Deserialize)]
struct ProtectedResourceMeta {
    authorization_servers: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct AuthServerMeta {
    token_endpoint: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    scope: Option<String>,
    token_type: Option<String>,
}

#[derive(Deserialize, Default)]
struct OAuthErrorResponse {
    error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RefreshFailureKind {
    Temporary,
    Reconnect,
    Revoked,
}

#[derive(Debug)]
struct RefreshFailure {
    kind: RefreshFailureKind,
    code: &'static str,
    message: &'static str,
    diagnostic: String,
}

impl RefreshFailure {
    fn temporary(code: &'static str, message: &'static str, diagnostic: impl Into<String>) -> Self {
        Self {
            kind: RefreshFailureKind::Temporary,
            code,
            message,
            diagnostic: diagnostic.into(),
        }
    }

    fn reconnect(code: &'static str, message: &'static str, diagnostic: impl Into<String>) -> Self {
        Self {
            kind: RefreshFailureKind::Reconnect,
            code,
            message,
            diagnostic: diagnostic.into(),
        }
    }

    fn revoked(diagnostic: impl Into<String>) -> Self {
        Self {
            kind: RefreshFailureKind::Revoked,
            code: "refresh_token_rejected",
            message: "The authorization was revoked or expired. Reconnect this account.",
            diagnostic: diagnostic.into(),
        }
    }
}

fn retry_delay(attempt: usize) -> StdDuration {
    StdDuration::from_millis(REFRESH_RETRY_BASE_MILLIS * (1_u64 << attempt.min(4)))
}

fn refresh_is_due(
    status: &str,
    expires_at: Option<DateTime<Utc>>,
    retry_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
    threshold: DateTime<Utc>,
) -> bool {
    let retry_allowed = retry_at.is_none_or(|retry| retry <= now)
        || expires_at.is_some_and(|expires| expires <= now);
    status == "active" && expires_at.is_some_and(|expires| expires < threshold) && retry_allowed
}

fn classify_refresh_rejection(status: StatusCode, oauth_error: Option<&str>) -> RefreshFailure {
    if status == StatusCode::REQUEST_TIMEOUT
        || status == StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
    {
        return RefreshFailure::temporary(
            "refresh_temporarily_unavailable",
            "The authorization service is temporarily unavailable. Token refresh will retry automatically.",
            format!("token endpoint returned {status}"),
        );
    }
    match oauth_error {
        Some("invalid_grant") => RefreshFailure::revoked("token endpoint returned invalid_grant"),
        Some("unsupported_grant_type") => RefreshFailure::reconnect(
            "refresh_not_supported",
            "This authorization no longer supports token refresh. Reconnect this account.",
            "token endpoint returned unsupported_grant_type",
        ),
        Some("invalid_client") | Some("unauthorized_client") => RefreshFailure::reconnect(
            "oauth_client_rejected",
            "The OAuth application was rejected. Check its configuration, then reconnect this account.",
            format!("token endpoint returned {}", oauth_error.unwrap_or("invalid_client")),
        ),
        _ => RefreshFailure::reconnect(
            "refresh_rejected",
            "The authorization service rejected token refresh. Reconnect this account.",
            format!("token endpoint returned {status}"),
        ),
    }
}

/// Refresh every active oauth2 native connection for this (workspace, user)
/// whose token is at/near expiry. Connections are serialized with a
/// transaction-scoped advisory lock so two simultaneous runs cannot spend the
/// same rotating refresh token.
pub async fn refresh_expiring_native_connections(
    pool: &PgPool,
    key: &MasterKey,
    http: &reqwest::Client,
    workspace_id: uuid::Uuid,
    user_id: &str,
) -> anyhow::Result<()> {
    let threshold = Utc::now() + Duration::seconds(REFRESH_SKEW_SECS);
    let ids: Vec<(uuid::Uuid,)> = sqlx::query_as(
        "SELECT id \
           FROM workspace_connection \
          WHERE workspace_id = $1 AND user_id = $2 \
            AND status = 'active' AND auth_type = 'oauth2' \
            AND token_expires_at IS NOT NULL \
            AND token_expires_at < $3 \
            AND (refresh_retry_at IS NULL OR refresh_retry_at <= now() \
                 OR token_expires_at <= now())",
    )
    .bind(workspace_id)
    .bind(user_id)
    .bind(threshold)
    .fetch_all(pool)
    .await
    .context("failed to list native connections for refresh")?;

    for (id,) in ids {
        refresh_connection(pool, key, http, workspace_id, user_id, id, threshold).await?;
    }
    Ok(())
}

type RefreshRow = (
    String,
    String,
    Option<String>,
    Vec<u8>,
    serde_json::Value,
    String,
    Option<DateTime<Utc>>,
    Option<DateTime<Utc>>,
);

async fn refresh_connection(
    pool: &PgPool,
    key: &MasterKey,
    http: &reqwest::Client,
    workspace_id: uuid::Uuid,
    user_id: &str,
    id: uuid::Uuid,
    threshold: DateTime<Utc>,
) -> anyhow::Result<()> {
    let mut lock_tx = pool
        .begin()
        .await
        .context("begin refresh lock transaction")?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(id.to_string())
        .execute(&mut *lock_tx)
        .await
        .context("lock native connection refresh")?;

    let row: Option<RefreshRow> = sqlx::query_as(
        "SELECT type, name, mcp_server_url, credentials, metadata, status, \
                token_expires_at, refresh_retry_at \
           FROM workspace_connection \
          WHERE id = $1 AND workspace_id = $2 AND user_id = $3",
    )
    .bind(id)
    .bind(workspace_id)
    .bind(user_id)
    .fetch_optional(&mut *lock_tx)
    .await
    .context("reload native connection for refresh")?;

    let Some((provider, name, mcp_url, ciphertext, metadata, status, expires_at, retry_at)) = row
    else {
        lock_tx.commit().await?;
        return Ok(());
    };
    let now = Utc::now();
    let due = refresh_is_due(&status, expires_at, retry_at, now, threshold);
    if !due {
        lock_tx.commit().await?;
        return Ok(());
    }

    match refresh_one(
        pool,
        key,
        http,
        workspace_id,
        user_id,
        id,
        &provider,
        &name,
        &mcp_url,
        &ciphertext,
        &metadata,
    )
    .await
    {
        Ok(()) => tracing::info!(%provider, %name, "refreshed native MCP token before run"),
        Err(failure) => {
            record_refresh_failure(pool, id, &failure).await?;
            tracing::warn!(
                provider,
                name,
                error_code = failure.code,
                diagnostic = failure.diagnostic,
                "native MCP token refresh failed"
            );
        }
    }
    lock_tx
        .commit()
        .await
        .context("release native refresh lock")?;
    Ok(())
}

async fn record_refresh_failure(
    pool: &PgPool,
    id: uuid::Uuid,
    failure: &RefreshFailure,
) -> anyhow::Result<()> {
    let status = match failure.kind {
        RefreshFailureKind::Temporary => "active",
        RefreshFailureKind::Reconnect => "stale",
        RefreshFailureKind::Revoked => "revoked",
    };
    let retry_at =
        (failure.kind == RefreshFailureKind::Temporary).then(|| Utc::now() + Duration::seconds(30));
    sqlx::query(
        "UPDATE workspace_connection \
            SET status = $2, refresh_error_code = $3, refresh_error_message = $4, \
                refresh_error_at = now(), refresh_failure_count = refresh_failure_count + 1, \
                refresh_retry_at = $5, updated_at = now() \
          WHERE id = $1",
    )
    .bind(id)
    .bind(status)
    .bind(failure.code)
    .bind(failure.message)
    .bind(retry_at)
    .execute(pool)
    .await
    .context("persist native refresh failure")?;
    Ok(())
}

#[allow(clippy::too_many_arguments)] // one row's worth of refresh inputs
async fn refresh_one(
    pool: &PgPool,
    key: &MasterKey,
    http: &reqwest::Client,
    workspace_id: uuid::Uuid,
    user_id: &str,
    id: uuid::Uuid,
    provider: &str,
    name: &str,
    mcp_url: &Option<String>,
    ciphertext: &[u8],
    metadata: &serde_json::Value,
) -> Result<(), RefreshFailure> {
    let mcp_url = mcp_url
        .as_deref()
        .filter(|u| !u.is_empty())
        .ok_or_else(|| {
            RefreshFailure::reconnect(
                "connection_configuration_invalid",
                "This connection is missing its service URL. Reconnect this account.",
                "connection has no mcp_server_url",
            )
        })?;

    let conn_aad = crate::crypto::aad::native_connection(workspace_id, user_id, provider, name);
    let plaintext = key
        .decrypt_aad(ciphertext, conn_aad.as_bytes())
        .map_err(|_| {
            RefreshFailure::reconnect(
                "stored_credentials_invalid",
                "Stored authorization data could not be read. Reconnect this account.",
                "decrypt credentials failed",
            )
        })?;
    let creds: serde_json::Value = serde_json::from_str(&plaintext).map_err(|_| {
        RefreshFailure::reconnect(
            "stored_credentials_invalid",
            "Stored authorization data could not be read. Reconnect this account.",
            "credentials are not valid JSON",
        )
    })?;
    let refresh_token = creds
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            RefreshFailure::reconnect(
                "refresh_token_missing",
                "This authorization cannot renew automatically. Reconnect this account to grant offline access.",
                "no refresh_token stored",
            )
        })?;
    // The client identity the refresh exchange presents:
    //  - manual (HubSpot): BYO client_id + client_secret from
    //    workspace_native_oauth_client → client_secret_post by default, or
    //    HTTP Basic when metadata says token_endpoint_auth_method=client_secret_basic
    //    (Zoom only advertises Basic).
    //  - dcr_confidential (Avoma): client_id + client_secret stored IN the
    //    credentials blob (no per-workspace app) → HTTP Basic.
    //  - dcr (public): a `dcr_client_id`, no secret.
    let auth_mode = metadata.get("auth_mode").and_then(|v| v.as_str());
    let (client_id, client_secret, use_basic): (String, Option<String>, bool) = match auth_mode {
        Some("manual") => {
            // Which BYO app instance this connection authorized against. Older
            // rows (pre multi-instance) have no `instance` → fall back to
            // "default", which is where their single app was migrated.
            let instance = metadata
                .get("instance")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("default");
            let (cid, secret) = native_oauth_client_secret(
                pool,
                key,
                workspace_id,
                provider,
                instance,
            )
            .await
            .map_err(|_| {
                RefreshFailure::reconnect(
                    "oauth_client_missing",
                    "The OAuth application is no longer configured. Restore it, then reconnect this account.",
                    "workspace OAuth client is missing or unreadable",
                )
            })?;
            let basic = metadata
                .get("token_endpoint_auth_method")
                .and_then(|v| v.as_str())
                == Some("client_secret_basic");
            (cid, Some(secret), basic)
        }
        Some("dcr_confidential") => {
            let cid = creds
                .get("client_id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    RefreshFailure::reconnect(
                        "stored_credentials_invalid",
                        "Stored authorization data is incomplete. Reconnect this account.",
                        "dcr_confidential connection has no client_id",
                    )
                })?
                .to_string();
            let secret = creds
                .get("client_secret")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    RefreshFailure::reconnect(
                        "stored_credentials_invalid",
                        "Stored authorization data is incomplete. Reconnect this account.",
                        "dcr_confidential connection has no client_secret",
                    )
                })?
                .to_string();
            (cid, Some(secret), true)
        }
        _ => {
            let cid = metadata
                .get("dcr_client_id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    RefreshFailure::reconnect(
                        "stored_credentials_invalid",
                        "Stored authorization data is incomplete. Reconnect this account.",
                        "connection metadata has no dcr_client_id",
                    )
                })?
                .to_string();
            (cid, None, false)
        }
    };

    let instance_based = metadata
        .get("instance_based")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let token_endpoint = discover_token_endpoint(http, mcp_url, instance_based)
        .await
        .map_err(|_| {
            RefreshFailure::temporary(
                "oauth_discovery_failed",
                "The authorization service could not be reached. Token refresh will retry automatically.",
                "OAuth endpoint discovery failed",
            )
        })?;

    let mut form: Vec<(&str, &str)> = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", client_id.as_str()),
    ];
    // Confidential client auth: dcr_confidential uses HTTP Basic; manual uses
    // client_secret_post unless provider metadata requires Basic. Retry only
    // transport/429/5xx failures; OAuth rejections are deterministic.
    if let Some(ref secret) = client_secret {
        if !use_basic {
            form.push(("client_secret", secret.as_str()));
        }
    }
    let res = {
        let mut successful = None;
        let mut last_failure = None;
        for attempt in 0..MAX_REFRESH_ATTEMPTS {
            let mut req = http
                .post(token_endpoint.clone())
                .header("Accept", "application/json");
            if use_basic {
                if let Some(ref secret) = client_secret {
                    req = req.basic_auth(client_id.as_str(), Some(secret.as_str()));
                }
            }
            match req.form(&form).send().await {
                Ok(response) if response.status().is_success() => {
                    successful = Some(response);
                    break;
                }
                Ok(response) => {
                    let status = response.status();
                    let oauth_error = response
                        .json::<OAuthErrorResponse>()
                        .await
                        .ok()
                        .and_then(|body| body.error);
                    let failure = classify_refresh_rejection(status, oauth_error.as_deref());
                    if failure.kind != RefreshFailureKind::Temporary
                        || attempt + 1 == MAX_REFRESH_ATTEMPTS
                    {
                        return Err(failure);
                    }
                    last_failure = Some(failure);
                }
                Err(_) => {
                    let failure = RefreshFailure::temporary(
                        "refresh_temporarily_unavailable",
                        "The authorization service is temporarily unavailable. Token refresh will retry automatically.",
                        "token refresh request failed",
                    );
                    if attempt + 1 == MAX_REFRESH_ATTEMPTS {
                        return Err(failure);
                    }
                    last_failure = Some(failure);
                }
            }
            tokio::time::sleep(retry_delay(attempt)).await;
        }
        successful.ok_or_else(|| {
            last_failure.unwrap_or_else(|| {
                RefreshFailure::temporary(
                    "refresh_temporarily_unavailable",
                    "The authorization service is temporarily unavailable. Token refresh will retry automatically.",
                    "token refresh exhausted retries",
                )
            })
        })?
    };

    let token: TokenResponse = res.json().await.map_err(|_| {
        RefreshFailure::temporary(
            "refresh_response_invalid",
            "The authorization service returned an invalid response. Token refresh will retry automatically.",
            "refresh response was not valid JSON",
        )
    })?;
    let (new_creds, expires_at) = merge_refreshed_credentials(&creds, token, Utc::now())?;
    let blob = key
        .encrypt_aad(&new_creds.to_string(), conn_aad.as_bytes())
        .map_err(|_| {
            RefreshFailure::temporary(
                "refresh_storage_failed",
                "The refreshed authorization could not be stored. Token refresh will retry automatically.",
                "encrypt refreshed credentials failed",
            )
        })?;

    sqlx::query(
        "UPDATE workspace_connection \
            SET credentials = $1, token_expires_at = $2, \
                status = 'active', refresh_error_code = NULL, \
                refresh_error_message = NULL, refresh_error_at = NULL, \
                refresh_failure_count = 0, refresh_retry_at = NULL, \
                updated_at = now() \
          WHERE id = $3",
    )
    .bind(blob)
    .bind(expires_at)
    .bind(id)
    .execute(pool)
    .await
    .map_err(|_| {
        RefreshFailure::temporary(
            "refresh_storage_failed",
            "The refreshed authorization could not be stored. Token refresh will retry automatically.",
            "persist refreshed credentials failed",
        )
    })?;

    Ok(())
}

fn merge_refreshed_credentials(
    current: &serde_json::Value,
    token: TokenResponse,
    now: DateTime<Utc>,
) -> Result<(serde_json::Value, Option<DateTime<Utc>>), RefreshFailure> {
    let mut merged = current.as_object().cloned().ok_or_else(|| {
        RefreshFailure::reconnect(
            "stored_credentials_invalid",
            "Stored authorization data could not be read. Reconnect this account.",
            "credentials are not a JSON object",
        )
    })?;
    let access_token = token
        .access_token
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            RefreshFailure::temporary(
                "refresh_response_invalid",
                "The authorization service returned an invalid response. Token refresh will retry automatically.",
                "refresh response had no access_token",
            )
        })?;
    merged.insert(
        "access_token".to_string(),
        serde_json::Value::String(access_token),
    );
    if let Some(refresh_token) = token.refresh_token.filter(|value| !value.is_empty()) {
        merged.insert(
            "refresh_token".to_string(),
            serde_json::Value::String(refresh_token),
        );
    }
    if let Some(scope) = token.scope {
        merged.insert("scope".to_string(), serde_json::Value::String(scope));
    }
    if let Some(token_type) = token.token_type {
        merged.insert(
            "token_type".to_string(),
            serde_json::Value::String(token_type),
        );
    }
    let expires_at = token
        .expires_in
        .map(|seconds| now + Duration::seconds(seconds));
    if let Some(expires_at) = expires_at {
        merged.insert(
            "expires_at".to_string(),
            serde_json::Value::String(expires_at.to_rfc3339()),
        );
    } else {
        merged.remove("expires_at");
    }
    Ok((serde_json::Value::Object(merged), expires_at))
}

/// Read + decrypt the bring-your-own OAuth client (client_id + client_secret)
/// an admin stored for a confidential native-MCP provider (HubSpot). Errors if
/// the app isn't configured (the connection can't be refreshed without it).
async fn native_oauth_client_secret(
    pool: &PgPool,
    key: &MasterKey,
    workspace_id: uuid::Uuid,
    provider: &str,
    instance: &str,
) -> anyhow::Result<(String, String)> {
    let row: Option<(String, Vec<u8>)> = sqlx::query_as(
        "SELECT client_id, client_secret_ciphertext FROM workspace_native_oauth_client \
           WHERE workspace_id = $1 AND provider = $2 AND instance = $3",
    )
    .bind(workspace_id)
    .bind(provider)
    .bind(instance)
    .fetch_optional(pool)
    .await
    .context("failed to read workspace_native_oauth_client")?;
    let (client_id, ciphertext) = row.ok_or_else(|| {
        anyhow!("no OAuth app \"{instance}\" configured for native provider {provider}")
    })?;
    let secret = key
        .decrypt_aad(
            &ciphertext,
            crate::crypto::aad::native_oauth_client(workspace_id, provider, instance).as_bytes(),
        )
        .context("decrypt client_secret")?;
    Ok((client_id, secret))
}

/// Resolve a provider's token endpoint from its MCP URL via the same
/// two-hop discovery the web authorize route uses: the resource
/// server's protected-resource metadata points at an authorization
/// server, whose metadata carries the token endpoint. We rediscover
/// each refresh rather than storing the endpoint, so it stays correct
/// without a migration or re-auth for already-connected rows.
async fn discover_token_endpoint(
    http: &reqwest::Client,
    mcp_url: &str,
    instance_based: bool,
) -> anyhow::Result<reqwest::Url> {
    let mcp_url = parse_trusted_https_url(mcp_url, "mcp_server_url")?;
    assert_public_endpoint_host(&mcp_url, "mcp_server_url").await?;
    let origin = mcp_url.origin().ascii_serialization();
    // Fixed providers: compile-time allowlist. Instance-based (self-hosted, e.g.
    // Metabase): same-origin — OAuth endpoints must live on the connection's own
    // origin (validated at Connect time; still SSRF-guarded above + below).
    let instance_origins = [origin.as_str()];
    let allowed_oauth_origins: &[&str] = if instance_based {
        &instance_origins
    } else {
        allowed_oauth_origins_for_mcp_origin(&origin).ok_or_else(|| {
            anyhow!("mcp_server_url origin is not in the native-MCP provider allowlist")
        })?
    };

    // RFC 9728: protected-resource metadata lives at the origin — but some
    // servers (Gmail) serve it only PATH-SUFFIXED with the resource path and
    // 404 at the bare origin. Try the origin first (all DCR providers), then the
    // suffixed form derived from the MCP URL's path.
    let mut pr_candidates = vec![format!("{origin}/.well-known/oauth-protected-resource")];
    let res_path = mcp_url.path().trim_end_matches('/');
    if !res_path.is_empty() {
        pr_candidates.push(format!(
            "{origin}/.well-known/oauth-protected-resource{res_path}"
        ));
    }
    let mut pr: Option<ProtectedResourceMeta> = None;
    let mut last_err: Option<anyhow::Error> = None;
    for cand in &pr_candidates {
        let url = match reqwest::Url::parse(cand) {
            Ok(u) => u,
            Err(e) => {
                last_err = Some(anyhow!(e).context("bad protected-resource metadata URL"));
                continue;
            }
        };
        match http
            .get(url)
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(resp) => match resp.error_for_status() {
                Ok(ok) => match ok.json::<ProtectedResourceMeta>().await {
                    Ok(meta) => {
                        pr = Some(meta);
                        break;
                    }
                    Err(e) => {
                        last_err = Some(anyhow!(e).context("protected-resource metadata not JSON"))
                    }
                },
                Err(e) => {
                    last_err = Some(anyhow!(e).context("protected-resource discovery error status"))
                }
            },
            Err(e) => last_err = Some(anyhow!(e).context("protected-resource discovery failed")),
        }
    }
    let pr = pr.ok_or_else(|| {
        last_err.unwrap_or_else(|| anyhow!("protected-resource discovery failed"))
    })?;

    let as_base_raw = pr
        .authorization_servers
        .and_then(|v| v.into_iter().next())
        .ok_or_else(|| anyhow!("no authorization_servers in protected-resource metadata"))?;
    let as_base = parse_trusted_oauth_url(
        &as_base_raw,
        allowed_oauth_origins,
        "authorization server URL",
    )?;
    assert_public_endpoint_host(&as_base, "authorization server URL").await?;

    let mut as_meta_url = as_base;
    as_meta_url.set_path("/.well-known/oauth-authorization-server");
    as_meta_url.set_query(None);
    as_meta_url.set_fragment(None);
    let asm: AuthServerMeta = http
        .get(as_meta_url)
        .header("Accept", "application/json")
        .send()
        .await
        .context("authorization-server discovery failed")?
        .error_for_status()
        .context("authorization-server discovery returned an error status")?
        .json()
        .await
        .context("authorization-server metadata not JSON")?;

    let token_endpoint = asm
        .token_endpoint
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("authorization-server metadata missing token_endpoint"))?;
    let token_endpoint =
        parse_trusted_oauth_url(&token_endpoint, allowed_oauth_origins, "token endpoint")?;
    assert_public_endpoint_host(&token_endpoint, "token endpoint").await?;
    Ok(token_endpoint)
}

fn allowed_oauth_origins_for_mcp_origin(origin: &str) -> Option<&'static [&'static str]> {
    NATIVE_MCP_OAUTH_ALLOWLIST
        .iter()
        .find(|(mcp_origin, _)| *mcp_origin == origin)
        .map(|(_, oauth_origins)| *oauth_origins)
}

fn parse_trusted_oauth_url(
    raw_url: &str,
    allowed_origins: &[&str],
    label: &str,
) -> anyhow::Result<reqwest::Url> {
    let url = parse_trusted_https_url(raw_url, label)?;
    let origin = url.origin().ascii_serialization();
    if !allowed_origins.iter().any(|allowed| *allowed == origin) {
        return Err(anyhow!("{label} is not on an allowed provider origin"));
    }
    Ok(url)
}

fn parse_trusted_https_url(raw_url: &str, label: &str) -> anyhow::Result<reqwest::Url> {
    let url =
        reqwest::Url::parse(raw_url).with_context(|| format!("{label} is not a valid URL"))?;
    if url.scheme() != "https" {
        return Err(anyhow!("{label} must use https"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(anyhow!("{label} must not include credentials"));
    }
    let host = url
        .host_str()
        .filter(|host| !host.is_empty())
        .ok_or_else(|| anyhow!("{label} must include a host"))?;
    if let Ok(ip) = host.parse::<IpAddr>() {
        if !is_public_ip(ip) {
            return Err(anyhow!("{label} resolves to a non-public IP address"));
        }
    }
    Ok(url)
}

async fn assert_public_endpoint_host(url: &reqwest::Url, label: &str) -> anyhow::Result<()> {
    let host = url
        .host_str()
        .ok_or_else(|| anyhow!("{label} must include a host"))?;
    if host.parse::<IpAddr>().is_ok() {
        return Ok(());
    }
    let port = url
        .port_or_known_default()
        .ok_or_else(|| anyhow!("{label} must include a known port"))?;
    let mut addrs = tokio::net::lookup_host((host, port))
        .await
        .with_context(|| format!("{label} DNS lookup failed"))?;
    let mut saw_addr = false;
    for addr in &mut addrs {
        saw_addr = true;
        if !is_public_ip(addr.ip()) {
            return Err(anyhow!(
                "{label} resolves to a non-public IP address ({})",
                addr.ip()
            ));
        }
    }
    if !saw_addr {
        return Err(anyhow!("{label} did not resolve to any IP addresses"));
    }
    Ok(())
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_ipv4(ip),
        IpAddr::V6(ip) => is_public_ipv6(ip),
    }
}

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    !matches!(
        octets,
        [0, _, _, _]
            | [10, _, _, _]
            | [100, 64..=127, _, _]
            | [127, _, _, _]
            | [169, 254, _, _]
            | [172, 16..=31, _, _]
            | [192, 0, 0, _]
            | [192, 0, 2, _]
            | [192, 168, _, _]
            | [198, 18..=19, _, _]
            | [198, 51, 100, _]
            | [203, 0, 113, _]
            | [224..=239, _, _, _]
            | [240..=255, _, _, _]
    )
}

fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return is_public_ipv4(mapped);
    }

    let segments = ip.segments();
    let first = segments[0];
    !(ip.is_unspecified()
        || ip.is_loopback()
        || (first & 0xfe00) == 0xfc00
        || (first & 0xffc0) == 0xfe80
        || (first & 0xff00) == 0xff00
        || (segments[0] == 0x0064 && segments[1] == 0xff9b && segments[2] == 0)
        || (segments[0] == 0x0064 && segments[1] == 0xff9b && segments[2] == 0x0001)
        || (segments[0] == 0x0100 && segments[1] == 0)
        || (segments[0] == 0x2001 && segments[1] <= 0x01ff)
        || (segments[0] == 0x2001 && segments[1] == 0x0002)
        || (segments[0] == 0x2001 && segments[1] == 0x0db8))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_private_and_metadata_ipv4() {
        assert!(!is_public_ip("127.0.0.1".parse().unwrap()));
        assert!(!is_public_ip("169.254.169.254".parse().unwrap()));
        assert!(!is_public_ip("10.1.2.3".parse().unwrap()));
        assert!(is_public_ip("8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn blocks_private_ipv6() {
        assert!(!is_public_ip("::1".parse().unwrap()));
        assert!(!is_public_ip("fc00::1".parse().unwrap()));
        assert!(!is_public_ip("fe80::1".parse().unwrap()));
        assert!(!is_public_ip("::ffff:169.254.169.254".parse().unwrap()));
        assert!(is_public_ip("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn enforces_https_and_allowed_oauth_origin() {
        // Resolve Attio's allowed origins through the generated allowlist, so
        // this also exercises the table lookup against real generated data.
        let attio_oauth_origins = allowed_oauth_origins_for_mcp_origin("https://mcp.attio.com")
            .expect("attio is in the generated allowlist");
        assert_eq!(attio_oauth_origins, ["https://app.attio.com"]);

        assert!(parse_trusted_oauth_url(
            "https://app.attio.com/oidc/token",
            attio_oauth_origins,
            "token endpoint"
        )
        .is_ok());
        assert!(parse_trusted_oauth_url(
            "http://app.attio.com/oidc/token",
            attio_oauth_origins,
            "token endpoint"
        )
        .is_err());
        assert!(parse_trusted_oauth_url(
            "https://evil.example/oidc/token",
            attio_oauth_origins,
            "token endpoint"
        )
        .is_err());
    }

    #[test]
    fn refresh_replaces_expired_access_and_rotated_refresh_tokens() {
        let now = DateTime::parse_from_rfc3339("2026-08-30T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let current = serde_json::json!({
            "access_token": "old-access",
            "refresh_token": "old-refresh",
            "client_id": "keep-client",
            "client_secret": "keep-secret",
            "custom": "keep-custom"
        });
        let token = TokenResponse {
            access_token: Some("new-access".to_string()),
            refresh_token: Some("new-refresh".to_string()),
            expires_in: Some(3600),
            scope: Some("read write".to_string()),
            token_type: Some("Bearer".to_string()),
        };

        let (merged, expires_at) = merge_refreshed_credentials(&current, token, now).unwrap();

        assert_eq!(merged["access_token"], "new-access");
        assert_eq!(merged["refresh_token"], "new-refresh");
        assert_eq!(merged["client_id"], "keep-client");
        assert_eq!(merged["client_secret"], "keep-secret");
        assert_eq!(merged["custom"], "keep-custom");
        assert_eq!(expires_at, Some(now + Duration::seconds(3600)));
    }

    #[test]
    fn expiry_triggers_refresh_and_bypasses_transient_retry_delay() {
        let now = DateTime::parse_from_rfc3339("2026-08-30T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let threshold = now + Duration::seconds(REFRESH_SKEW_SECS);

        assert!(refresh_is_due(
            "active",
            Some(now - Duration::seconds(1)),
            Some(now + Duration::minutes(5)),
            now,
            threshold,
        ));
        assert!(!refresh_is_due(
            "active",
            Some(now + Duration::seconds(60)),
            Some(now + Duration::minutes(5)),
            now,
            threshold,
        ));
        assert!(!refresh_is_due(
            "active",
            Some(now + Duration::minutes(10)),
            None,
            now,
            threshold,
        ));
    }

    #[test]
    fn refresh_keeps_existing_refresh_token_when_server_does_not_rotate() {
        let current = serde_json::json!({
            "access_token": "old-access",
            "refresh_token": "keep-refresh"
        });
        let token = TokenResponse {
            access_token: Some("new-access".to_string()),
            refresh_token: None,
            expires_in: None,
            scope: None,
            token_type: None,
        };

        let (merged, expires_at) =
            merge_refreshed_credentials(&current, token, Utc::now()).unwrap();

        assert_eq!(merged["refresh_token"], "keep-refresh");
        assert_eq!(expires_at, None);
        assert!(merged.get("expires_at").is_none());
    }

    #[test]
    fn invalid_grant_is_revoked_without_storing_provider_description() {
        let failure = classify_refresh_rejection(StatusCode::BAD_REQUEST, Some("invalid_grant"));

        assert_eq!(failure.kind, RefreshFailureKind::Revoked);
        assert_eq!(failure.code, "refresh_token_rejected");
        assert!(!failure.message.contains("invalid_grant"));
    }

    #[test]
    fn rate_limits_and_server_errors_are_retryable() {
        for status in [
            StatusCode::REQUEST_TIMEOUT,
            StatusCode::TOO_MANY_REQUESTS,
            StatusCode::BAD_GATEWAY,
        ] {
            let failure = classify_refresh_rejection(status, None);
            assert_eq!(failure.kind, RefreshFailureKind::Temporary);
            assert_eq!(failure.code, "refresh_temporarily_unavailable");
        }
        assert!(retry_delay(1) > retry_delay(0));
    }

    #[test]
    fn unsupported_refresh_requires_reconnect() {
        let failure =
            classify_refresh_rejection(StatusCode::BAD_REQUEST, Some("unsupported_grant_type"));

        assert_eq!(failure.kind, RefreshFailureKind::Reconnect);
        assert_eq!(failure.code, "refresh_not_supported");
    }
}
