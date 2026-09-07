use anyhow::{bail, Context};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx::FromRow;
use uuid::Uuid;

use super::{client, mcp::RunAccess};
use crate::AppState;

fn aad(receipt: Uuid, workspace: Uuid) -> String {
    format!("memory_outbox\x1f{workspace}\x1f{receipt}")
}

pub async fn enqueue(
    state: &AppState,
    access: &RunAccess,
    mut report: Value,
) -> anyhow::Result<Value> {
    let fields = report.as_object_mut().context("report must be an object")?;
    let invocation = fields
        .remove("_studio_invocation_id")
        .and_then(|value| value.as_str().map(str::to_owned))
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .context("stable tool invocation id required")?;
    if access.is_dry_run {
        return Ok(json!({ "status": "simulated", "queued": false }));
    }
    if report.to_string().len() > 65_536 {
        bail!("report exceeds 64 KiB");
    }
    if let Some(receipt) = sqlx::query_as::<_, (Uuid, String, Option<String>)>(
        "SELECT id, status, report_id FROM memory_outbox WHERE run_id = $1 AND invocation_id = $2",
    )
    .bind(access.run_id)
    .bind(&invocation)
    .fetch_optional(&state.db)
    .await?
    {
        return Ok(
            json!({ "receipt_id": receipt.0, "status": if receipt.1 == "pending" { "queued" } else { &receipt.1 }, "report_id": receipt.2 }),
        );
    }
    let receipt = Uuid::new_v4();
    let fields = report.as_object_mut().unwrap();
    for forbidden in [
        "principal_id",
        "filed_by",
        "tenant_id",
        "workspace_id",
        "report_id",
    ] {
        if fields.contains_key(forbidden) {
            bail!("identity must come from the authenticated run");
        }
    }
    let external_id = match fields.get("external_id") {
        Some(Value::String(value)) if !value.is_empty() && value.len() <= 512 => {
            format!("studio:{}:{value}", access.workspace_id)
        }
        None => format!("studio:{receipt}"),
        _ => bail!("external_id must be a nonempty string of at most 512 characters"),
    };
    if let Some(timestamp) = fields.get("occurred_at") {
        DateTime::parse_from_rfc3339(
            timestamp
                .as_str()
                .context("occurred_at must be an ISO timestamp")?,
        )?;
    } else {
        fields.insert("occurred_at".into(), json!(Utc::now().to_rfc3339()));
    }
    fields.insert("external_id".into(), json!(external_id));
    fields.insert(
        "via".into(),
        json!(format!(
            "studio:{}:run:{}",
            access.workspace_id, access.run_id
        )),
    );
    fields
        .entry("source")
        .or_insert(json!("tembo-agent-studio"));
    fields.entry("owner").or_insert(json!(access.operator_id));
    let payload = state.encryption_key.encrypt_aad(
        &report.to_string(),
        aad(receipt, access.workspace_id).as_bytes(),
    )?;
    sqlx::query("INSERT INTO memory_outbox (id, workspace_id, run_id, user_id, destination, memory_workspace_id, principal_id, operator_id, invocation_id, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (run_id, invocation_id) DO NOTHING")
        .bind(receipt).bind(access.workspace_id).bind(access.run_id).bind(&access.user_id).bind(&access.destination)
        .bind(&access.memory_workspace_id).bind(&access.principal_id).bind(&access.operator_id).bind(&invocation).bind(payload).execute(&state.db).await?;
    let (id, status): (Uuid, String) = sqlx::query_as(
        "SELECT id, status FROM memory_outbox WHERE run_id = $1 AND invocation_id = $2",
    )
    .bind(access.run_id)
    .bind(invocation)
    .fetch_one(&state.db)
    .await?;
    Ok(
        json!({ "status": if status == "pending" { "queued" } else { &status }, "receipt_id": id,
        "message": "Stored durably in Studio. Delivery to Memory and claim extraction are asynchronous." }),
    )
}

#[derive(FromRow)]
struct Job {
    id: Uuid,
    workspace_id: Uuid,
    user_id: String,
    destination: String,
    memory_workspace_id: String,
    principal_id: String,
    operator_id: String,
    payload: Vec<u8>,
    attempts: i32,
}

pub async fn deliver_next(state: &AppState) -> anyhow::Result<bool> {
    let Some(config) = &state.memory.config else {
        return Ok(false);
    };
    let lease = Uuid::new_v4();
    let job = sqlx::query_as::<_, Job>(
        "UPDATE memory_outbox SET lease_id = $1, lease_until = now() + interval '60 seconds', attempts = attempts + 1 \
         WHERE id = (SELECT id FROM memory_outbox WHERE status = 'pending' AND next_attempt_at <= now() \
         AND (lease_until IS NULL OR lease_until <= now()) ORDER BY next_attempt_at, created_at FOR UPDATE SKIP LOCKED LIMIT 1) \
         RETURNING id, workspace_id, user_id, destination, memory_workspace_id, principal_id, operator_id, payload, attempts",
    ).bind(lease).fetch_optional(&state.db).await?;
    let Some(job) = job else { return Ok(false) };
    let authorized: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_member m JOIN workspace_memory w ON w.workspace_id = m.workspace_id WHERE m.workspace_id = $1 AND m.user_id = $2 AND m.role IN ('operator','workspace_admin') AND w.enabled)")
        .bind(job.workspace_id).bind(&job.user_id).fetch_one(&state.db).await?;
    let result = if job.destination != config.url {
        Err(client::Failure::blocked("memory_destination_changed"))
    } else if !authorized {
        Err(client::Failure::blocked(
            "memory_membership_or_integration_disabled",
        ))
    } else {
        let decoded = state
            .encryption_key
            .decrypt_aad(&job.payload, aad(job.id, job.workspace_id).as_bytes())
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok());
        match decoded {
            Some(payload) => {
                client::agent_request(
                    state,
                    job.workspace_id,
                    &job.memory_workspace_id,
                    &job.principal_id,
                    &job.operator_id,
                    reqwest::Method::POST,
                    "/v1/reports",
                    Some(&payload),
                )
                .await
            }
            None => Err(client::Failure::blocked("memory_payload_unreadable")),
        }
    };
    match result {
        Ok(body) if body.get("report_id").and_then(Value::as_str).is_some() => {
            sqlx::query("UPDATE memory_outbox SET status = 'delivered', report_id = $3, delivered_at = now(), payload = NULL, lease_id = NULL, lease_until = NULL, last_error = NULL WHERE id = $1 AND lease_id = $2")
                .bind(job.id).bind(lease).bind(body["report_id"].as_str()).execute(&state.db).await?;
        }
        result => {
            let failure = result
                .err()
                .unwrap_or_else(|| client::Failure::blocked("memory_incompatible_api"));
            let seconds = retry_delay(job.attempts, job.id);
            sqlx::query("UPDATE memory_outbox SET status = $3, last_error = $4, lease_id = NULL, lease_until = NULL, next_attempt_at = now() + $5 * interval '1 second' WHERE id = $1 AND lease_id = $2")
                .bind(job.id).bind(lease).bind(if failure.retryable { "pending" } else { "blocked" })
                .bind(failure.code).bind(seconds).execute(&state.db).await?;
        }
    }
    Ok(true)
}

fn retry_delay(attempts: i32, receipt: Uuid) -> i32 {
    (5 * 2_i32.pow(attempts.clamp(0, 6) as u32)).min(300) + (receipt.as_bytes()[0] % 5) as i32
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retries_are_bounded_and_payload_encryption_is_workspace_bound() {
        let id = Uuid::nil();
        assert!(retry_delay(1, id) >= 5);
        assert!(retry_delay(i32::MAX, id) <= 304);
        assert_ne!(aad(id, Uuid::new_v4()), aad(id, Uuid::new_v4()));
    }
}
