use anyhow::{Result, bail};
use depthguard_application::research::{ResearchRequest, run_case};
use depthguard_infrastructure::{config::Config, relay, rpc::Rpc, store};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use uuid::Uuid;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let config = Config::from_env()?;
    let pool = store::connect(&config.database_url).await?;
    store::assert_schema(&pool).await?;
    tokio::fs::create_dir_all(&config.artifacts_dir).await?;
    let stop = Arc::new(AtomicBool::new(false));
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..2 {
        let pool = pool.clone();
        let stop = stop.clone();
        let dir = config.artifacts_dir.clone();
        tasks.spawn(async move { run_loop(pool, stop, dir).await });
    }
    let heartbeat_pool = pool.clone();
    let heartbeat_stop = stop.clone();
    tasks.spawn(async move { heartbeat_loop(heartbeat_pool, heartbeat_stop).await });
    let chain_pool = pool.clone();
    let chain_stop = stop.clone();
    let chain_config = config.clone();
    tasks.spawn(async move { chain_loop(chain_pool, chain_stop, chain_config).await });
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{},result=tasks.join_next()=>{if let Some(result)=result{result??;}}}
    stop.store(true, Ordering::SeqCst);
    while let Some(result) = tasks.join_next().await {
        result??;
    }
    pool.close().await;
    Ok(())
}
async fn run_loop(pool: PgPool, stop: Arc<AtomicBool>, dir: std::path::PathBuf) -> Result<()> {
    let owner = Uuid::new_v4();
    while !stop.load(Ordering::SeqCst) {
        // Exactly two durable slots across all worker processes, not just this process.
        if let Some(slot) = store::claim_research_slot(&pool, owner).await? {
            if let Some(job) = store::claim(&pool, owner).await? {
                tracing::info!(job_id=%job.id,kind=job.kind,attempt=job.attempts,"Job started");
                let result = if job.kind == "research" {
                    process_research(&pool, &job, owner, slot, &dir, &stop).await
                } else {
                    Err(anyhow::anyhow!("Unknown job kind"))
                };
                match result {
                    Ok(()) => store::finish(&pool, job.id, owner).await?,
                    Err(_) => {
                        tracing::warn!(job_id=%job.id,"Job failed; retry scheduled");
                        store::fail(&pool, job.id, owner, "Research execution failed").await?;
                    }
                }
            }
            store::release_slot(&pool, owner, slot).await?;
        }
        deliver_outbox(&pool).await?;
        reap_exhausted_jobs(&pool).await?;
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Ok(())
}
async fn process_research(
    pool: &PgPool,
    job: &store::Job,
    owner: Uuid,
    slot: i32,
    dir: &std::path::Path,
    stop: &AtomicBool,
) -> Result<()> {
    let id: Uuid = serde_json::from_value(job.payload["research_id"].clone())?;
    let row = sqlx::query("SELECT request,status FROM research_jobs WHERE id=$1")
        .bind(id)
        .fetch_one(pool)
        .await?;
    let status: String = row.get("status");
    if ["completed", "cancelled", "failed"].contains(&status.as_str()) {
        return Ok(());
    }
    let request: ResearchRequest = serde_json::from_value(row.get("request"))?;
    request.validate().map_err(anyhow::Error::msg)?;
    sqlx::query("UPDATE research_jobs SET status='running' WHERE id=$1")
        .bind(id)
        .execute(pool)
        .await?;
    let start = Instant::now();
    for (index, case) in request.cases.iter().enumerate() {
        if stop.load(Ordering::SeqCst) {
            bail!("Worker draining");
        }
        if !store::heartbeat(pool, job.id, owner).await?
            || !store::renew_slot(pool, owner, slot).await?
        {
            bail!("Worker lease lost");
        }
        let cancel: bool =
            sqlx::query_scalar("SELECT cancel_requested FROM research_jobs WHERE id=$1")
                .bind(id)
                .fetch_one(pool)
                .await?;
        if cancel || start.elapsed() > Duration::from_secs(300) {
            let state = if cancel { "cancelled" } else { "failed" };
            sqlx::query(
                "UPDATE research_jobs SET status=$2,error=$3,finished_at=now() WHERE id=$1",
            )
            .bind(id)
            .bind(state)
            .bind(if cancel {
                None
            } else {
                Some("Research deadline exceeded")
            })
            .execute(pool)
            .await?;
            return Ok(());
        }
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM research_cases WHERE job_id=$1 AND case_index=$2)",
        )
        .bind(id)
        .bind(index as i32)
        .fetch_one(pool)
        .await?;
        if exists {
            continue;
        }
        let result = if request.evidence == "analytical" {
            let case = case.clone();
            let seed = request.seed.clone();
            let clock = request.clock;
            let mut computation =
                tokio::task::spawn_blocking(move || run_case(&case, &seed, clock));
            loop {
                tokio::select! {
                    result=&mut computation=>break result?,
                    _=tokio::time::sleep(Duration::from_secs(10))=>{
                        if !store::heartbeat(pool,job.id,owner).await? || !store::renew_slot(pool,owner,slot).await? {bail!("Worker lease lost");}
                    }
                }
            }
        } else {
            let snapshot = &case.inputs["snapshot"];
            let output = if request.evidence == "local_sbf" {
                depthguard_infrastructure::native::simulate_sbf(snapshot).await
            } else {
                depthguard_infrastructure::native::invoke(snapshot).await
            };
            match output {
                Ok(result) => {
                    json!({"status":"completed","evidence":request.evidence,"result":result,"seed":request.seed,"requested_clock":request.clock,"snapshot_clock":{"slot":snapshot["slot"],"timestamp":snapshot["timestamp"]},"snapshot_hash":depthguard_domain::economy::hash_value(snapshot),"model_binding_verified":false})
                }
                Err(_) => {
                    json!({"status":"rejected","evidence":request.evidence,"reason":"Native snapshot validation or program simulation failed"})
                }
            }
        };
        let mut tx = pool.begin().await?;
        // Fence stale workers after a lease expires. At-least-once computation, exactly-once persistence.
        let held:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM jobs WHERE id=$1 AND lease_owner=$2 AND state='running' AND lease_until>now() FOR UPDATE)").bind(job.id).bind(owner).fetch_one(&mut *tx).await?;
        if !held {
            bail!("Worker lease lost before persistence");
        }
        sqlx::query("INSERT INTO research_cases(job_id,case_index,result) VALUES($1,$2,$3) ON CONFLICT DO NOTHING").bind(id).bind(index as i32).bind(result).execute(&mut *tx).await?;
        sqlx::query("UPDATE research_jobs SET progress=(SELECT count(*) FROM research_cases WHERE job_id=$1) WHERE id=$1").bind(id).execute(&mut *tx).await?;
        tx.commit().await?;
    }
    let results: Vec<Value> =
        sqlx::query_scalar("SELECT result FROM research_cases WHERE job_id=$1 ORDER BY case_index")
            .bind(id)
            .fetch_all(pool)
            .await?;
    let body = json!({"job_id":id,"request":request,"results":results,"schema_version":1});
    let hash = depthguard_domain::economy::hash_value(&body);
    let bytes = serde_json::to_vec_pretty(&body)?;
    let key = format!("{id}.json");
    let temp = dir.join(format!("{id}.{owner}.tmp"));
    tokio::fs::write(&temp, &bytes).await?;
    tokio::fs::rename(&temp, dir.join(&key)).await?;
    let mut tx = pool.begin().await?;
    let held:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM jobs WHERE id=$1 AND lease_owner=$2 AND state='running' AND lease_until>now() FOR UPDATE)").bind(job.id).bind(owner).fetch_one(&mut *tx).await?;
    if !held {
        bail!("Worker lease lost before artifact commit");
    }
    sqlx::query("INSERT INTO artifacts(id,owner_id,job_id,content_hash,media_type,storage_key,size_bytes) SELECT $1,owner_id,id,$2,'application/json',$3,$4 FROM research_jobs WHERE id=$5 ON CONFLICT(storage_key) DO NOTHING")
        .bind(Uuid::new_v4()).bind(hash).bind(key).bind(bytes.len() as i64).bind(id).execute(&mut *tx).await?;
    sqlx::query("UPDATE research_jobs SET status=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'completed' END,finished_at=now() WHERE id=$1").bind(id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO outbox(topic,payload) VALUES('research.finished',$1)")
        .bind(json!({"id":id}))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    tracing::info!(research_id=%id,"Research job completed");
    Ok(())
}
async fn deliver_outbox(pool: &PgPool) -> Result<()> {
    // Notifications are hints; durable resources remain the source of truth after reconnect.
    let mut tx = pool.begin().await?;
    let rows=sqlx::query("SELECT id,topic,payload FROM outbox WHERE delivered_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 100").fetch_all(&mut *tx).await?;
    for row in rows {
        let id: i64 = row.get("id");
        sqlx::query("SELECT pg_notify('depthguard_events',$1)").bind(json!({"id":id,"topic":row.get::<String,_>("topic"),"payload":row.get::<Value,_>("payload")}).to_string()).execute(&mut *tx).await?;
        sqlx::query("UPDATE outbox SET delivered_at=now() WHERE id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}
async fn reap_exhausted_jobs(pool: &PgPool) -> Result<()> {
    let mut tx = pool.begin().await?;
    let rows=sqlx::query("UPDATE jobs SET state='dead',lease_until=NULL WHERE state='running' AND lease_until<now() AND attempts>=max_attempts RETURNING kind,payload").fetch_all(&mut *tx).await?;
    for row in rows {
        if row.get::<String, _>("kind") == "research" {
            let value: Value = row.get("payload");
            let id: Uuid = serde_json::from_value(value["research_id"].clone())?;
            sqlx::query("UPDATE research_jobs SET status='failed',error='Worker retry limit exceeded',finished_at=now() WHERE id=$1 AND status IN ('queued','running')").bind(id).execute(&mut *tx).await?;
        }
    }
    sqlx::query("UPDATE research_jobs r SET status='failed',error='Worker retry limit exceeded',finished_at=now() WHERE status IN ('queued','running') AND EXISTS(SELECT 1 FROM jobs j WHERE j.kind='research' AND j.state='dead' AND j.payload->>'research_id'=r.id::text)").execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

async fn chain_loop(pool: PgPool, stop: Arc<AtomicBool>, config: Config) -> Result<()> {
    let rpc = Rpc::new(config.rpc_urls.clone())?;
    let owner = Uuid::new_v4();
    while !stop.load(Ordering::SeqCst) {
        if config.chain_writes
            && let Some(job) = relay::claim_broadcast(&pool, owner).await?
        {
            let mut execution = Box::pin(relay::broadcast(&pool, &rpc, &config.cluster, &job));
            let outcome = loop {
                tokio::select! {
                    result=&mut execution=>break result,
                    _=tokio::time::sleep(Duration::from_secs(10))=>{
                        if !store::heartbeat(&pool,job.id,owner).await? {break Err(anyhow::anyhow!("Broadcast lease lost"));}
                    }
                }
            };
            match outcome {
                Ok(()) => store::finish(&pool, job.id, owner).await?,
                Err(_) => {
                    tracing::warn!(job_id=%job.id,"Broadcast outcome requires reconciliation");
                    store::fail(
                        &pool,
                        job.id,
                        owner,
                        "RPC outcome unknown; reconcile before retry",
                    )
                    .await?;
                }
            }
        }
        if let Err(error) = relay::reconcile(&pool, &rpc, &config.cluster).await {
            tracing::warn!(reason=%error, "Transaction reconciliation delayed");
        }
        if depthguard_infrastructure::verification::reconcile_launches(
            &pool,
            &rpc,
            &config.cluster,
            config.damm_config.as_deref(),
        )
        .await
        .is_err()
        {
            tracing::warn!("Launch state verification delayed");
        }
        if config.contracts_enabled
            && depthguard_infrastructure::contracts::index_receipts(&pool, &rpc, &config.cluster)
                .await
                .is_err()
        {
            tracing::warn!("Contract projections delayed");
        }
        if config.contracts_enabled
            && depthguard_infrastructure::factory::refresh(&pool, &rpc, &config.cluster)
                .await
                .is_err()
        {
            tracing::warn!("Factory finalized reconciliation delayed");
        }
        if let Err(error) =
            depthguard_infrastructure::indexer::catch_up(&pool, &rpc, &config.cluster).await
        {
            tracing::warn!(reason=%error,"Finalized indexer catch-up delayed");
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    Ok(())
}

async fn heartbeat_loop(pool: PgPool, stop: Arc<AtomicBool>) -> Result<()> {
    while !stop.load(Ordering::SeqCst) {
        sqlx::query("INSERT INTO service_heartbeats(service) VALUES('research-worker') ON CONFLICT(service) DO UPDATE SET observed_at=now()").execute(&pool).await?;
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
    Ok(())
}
