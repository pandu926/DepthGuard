use crate::{native, relay, rpc::Rpc};
use anyhow::{Context, Result};
use serde_json::json;
use sqlx::{PgPool, Row};
/// Finalized HTTP catch-up remains authoritative when stream notifications or worker processes stop.
pub async fn catch_up(pool: &PgPool, rpc: &Rpc, cluster: &str) -> Result<()> {
    let vault: Option<String>=sqlx::query_scalar("SELECT a.address FROM (SELECT address,cluster FROM fee_vaults WHERE verified UNION SELECT address,cluster FROM contract_accounts UNION SELECT address,cluster FROM markets WHERE launch_id IN (SELECT launch_id FROM factory_launches)) a LEFT JOIN indexer_cursors c ON c.cluster=a.cluster AND c.address=a.address WHERE a.cluster=$1 ORDER BY c.updated_at NULLS FIRST LIMIT 1").bind(cluster).fetch_optional(pool).await?;
    let Some(address) = vault else { return Ok(()) };
    rpc.verify_cluster(cluster).await?;
    sqlx::query(
        "INSERT INTO indexer_cursors(cluster,address) VALUES($1,$2) ON CONFLICT DO NOTHING",
    )
    .bind(cluster)
    .bind(&address)
    .execute(pool)
    .await?;
    // A transaction advisory lock avoids overlapping scans by multiple worker processes.
    let mut connection = pool.begin().await?;
    let lock_key = format!("{cluster}:{address}");
    let held: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(hashtextextended($1,1))")
        .bind(&lock_key)
        .fetch_one(&mut *connection)
        .await?;
    if !held {
        return Ok(());
    }
    sqlx::query("UPDATE indexer_cursors SET updated_at=now() WHERE cluster=$1 AND address=$2")
        .bind(cluster)
        .bind(&address)
        .execute(pool)
        .await?;
    let result = scan(pool, rpc, cluster, &address).await;
    connection.commit().await?;
    result
}
async fn scan(pool: &PgPool, rpc: &Rpc, cluster: &str, address: &str) -> Result<()> {
    let row=sqlx::query("SELECT signature,before_signature,pending_tip,pending_tip_slot FROM indexer_cursors WHERE cluster=$1 AND address=$2").bind(cluster).bind(address).fetch_one(pool).await?;
    let until: Option<String> = row.get("signature");
    let before: Option<String> = row.get("before_signature");
    let mut options = json!({"commitment":"finalized","limit":20});
    if let Some(v) = &until {
        options["until"] = json!(v)
    }
    if let Some(v) = &before {
        options["before"] = json!(v)
    }
    let page = rpc
        .call("getSignaturesForAddress", json!([address, options]))
        .await?;
    let page = page.as_array().context("Signature page missing")?;
    let tip = row.get::<Option<String>, _>("pending_tip").or_else(|| {
        page.first()
            .and_then(|v| v["signature"].as_str())
            .map(str::to_owned)
    });
    let tip_slot = row
        .get::<Option<i64>, _>("pending_tip_slot")
        .or_else(|| page.first().and_then(|v| v["slot"].as_i64()));
    for receipt in page {
        let signature = receipt["signature"].as_str().context("Signature missing")?;
        let transaction=rpc.call("getTransaction",json!([signature,{"encoding":"json","commitment":"finalized","maxSupportedTransactionVersion":0}])).await?;
        anyhow::ensure!(
            !transaction.is_null(),
            "Finalized receipt unavailable; cursor retained"
        );
        let mut tx = pool.begin().await?;
        relay::record_events(&mut tx, cluster, signature, "finalized", &transaction).await?;
        sqlx::query("UPDATE indexer_cursors SET before_signature=$3,pending_tip=$4,pending_tip_slot=$5,updated_at=now() WHERE cluster=$1 AND address=$2").bind(cluster).bind(address).bind(signature).bind(&tip).bind(tip_slot).execute(&mut *tx).await?;
        tx.commit().await?;
    }
    if page.len() < 20 {
        sqlx::query("UPDATE indexer_cursors SET signature=coalesce($3,signature),slot=coalesce($4,slot),before_signature=NULL,pending_tip=NULL,pending_tip_slot=NULL,updated_at=now() WHERE cluster=$1 AND address=$2").bind(cluster).bind(address).bind(tip).bind(tip_slot).execute(pool).await?;
    }
    let snapshot = rpc
        .call(
            "getAccountInfo",
            json!([address,{"encoding":"base64","commitment":"finalized"}]),
        )
        .await?;
    let owner = snapshot["value"]["owner"]
        .as_str()
        .context("Owner missing")?;
    let state = if owner == "dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh" {
        native::invoke(&json!({"operation":"fee_vault","vault_data":snapshot["value"]["data"][0]}))
            .await?
    } else if [
        crate::contracts::REGISTRY,
        crate::contracts::ESCROW,
        crate::contracts::RESERVE,
    ]
    .contains(&owner)
    {
        let kind: String = sqlx::query_scalar(
            "SELECT kind FROM contract_accounts WHERE cluster=$1 AND address=$2",
        )
        .bind(cluster)
        .bind(address)
        .fetch_one(pool)
        .await?;
        anyhow::ensure!(
            owner == crate::contracts::program(&kind)?,
            "Contract owner mismatch"
        );
        native::invoke(
            &json!({"operation":"contract_state","kind":kind,"data":snapshot["value"]["data"][0]}),
        )
        .await?
    } else {
        let protocol: String =
            sqlx::query_scalar("SELECT protocol FROM markets WHERE cluster=$1 AND address=$2")
                .bind(cluster)
                .bind(address)
                .fetch_one(pool)
                .await?;
        let expected = if protocol == "dbc" {
            "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"
        } else {
            "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"
        };
        anyhow::ensure!(owner == expected, "Market owner mismatch");
        native::invoke(&json!({"operation":"describe","protocol":protocol,"pool_data":snapshot["value"]["data"][0]})).await?
    };
    sqlx::query("INSERT INTO account_snapshots(cluster,address,slot,data_hash,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING").bind(cluster).bind(address).bind(snapshot["context"]["slot"].as_i64().context("Snapshot slot missing")?).bind(depthguard_domain::economy::hash_value(&state)).bind(state).execute(pool).await?;
    Ok(())
}
