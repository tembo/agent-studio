use std::{collections::HashMap, sync::Arc, time::Duration};

use anyhow::{bail, Context};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::AppState;

pub mod client;
pub mod mcp;
pub mod outbox;
pub mod settings;

pub struct Config {
    pub url: String,
    pub admin_token: String,
}

impl Config {
    pub fn parse(url: Option<String>, token: Option<String>) -> anyhow::Result<Option<Self>> {
        let url = url.filter(|value| !value.trim().is_empty());
        let token = token.filter(|value| !value.trim().is_empty());
        let (Some(url), Some(token)) = (url.clone(), token.clone()) else {
            if url.is_some() || token.is_some() {
                bail!("Set both TAS_MEMORY_URL and TAS_MEMORY_ADMIN_TOKEN");
            }
            return Ok(None);
        };
        let parsed = reqwest::Url::parse(&url).context("Invalid TAS_MEMORY_URL")?;
        if !matches!(parsed.scheme(), "http" | "https")
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || parsed.path() != "/"
        {
            bail!("TAS_MEMORY_URL must be an HTTP(S) server origin without credentials");
        }
        Ok(Some(Self {
            url: parsed.as_str().trim_end_matches('/').to_string(),
            admin_token: token,
        }))
    }
}

#[derive(Clone, Deserialize)]
pub struct Credential {
    pub token: String,
    pub expires_at: DateTime<Utc>,
}

pub struct Memory {
    pub config: Option<Config>,
    pub configuration_error: Option<&'static str>,
    pub credentials: Mutex<HashMap<String, Credential>>,
    pub bridge_url: String,
}

impl Memory {
    pub fn from_env(port: u16) -> Arc<Self> {
        let parsed = Config::parse(
            std::env::var("TAS_MEMORY_URL").ok(),
            std::env::var("TAS_MEMORY_ADMIN_TOKEN").ok(),
        );
        let (config, configuration_error) = match parsed {
            Ok(config) => (config, None),
            Err(_) => (None, Some("Invalid Memory configuration: set a server origin and admin token on the API service")),
        };
        Arc::new(Self {
            config,
            configuration_error,
            credentials: Mutex::new(HashMap::new()),
            bridge_url: format!("http://127.0.0.1:{port}/memory/mcp"),
        })
    }
}

pub fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

pub fn principal_id(workspace_id: Uuid, agent_name: &str, user_id: &str) -> String {
    format!(
        "agent:studio-{workspace_id}-{}",
        digest(&format!("{agent_name}\x1f{user_id}"))
    )
}

pub fn default_workspace(workspace_id: Uuid) -> String {
    format!("studio-{workspace_id}")
}

#[derive(Serialize)]
pub struct Launch {
    pub url: String,
    pub token: String,
}

pub async fn prepare_run(state: &AppState, run_id: Uuid) -> anyhow::Result<Option<String>> {
    if let Some(error) = state.memory.configuration_error {
        warn(state, run_id, error).await;
    }
    let Some(config) = &state.memory.config else {
        return Ok(None);
    };
    let (workspace_id, user_id, agent_name): (Uuid, String, String) =
        sqlx::query_as("SELECT workspace_id, created_by, agent_name FROM run WHERE id = $1")
            .bind(run_id)
            .fetch_one(&state.db)
            .await?;
    sqlx::query("INSERT INTO workspace_memory (workspace_id, memory_workspace_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(workspace_id).bind(default_workspace(workspace_id)).execute(&state.db).await?;
    let (target, enabled): (String, bool) = sqlx::query_as(
        "SELECT memory_workspace_id, enabled FROM workspace_memory WHERE workspace_id = $1",
    )
    .bind(workspace_id)
    .fetch_one(&state.db)
    .await?;
    if !enabled {
        return Ok(None);
    }
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    sqlx::query(
        "INSERT INTO memory_run (run_id, token_hash, destination, memory_workspace_id, principal_id, operator_id) \
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (run_id) DO UPDATE SET token_hash = EXCLUDED.token_hash",
    ).bind(run_id).bind(digest(&token)).bind(&config.url).bind(target)
        .bind(principal_id(workspace_id, &agent_name, &user_id))
        .bind(format!("person:studio-{}", digest(&user_id))).execute(&state.db).await?;
    Ok(Some(serde_json::to_string(&Launch {
        url: state.memory.bridge_url.clone(),
        token: format!("{run_id}.{token}"),
    })?))
}

pub async fn warn(state: &AppState, run_id: Uuid, message: &str) {
    let _ = sqlx::query("UPDATE run SET memory_warning = $2 WHERE id = $1")
        .bind(run_id)
        .bind(message)
        .execute(&state.db)
        .await;
}

pub fn start_worker(state: AppState) {
    if state.memory.config.is_none() {
        return;
    }
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        loop {
            interval.tick().await;
            if state.draining.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
            for _ in 0..10 {
                match outbox::deliver_next(&state).await {
                    Ok(true) => {}
                    Ok(false) => break,
                    Err(_) => {
                        tracing::warn!("Memory outbox drain failed; retrying later");
                        break;
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configuration_is_optional_and_rejects_ambiguous_urls() {
        assert!(Config::parse(None, None).unwrap().is_none());
        assert!(Config::parse(Some("http://localhost:8080".into()), None).is_err());
        for url in [
            "file:///tmp/data",
            "https://user:pass@host",
            "https://host/mcp",
            "https://host?key=secret",
        ] {
            assert!(Config::parse(Some(url.into()), Some("secret".into())).is_err());
        }
        assert_eq!(
            Config::parse(
                Some("https://memory.example/".into()),
                Some("secret".into())
            )
            .unwrap()
            .unwrap()
            .url,
            "https://memory.example"
        );
    }

    #[test]
    fn identities_survive_runs_but_do_not_collide_when_workspaces_share_memory() {
        let workspace = Uuid::new_v4();
        let first = principal_id(workspace, "sales", "alice");
        assert_eq!(first, principal_id(workspace, "sales", "alice"));
        assert_ne!(first, principal_id(workspace, "sales", "bob"));
        assert_ne!(first, principal_id(Uuid::new_v4(), "sales", "alice"));
    }
}
