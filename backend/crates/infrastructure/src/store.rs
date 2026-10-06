use anyhow::Result;
use serde_json::Value;
use sqlx::{PgPool, Row, postgres::PgPoolOptions};
use uuid::Uuid;

pub async fn connect(url: &str) -> Result<PgPool> {
    Ok(PgPoolOptions::new()
        .max_connections(12)
        .min_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(3))
        .connect(url)
        .await?)
}
static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");
pub async fn migrate(pool: &PgPool) -> Result<()> {
    MIGRATOR.run(pool).await?;
    Ok(())
}
/// Startup checks the complete migration set and checksums; partial schemas never appear ready.
pub async fn assert_schema(pool: &PgPool) -> Result<()> {
    let rows: Vec<(i64, bool, Vec<u8>)> =
        sqlx::query_as("SELECT version,success,checksum FROM _sqlx_migrations ORDER BY version")
            .fetch_all(pool)
            .await?;
    anyhow::ensure!(
        rows.len() == MIGRATOR.iter().count(),
        "Database migration set differs from this binary"
    );
    for migration in MIGRATOR.iter() {
        anyhow::ensure!(
            rows.iter()
                .any(|(version, success, checksum)| *version == migration.version
                    && *success
                    && checksum.as_slice() == migration.checksum.as_ref()),
            "Database migration checksum or completion mismatch"
        );
    }
    Ok(())
}
#[derive(Debug)]
pub struct Job {
    pub id: Uuid,
    pub kind: String,
    pub payload: Value,
    pub attempts: i32,
}
/// A transaction row lock plus a renewable lease survives process crashes without global serialization.
pub async fn claim(pool: &PgPool, owner: Uuid) -> Result<Option<Job>> {
    let row = sqlx::query("UPDATE jobs SET state='running', lease_owner=$1, lease_until=now()+interval '30 seconds', attempts=attempts+1 WHERE id=(SELECT id FROM jobs WHERE kind='research' AND ((state='pending' AND run_after<=now()) OR (state='running' AND lease_until<now())) AND attempts<max_attempts ORDER BY run_after,created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,kind,payload,attempts")
        .bind(owner).fetch_optional(pool).await?;
    Ok(row.map(|r| Job {
        id: r.get("id"),
        kind: r.get("kind"),
        payload: r.get("payload"),
        attempts: r.get("attempts"),
    }))
}
pub async fn heartbeat(pool: &PgPool, id: Uuid, owner: Uuid) -> Result<bool> {
    Ok(sqlx::query("UPDATE jobs SET lease_until=now()+interval '30 seconds' WHERE id=$1 AND lease_owner=$2 AND state='running' AND lease_until>now()")
        .bind(id).bind(owner).execute(pool).await?.rows_affected() == 1)
}
pub async fn finish(pool: &PgPool, id: Uuid, owner: Uuid) -> Result<()> {
    sqlx::query("UPDATE jobs SET state='completed',lease_until=NULL WHERE id=$1 AND lease_owner=$2 AND state='running' AND lease_until>now()")
        .bind(id).bind(owner).execute(pool).await?;
    Ok(())
}
pub async fn fail(pool: &PgPool, id: Uuid, owner: Uuid, message: &str) -> Result<()> {
    sqlx::query("UPDATE jobs SET state=CASE WHEN attempts>=max_attempts THEN 'dead' ELSE 'pending' END, run_after=now()+make_interval(secs=>least(300,power(2,attempts)::integer)),lease_until=NULL,last_error=$3 WHERE id=$1 AND lease_owner=$2 AND state='running'")
        .bind(id).bind(owner).bind(message).execute(pool).await?;
    Ok(())
}
pub async fn audit(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    actor: Uuid,
    action: &str,
    resource: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO audit_events(actor_id,action,resource_id) VALUES ($1,$2,$3)")
        .bind(actor)
        .bind(action)
        .bind(resource)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub async fn claim_research_slot(pool: &PgPool, owner: Uuid) -> Result<Option<i32>> {
    Ok(sqlx::query_scalar("UPDATE worker_slots SET owner=$1,lease_until=now()+interval '30 seconds' WHERE id=(SELECT id FROM worker_slots WHERE lease_until IS NULL OR lease_until<now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id")
        .bind(owner).fetch_optional(pool).await?)
}
pub async fn renew_slot(pool: &PgPool, owner: Uuid, slot: i32) -> Result<bool> {
    Ok(sqlx::query("UPDATE worker_slots SET lease_until=now()+interval '30 seconds' WHERE id=$1 AND owner=$2 AND lease_until>now()")
        .bind(slot).bind(owner).execute(pool).await?.rows_affected()==1)
}
pub async fn release_slot(pool: &PgPool, owner: Uuid, slot: i32) -> Result<()> {
    sqlx::query("UPDATE worker_slots SET owner=NULL,lease_until=NULL WHERE id=$1 AND owner=$2")
        .bind(slot)
        .bind(owner)
        .execute(pool)
        .await?;
    Ok(())
}
