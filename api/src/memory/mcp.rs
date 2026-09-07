use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};
use sqlx::FromRow;
use uuid::Uuid;

use super::{client, digest, outbox, warn};
use crate::AppState;

#[derive(FromRow)]
pub struct RunAccess {
    pub run_id: Uuid,
    pub workspace_id: Uuid,
    pub user_id: String,
    pub destination: String,
    pub memory_workspace_id: String,
    pub principal_id: String,
    pub operator_id: String,
    pub is_dry_run: bool,
}

async fn authenticate(state: &AppState, headers: &HeaderMap) -> Result<RunAccess, StatusCode> {
    let token = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let (run_id, secret) = token.split_once('.').ok_or(StatusCode::UNAUTHORIZED)?;
    let run_id = Uuid::parse_str(run_id).map_err(|_| StatusCode::UNAUTHORIZED)?;
    if secret.len() != 64 {
        return Err(StatusCode::UNAUTHORIZED);
    }
    sqlx::query_as::<_, RunAccess>(
        "SELECT mr.run_id, r.workspace_id, r.created_by AS user_id, mr.destination, mr.memory_workspace_id, \
         mr.principal_id, mr.operator_id, r.is_dry_run FROM memory_run mr JOIN run r ON r.id = mr.run_id \
         JOIN workspace_member member ON member.workspace_id = r.workspace_id AND member.user_id = r.created_by \
         JOIN workspace_memory settings ON settings.workspace_id = r.workspace_id \
         WHERE mr.run_id = $1 AND mr.token_hash = $2 AND r.status = 'running' AND settings.enabled \
         AND member.role IN ('operator','workspace_admin')",
    ).bind(run_id).bind(digest(secret)).fetch_optional(&state.db).await.map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?
        .ok_or(StatusCode::UNAUTHORIZED)
}

pub async fn handle(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let access = match authenticate(&state, &headers).await {
        Ok(access) => access,
        Err(status) => return status.into_response(),
    };
    if body.get("id").is_none() {
        return StatusCode::ACCEPTED.into_response();
    }
    let id = body["id"].clone();
    let result = match body["method"].as_str().unwrap_or("") {
        "initialize" => json!({
            "protocolVersion": "2025-06-18", "capabilities": { "tools": {} },
            "serverInfo": { "name": "tembo-memory", "version": "1.0.0" }
        }),
        "ping" => json!({}),
        "tools/list" => json!({ "tools": serde_json::from_str::<Value>(include_str!("tools.json")).expect("valid bundled Memory tool schemas") }),
        "tools/call" => {
            let name = body["params"]["name"].as_str().unwrap_or("");
            let args = body["params"].get("arguments").cloned().unwrap_or(json!({}));
            let result = call(&state, &access, name, args).await;
            json!({ "content": [{ "type": "text", "text": result.to_string() }], "isError": false })
        }
        _ => return Json(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Method not found" } })).into_response(),
    };
    Json(json!({ "jsonrpc": "2.0", "id": id, "result": result })).into_response()
}

async fn call(state: &AppState, access: &RunAccess, name: &str, args: Value) -> Value {
    if !args.is_object() {
        return json!({ "status": "invalid", "message": "Tool arguments must be an object" });
    }
    if name == "memory_report" {
        return match outbox::enqueue(state, access, args).await {
            Ok(result) => result,
            Err(_) => {
                warn(
                    state,
                    access.run_id,
                    "Memory report was not queued; check the report fields and Studio storage",
                )
                .await;
                json!({ "status": "not_queued", "message": "Report could not be durably queued. Check fields, event time, payload limit, and Studio storage. Do not claim it was saved." })
            }
        };
    }
    if state.memory.config.as_ref().map(|config| &config.url) != Some(&access.destination) {
        return json!({ "status": "unavailable", "message": "Memory destination changed or is not configured" });
    }
    let (method, path, body) = match name {
        "memory_ask" => (reqwest::Method::POST, "/v1/ask".to_string(), Some(args)),
        "memory_search" => (
            reqwest::Method::POST,
            "/v1/claims/search".to_string(),
            Some(args),
        ),
        "memory_entities" => {
            let mut url = reqwest::Url::parse("http://localhost/v1/entities").unwrap();
            if let Some(kind) = args["kind"].as_str() {
                url.query_pairs_mut().append_pair("kind", kind);
            }
            (
                reqwest::Method::GET,
                format!(
                    "{}{}",
                    url.path(),
                    url.query()
                        .map(|query| format!("?{query}"))
                        .unwrap_or_default()
                ),
                None,
            )
        }
        _ => return json!({ "status": "invalid", "message": "Unknown Memory tool" }),
    };
    match client::agent_request(
        state,
        access.workspace_id,
        &access.memory_workspace_id,
        &access.principal_id,
        &access.operator_id,
        method,
        &path,
        body.as_ref(),
    )
    .await
    {
        Ok(result) => result,
        Err(failure) => {
            warn(state, access.run_id, failure.code).await;
            json!({ "status": "unavailable", "reason": failure.code, "message": "Memory could not be consulted. Continue with an explicit warning; this does not mean there are no relevant facts." })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_catalog_never_exposes_enrollment_or_administration() {
        let catalog: Vec<Value> = serde_json::from_str(include_str!("tools.json")).unwrap();
        let names: Vec<_> = catalog
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            [
                "memory_ask",
                "memory_search",
                "memory_entities",
                "memory_report"
            ]
        );
    }
}
