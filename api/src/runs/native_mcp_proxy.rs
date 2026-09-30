use std::{collections::HashMap, sync::Arc};

use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{header, HeaderMap, Method, Request, Response, StatusCode},
    routing::get,
    Router,
};
use chrono::{Duration, Utc};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{workspace::NativeMcpRow, AppState};

const MAXIO_URL: &str = "https://brave-hall-4395.mcp.maxio.com/v3/mcp";

struct Connection {
    id: Uuid,
    url: String,
}

struct ProxyState {
    app: AppState,
    workspace_id: Uuid,
    user_id: String,
    connections: HashMap<String, Connection>,
    shutdown: CancellationToken,
}

pub(super) struct NativeMcpProxy {
    shutdown: CancellationToken,
}

impl Drop for NativeMcpProxy {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

impl NativeMcpProxy {
    pub(super) async fn start(
        app: &AppState,
        workspace_id: Uuid,
        user_id: &str,
        rows: &mut [NativeMcpRow],
    ) -> anyhow::Result<Option<Self>> {
        if !rows.iter().any(|row| row.provider == "maxio") {
            return Ok(None);
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let mut connections = HashMap::new();
        for row in rows.iter_mut().filter(|row| row.provider == "maxio") {
            anyhow::ensure!(row.mcp_url == MAXIO_URL, "Unexpected Maxio MCP endpoint");
            let capability = Uuid::new_v4().to_string();
            connections.insert(
                capability.clone(),
                Connection {
                    id: row.id,
                    url: row.mcp_url.clone(),
                },
            );
            row.mcp_url = format!("http://{address}/mcp");
            row.access_token = capability;
        }
        let shutdown = CancellationToken::new();
        let router = Router::new()
            .route("/mcp", get(proxy).post(proxy).delete(proxy))
            .with_state(Arc::new(ProxyState {
                app: app.clone(),
                workspace_id,
                user_id: user_id.to_owned(),
                connections,
                shutdown: shutdown.clone(),
            }));
        let server_shutdown = shutdown.clone();
        tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, router)
                .with_graceful_shutdown(server_shutdown.cancelled_owned())
                .await
            {
                tracing::warn!(?error, "Native MCP run transport stopped");
            }
        });
        Ok(Some(Self { shutdown }))
    }
}

fn capability(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

async fn proxy(
    State(state): State<Arc<ProxyState>>,
    request: Request<Body>,
) -> Result<Response<Body>, StatusCode> {
    if state.shutdown.is_cancelled() {
        return Err(StatusCode::GONE);
    }
    let connection = capability(request.headers())
        .and_then(|token| state.connections.get(token))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    crate::native_oauth::refresh_connection(
        &state.app.db,
        &state.app.encryption_key,
        &state.app.http,
        state.workspace_id,
        &state.user_id,
        connection.id,
        Utc::now() + Duration::seconds(10),
    )
    .await
    .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    crate::native_oauth::ensure_connection_usable(
        &state.app.db,
        state.workspace_id,
        &state.user_id,
        connection.id,
    )
    .await
    .map_err(|(status, _)| status)?;
    let rows = crate::workspace::list_active_native_connections(
        &state.app.db,
        &state.app.encryption_key,
        state.workspace_id,
        &state.user_id,
    )
    .await
    .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let row = rows
        .into_iter()
        .find(|row| row.id == connection.id && row.mcp_url == connection.url)
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if state.shutdown.is_cancelled() {
        return Err(StatusCode::GONE);
    }
    forward(&state.app.http, &connection.url, &row.access_token, request).await
}

async fn forward(
    http: &reqwest::Client,
    url: &str,
    token: &str,
    request: Request<Body>,
) -> Result<Response<Body>, StatusCode> {
    let (parts, body) = request.into_parts();
    if !matches!(parts.method, Method::GET | Method::POST | Method::DELETE) {
        return Err(StatusCode::METHOD_NOT_ALLOWED);
    }
    let mut upstream = http
        .request(parts.method, url)
        .timeout(std::time::Duration::from_secs(300))
        .bearer_auth(token);
    for name in [
        "accept",
        "content-type",
        "mcp-session-id",
        "mcp-protocol-version",
        "last-event-id",
    ] {
        if let Some(value) = parts.headers.get(name) {
            upstream = upstream.header(name, value);
        }
    }
    let body = to_bytes(body, 4 * 1024 * 1024)
        .await
        .map_err(|_| StatusCode::PAYLOAD_TOO_LARGE)?;
    let response = upstream
        .body(body)
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    let mut result = Response::builder().status(response.status());
    for name in ["content-type", "mcp-session-id", "retry-after"] {
        if let Some(value) = response.headers().get(name) {
            result = result.header(name, value);
        }
    }
    result
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from_stream(response.bytes_stream()))
        .map_err(|_| StatusCode::BAD_GATEWAY)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Mutex,
    };

    fn app() -> AppState {
        std::env::set_var(
            "TAS_ENCRYPTION_KEY",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        );
        AppState {
            db: sqlx::postgres::PgPoolOptions::new()
                .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
                .unwrap(),
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
            encryption_key: Arc::new(crate::crypto::MasterKey::from_env().unwrap()),
            memory: crate::memory::Memory::from_env(0),
            run_cancels: Arc::new(Mutex::new(HashMap::new())),
            run_concurrency: crate::runs::concurrency::RunConcurrency::new(2, 1, 1).unwrap(),
            draining: Arc::new(AtomicBool::new(false)),
        }
    }

    fn maxio_row() -> NativeMcpRow {
        NativeMcpRow {
            id: Uuid::new_v4(),
            provider: "maxio".into(),
            name: "default".into(),
            mcp_url: MAXIO_URL.into(),
            access_token: "upstream-secret".into(),
            api_key: None,
        }
    }

    #[tokio::test]
    async fn capabilities_are_per_slot_and_run_and_transport_stops_on_drop() {
        let app = app();
        let mut rows = vec![maxio_row(), maxio_row()];
        let proxy = NativeMcpProxy::start(&app, Uuid::new_v4(), "alice", &mut rows)
            .await
            .unwrap()
            .unwrap();
        assert!(rows[0].mcp_url.starts_with("http://127.0.0.1:"));
        assert_ne!(rows[0].access_token, "upstream-secret");
        assert_ne!(rows[0].access_token, rows[1].access_token);
        let response = app
            .http
            .post(&rows[0].mcp_url)
            .bearer_auth("upstream-secret")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let mut other_rows = vec![maxio_row()];
        let other_proxy = NativeMcpProxy::start(&app, Uuid::new_v4(), "bob", &mut other_rows)
            .await
            .unwrap()
            .unwrap();
        let response = app
            .http
            .post(&other_rows[0].mcp_url)
            .bearer_auth(&rows[0].access_token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let shutdown = proxy.shutdown.clone();
        drop(proxy);
        assert!(shutdown.is_cancelled());
        let result = app
            .http
            .post(&rows[0].mcp_url)
            .bearer_auth(&rows[0].access_token)
            .send()
            .await;
        if let Ok(response) = result {
            assert_eq!(response.status(), StatusCode::GONE);
        }
        drop(other_proxy);
    }

    #[tokio::test]
    async fn other_providers_are_unchanged_and_unexpected_maxio_hosts_fail_closed() {
        let app = app();
        let mut rows = vec![maxio_row()];
        rows[0].provider = "attio".into();
        assert!(
            NativeMcpProxy::start(&app, Uuid::new_v4(), "alice", &mut rows)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(rows[0].access_token, "upstream-secret");
        assert_eq!(rows[0].mcp_url, MAXIO_URL);
        rows[0].provider = "maxio".into();
        rows[0].mcp_url = "https://untrusted.example/mcp".into();
        assert!(
            NativeMcpProxy::start(&app, Uuid::new_v4(), "alice", &mut rows)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn forwards_fresh_bearers_and_mcp_headers_without_leaking_local_credentials() {
        let received = Arc::new(Mutex::new(Vec::new()));
        let captured = received.clone();
        let router = Router::new().route(
            "/mcp",
            get(move |request: Request<Body>| {
                let captured = captured.clone();
                async move {
                    captured.lock().unwrap().push(request.headers().clone());
                    Response::builder()
                        .header("content-type", "text/event-stream")
                        .header("mcp-session-id", "session-1")
                        .body(Body::from("event: message\ndata: {}\n\n"))
                        .unwrap()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let http = reqwest::Client::new();
        for token in ["initial-token", "rotated-token"] {
            let request = Request::builder()
                .method(Method::GET)
                .header("authorization", "Bearer local-capability")
                .header("cookie", "private-cookie")
                .header("accept", "text/event-stream")
                .header("mcp-session-id", "session-1")
                .header("mcp-protocol-version", "2025-03-26")
                .header("last-event-id", "event-1")
                .body(Body::empty())
                .unwrap();
            let response = forward(&http, &url, token, request).await.unwrap();
            assert_eq!(response.headers()["mcp-session-id"], "session-1");
            assert_eq!(response.headers()["cache-control"], "no-store");
            assert_eq!(
                to_bytes(response.into_body(), 1024).await.unwrap(),
                "event: message\ndata: {}\n\n"
            );
        }
        let received = received.lock().unwrap();
        assert_eq!(received[0]["authorization"], "Bearer initial-token");
        assert_eq!(received[1]["authorization"], "Bearer rotated-token");
        for headers in received.iter() {
            assert!(!headers.contains_key("cookie"));
            assert_eq!(headers["mcp-session-id"], "session-1");
            assert_eq!(headers["mcp-protocol-version"], "2025-03-26");
            assert_eq!(headers["last-event-id"], "event-1");
        }
        task.abort();
    }

    #[tokio::test]
    async fn upstream_auth_errors_are_not_replayed() {
        let calls = Arc::new(AtomicUsize::new(0));
        let captured = calls.clone();
        let router = Router::new().route(
            "/mcp",
            axum::routing::post(move || {
                captured.fetch_add(1, Ordering::Relaxed);
                async { StatusCode::UNAUTHORIZED }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let response = forward(
            &reqwest::Client::new(),
            &url,
            "rejected",
            Request::builder()
                .method(Method::POST)
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        task.abort();
    }
}
