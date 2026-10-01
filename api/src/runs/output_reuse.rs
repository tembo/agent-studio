use serde::Deserialize;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutputReuse {
    pub key: String,
    pub report_type: String,
    pub max_age_seconds: i32,
}

impl OutputReuse {
    pub fn validate(&self) -> bool {
        self.key.len() == 64
            && self.key.bytes().all(|b| b.is_ascii_hexdigit())
            && !self.report_type.trim().is_empty()
            && self.report_type.len() <= 800
            && (0..=604800).contains(&self.max_age_seconds)
    }
}

#[derive(sqlx::FromRow)]
pub struct ReusableOutput {
    pub id: Uuid,
    pub output: String,
}

pub async fn lookup(
    db: &PgPool,
    workspace_id: Uuid,
    user_id: &str,
    agent_name: &str,
    version_id: Uuid,
    reuse: &OutputReuse,
) -> Result<Option<ReusableOutput>, sqlx::Error> {
    // Never refresh freshness through reuse chains. Only original successful
    // production executions can supply a result; partial deliveries are misses.
    sqlx::query_as(
        r#"SELECT id, output FROM run
           WHERE workspace_id = $1 AND created_by = $2 AND agent_name = $3
             AND agent_version_id = $4 AND output_reuse_key = $5
             AND output_reuse_type = $6
             AND status = 'succeeded' AND trigger <> 'eval' AND BTRIM(output) <> ''
             AND completed_at >= now() - make_interval(secs => $7::double precision)
             AND completed_at <= now()
             AND run_environment = 'production' AND NOT is_dry_run
             AND delivery_status IN ('undeclared', 'confirmed')
             AND reused_from_run_id IS NULL
           ORDER BY completed_at DESC, id DESC LIMIT 1"#,
    )
    .bind(workspace_id)
    .bind(user_id)
    .bind(agent_name)
    .bind(version_id)
    .bind(&reuse.key)
    .bind(&reuse.report_type)
    .bind(reuse.max_age_seconds as f64)
    .fetch_optional(db)
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_bounded_reuse_options() {
        let mut reuse = OutputReuse {
            key: "a".repeat(64),
            report_type: "daily-report".into(),
            max_age_seconds: 60,
        };
        assert!(reuse.validate());
        reuse.max_age_seconds = -1;
        assert!(!reuse.validate());
        reuse.max_age_seconds = 604801;
        assert!(!reuse.validate());
        reuse.max_age_seconds = 0;
        assert!(reuse.validate());
        reuse.key = "arbitrary".into();
        assert!(!reuse.validate());
    }

    #[tokio::test]
    #[ignore = "requires OUTPUT_REUSE_TEST_DATABASE_URL pointing to disposable PostgreSQL"]
    async fn reuse_lookup_enforces_boundaries_and_quality() {
        let db = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect(&std::env::var("OUTPUT_REUSE_TEST_DATABASE_URL").unwrap())
            .await
            .unwrap();
        sqlx::query("CREATE TEMP TABLE run (id uuid, workspace_id uuid, created_by text, agent_name text, agent_version_id uuid, output_reuse_key text, output_reuse_type text, status text, trigger text DEFAULT 'manual', output text, completed_at timestamptz, run_environment text, is_dry_run boolean, delivery_status text, reused_from_run_id uuid)")
            .execute(&db).await.unwrap();
        let workspace = Uuid::new_v4();
        let version = Uuid::new_v4();
        let original = Uuid::new_v4();
        let reuse = OutputReuse {
            key: "a".repeat(64),
            report_type: "report".into(),
            max_age_seconds: 60,
        };
        sqlx::query("INSERT INTO run (id, workspace_id, created_by, agent_name, agent_version_id, output_reuse_key, output_reuse_type, status, output, completed_at, run_environment, is_dry_run, delivery_status, reused_from_run_id) VALUES ($1,$2,'user','reporter',$3,$4,'report','succeeded','complete output',now() - interval '30 seconds','production',false,'confirmed',null)")
            .bind(original).bind(workspace).bind(version).bind(&reuse.key).execute(&db).await.unwrap();
        let hit = lookup(&db, workspace, "user", "reporter", version, &reuse)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(hit.id, original);
        assert_eq!(hit.output, "complete output");
        for (ws, user, agent, ver) in [
            (Uuid::new_v4(), "user", "reporter", version),
            (workspace, "other", "reporter", version),
            (workspace, "user", "other", version),
            (workspace, "user", "reporter", Uuid::new_v4()),
        ] {
            assert!(lookup(&db, ws, user, agent, ver, &reuse)
                .await
                .unwrap()
                .is_none());
        }
        for mutation in [
            "status = 'failed'",
            "trigger = 'eval'",
            "status = 'running'",
            "output = ''",
            "completed_at = now() - interval '2 minutes'",
            "completed_at = NULL",
            "run_environment = 'development'",
            "is_dry_run = true",
            "delivery_status = 'partial'",
            "delivery_status = 'failed'",
            "delivery_status = 'unobserved'",
            "output_reuse_key = 'changed-scope'",
            "output_reuse_type = 'other-report'",
            "reused_from_run_id = id",
        ] {
            sqlx::query("BEGIN").execute(&db).await.unwrap();
            sqlx::query(&format!("UPDATE run SET {mutation}"))
                .execute(&db)
                .await
                .unwrap();
            assert!(
                lookup(&db, workspace, "user", "reporter", version, &reuse)
                    .await
                    .unwrap()
                    .is_none(),
                "{mutation}"
            );
            sqlx::query("ROLLBACK").execute(&db).await.unwrap();
        }
        let fresh = OutputReuse {
            max_age_seconds: 0,
            ..reuse
        };
        assert!(lookup(&db, workspace, "user", "reporter", version, &fresh)
            .await
            .unwrap()
            .is_none());
        db.close().await;
    }
}
