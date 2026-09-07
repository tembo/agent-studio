use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use super::{client, default_workspace};
use crate::AppState;

pub async fn get(
    State(state): State<AppState>,
    Path(workspace): Path<Uuid>,
) -> Result<Json<Value>, StatusCode> {
    let setting: Option<(String, bool)> = sqlx::query_as(
        "SELECT memory_workspace_id, enabled FROM workspace_memory WHERE workspace_id = $1",
    )
    .bind(workspace)
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let (target, enabled) = setting.unwrap_or((default_workspace(workspace), true));
    let counts: Vec<(String, i64)> = sqlx::query_as(
        "SELECT status, count(*) FROM memory_outbox WHERE workspace_id = $1 GROUP BY status",
    )
    .bind(workspace)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let blocked: Vec<(Uuid, String, String)> = sqlx::query_as("SELECT id, memory_workspace_id, COALESCE(last_error, 'unknown') FROM memory_outbox WHERE workspace_id = $1 AND status = 'blocked' ORDER BY created_at LIMIT 20")
        .bind(workspace).fetch_all(&state.db).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut options = json!([]);
    let mut warning = state.memory.configuration_error.map(str::to_owned);
    if state.memory.config.is_some() {
        match client::admin_request(&state, None, reqwest::Method::GET, "/v1/workspaces", None)
            .await
        {
            Ok(body) => options = body.get("workspaces").cloned().unwrap_or(json!([])),
            Err(failure) => warning = Some(failure.code.into()),
        }
    }
    Ok(Json(
        json!({ "configured": state.memory.config.is_some(), "warning": warning, "enabled": enabled,
        "memory_workspace_id": target, "default_workspace_id": default_workspace(workspace),
        "workspaces": options, "counts": counts.into_iter().collect::<std::collections::HashMap<_,_>>(),
        "blocked": blocked.into_iter().map(|(id, target, error)| json!({ "id": id, "memory_workspace_id": target, "error": error })).collect::<Vec<_>>() }),
    ))
}

#[derive(Deserialize)]
pub struct Update {
    memory_workspace_id: String,
    enabled: bool,
}

pub async fn update(
    State(state): State<AppState>,
    Path(workspace): Path<Uuid>,
    Json(body): Json<Update>,
) -> Result<Json<Value>, StatusCode> {
    if !valid_id(&body.memory_workspace_id) {
        return Err(StatusCode::BAD_REQUEST);
    }
    if body.memory_workspace_id != default_workspace(workspace) {
        let listing =
            client::admin_request(&state, None, reqwest::Method::GET, "/v1/workspaces", None)
                .await
                .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        if !listing["workspaces"].as_array().is_some_and(|items| {
            items
                .iter()
                .any(|item| item["id"] == body.memory_workspace_id)
        }) {
            return Err(StatusCode::BAD_REQUEST);
        }
    }
    sqlx::query("INSERT INTO workspace_memory (workspace_id, memory_workspace_id, enabled) VALUES ($1,$2,$3) ON CONFLICT (workspace_id) DO UPDATE SET memory_workspace_id = EXCLUDED.memory_workspace_id, enabled = EXCLUDED.enabled, updated_at = now()")
        .bind(workspace).bind(body.memory_workspace_id).bind(body.enabled).execute(&state.db).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn retry(
    State(state): State<AppState>,
    Path(workspace): Path<Uuid>,
) -> Result<Json<Value>, StatusCode> {
    sqlx::query("UPDATE memory_outbox SET status = 'pending', next_attempt_at = now(), last_error = NULL WHERE workspace_id = $1 AND status = 'blocked'")
        .bind(workspace).execute(&state.db).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(json!({ "ok": true })))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id.bytes().all(|character| {
            character.is_ascii_alphanumeric() || character == b'-' || character == b'_'
        })
}
