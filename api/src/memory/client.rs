use chrono::{Duration, Utc};
use reqwest::Method;
use serde_json::{json, Value};
use uuid::Uuid;

use super::{default_workspace, Credential};
use crate::AppState;

#[derive(Debug)]
pub struct Failure {
    pub code: &'static str,
    pub retryable: bool,
}

impl Failure {
    pub fn unavailable() -> Self {
        Self {
            code: "memory_unavailable",
            retryable: true,
        }
    }
    pub fn blocked(code: &'static str) -> Self {
        Self {
            code,
            retryable: false,
        }
    }
}

pub async fn request(
    state: &AppState,
    token: &str,
    workspace: Option<&str>,
    method: Method,
    path: &str,
    body: Option<&Value>,
) -> Result<Value, Failure> {
    let config = state
        .memory
        .config
        .as_ref()
        .ok_or_else(Failure::unavailable)?;
    let mut request = state
        .http
        .request(method, format!("{}{}", config.url, path))
        .bearer_auth(token)
        .timeout(std::time::Duration::from_secs(if path == "/v1/ask" {
            20
        } else {
            5
        }));
    if let Some(workspace) = workspace {
        request = request.header("x-memory-workspace", workspace);
    }
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request.send().await.map_err(|_| Failure::unavailable())?;
    let status = response.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 | 403 => Failure::blocked("memory_authorization_required"),
            404 => Failure::blocked("memory_workspace_or_principal_missing"),
            400 | 413 | 422 => Failure::blocked("memory_invalid_report_or_configuration"),
            423 => Failure {
                code: "memory_sealed",
                retryable: true,
            },
            429 => Failure {
                code: "memory_rate_limited",
                retryable: true,
            },
            _ => Failure::unavailable(),
        });
    }
    response.json().await.map_err(|_| Failure::unavailable())
}

pub async fn admin_request(
    state: &AppState,
    workspace: Option<&str>,
    method: Method,
    path: &str,
    body: Option<&Value>,
) -> Result<Value, Failure> {
    let config = state
        .memory
        .config
        .as_ref()
        .ok_or_else(Failure::unavailable)?;
    request(state, &config.admin_token, workspace, method, path, body).await
}

fn cache_key(target: &str, principal: &str) -> String {
    format!("{target}\x1f{principal}")
}

pub async fn credential(
    state: &AppState,
    workspace_id: Uuid,
    target: &str,
    principal: &str,
    operator: &str,
) -> Result<Credential, Failure> {
    let config = state
        .memory
        .config
        .as_ref()
        .ok_or_else(Failure::unavailable)?;
    let key = cache_key(target, principal);
    if let Some(cached) = state.memory.credentials.lock().await.get(&key).cloned() {
        if cached.expires_at > Utc::now() + Duration::seconds(60) {
            return Ok(cached);
        }
    }
    let provisioned: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM memory_identity WHERE destination = $1 AND memory_workspace_id = $2 AND principal_id = $3)")
        .bind(&config.url).bind(target).bind(principal).fetch_one(&state.db).await.map_err(|_| Failure::unavailable())?;
    if !provisioned {
        if target == default_workspace(workspace_id) {
            admin_request(
                state,
                None,
                Method::PUT,
                &format!("/v1/workspaces/{target}"),
                Some(&json!({ "name": target })),
            )
            .await?;
        }
        admin_request(
            state,
            Some(target),
            Method::PUT,
            &format!("/v1/principals/{principal}"),
            Some(&json!({
                "ceiling": "internal", "workspace_access": true, "operated_by": operator,
                "runtime": "tembo-agent-studio", "purposes": ["operate"]
            })),
        )
        .await?;
        sqlx::query("INSERT INTO memory_identity (destination, memory_workspace_id, principal_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING")
            .bind(&config.url).bind(target).bind(principal).execute(&state.db).await.map_err(|_| Failure::unavailable())?;
    }
    let response = admin_request(
        state,
        Some(target),
        Method::POST,
        "/v1/api-keys",
        Some(&json!({ "principal_id": principal })),
    )
    .await?;
    let credential: Credential = serde_json::from_value(response)
        .map_err(|_| Failure::blocked("memory_incompatible_api"))?;
    if credential.expires_at <= Utc::now() || credential.token.is_empty() {
        return Err(Failure::blocked("memory_incompatible_api"));
    }
    let mut cache = state.memory.credentials.lock().await;
    cache.retain(|_, value| value.expires_at > Utc::now());
    if cache.len() >= 4096 {
        cache.clear();
    }
    cache.insert(key, credential.clone());
    Ok(credential)
}

pub async fn agent_request(
    state: &AppState,
    workspace_id: Uuid,
    target: &str,
    principal: &str,
    operator: &str,
    method: Method,
    path: &str,
    body: Option<&Value>,
) -> Result<Value, Failure> {
    let credential = credential(state, workspace_id, target, principal, operator).await?;
    let result = request(state, &credential.token, None, method, path, body).await;
    if matches!(&result, Err(failure) if failure.code == "memory_authorization_required") {
        state
            .memory
            .credentials
            .lock()
            .await
            .remove(&cache_key(target, principal));
    }
    result
}
