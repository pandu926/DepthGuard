use crate::{rpc::Rpc, store};
use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use uuid::Uuid;
const DFS: &str = "dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh";

pub async fn claim_broadcast(pool: &PgPool, owner: Uuid) -> Result<Option<store::Job>> {
    let row=sqlx::query("UPDATE jobs SET state='running',lease_owner=$1,lease_until=now()+interval '30 seconds',attempts=attempts+1 WHERE id=(SELECT id FROM jobs WHERE kind='broadcast' AND ((state='pending' AND run_after<=now()) OR (state='running' AND lease_until<now())) AND attempts<max_attempts ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,kind,payload,attempts").bind(owner).fetch_optional(pool).await?;
    Ok(row.map(|r| store::Job {
        id: r.get("id"),
        kind: r.get("kind"),
        payload: r.get("payload"),
        attempts: r.get("attempts"),
    }))
}
pub async fn broadcast(pool: &PgPool, rpc: &Rpc, cluster: &str, job: &store::Job) -> Result<()> {
    let id: Uuid = serde_json::from_value(job.payload["transaction_id"].clone())?;
    let row=sqlx::query("SELECT state,signature,signed_wire,last_valid_block_height,cluster FROM prepared_transactions WHERE id=$1").bind(id).fetch_one(pool).await?;
    if row.get::<String, _>("cluster") != cluster {
        bail!("Transaction cluster mismatch");
    }
    if row.get::<String, _>("state") != "submitted" {
        return Ok(());
    }
    rpc.verify_cluster(cluster).await?;
    let signature: String = row.get("signature");
    // An earlier send may have succeeded despite a timeout. Always reconcile first.
    if reconcile_one(pool, rpc, cluster, id, &signature).await? {
        return Ok(());
    }
    let wire: Vec<u8> = row.get("signed_wire");
    let wire = STANDARD.encode(wire);
    let simulated=rpc.call("simulateTransaction",json!([wire,{"encoding":"base64","sigVerify":true,"replaceRecentBlockhash":false,"commitment":"confirmed"}])).await?;
    if !simulated["value"]["err"].is_null() {
        // A previous send can still land while the account state changes. Only chain status
        // or finalized block-height expiry can resolve that unknown outcome definitively.
        bail!("Simulation failed; retain the stored wire until chain status or expiry resolves it");
    }

    let sent=rpc.call("sendTransaction",json!([wire,{"encoding":"base64","skipPreflight":false,"preflightCommitment":"confirmed","maxRetries":5}])).await?;
    if sent.as_str() != Some(&signature) {
        bail!("RPC returned an unexpected transaction signature");
    }
    // Persisted wire is never rebuilt here. A retry sends the identical signature.
    Ok(())
}
pub async fn reconcile(pool: &PgPool, rpc: &Rpc, cluster: &str) -> Result<()> {
    let rows=sqlx::query("SELECT id,signature FROM prepared_transactions WHERE cluster=$1 AND state IN ('submitted','confirmed') ORDER BY updated_at LIMIT 25").bind(cluster).fetch_all(pool).await?;
    if rows.is_empty() {
        return Ok(());
    }
    rpc.verify_cluster(cluster).await?;
    for row in rows {
        let id: Uuid = row.get("id");
        let signature: String = row.get("signature");
        // Rotate every attempted row, including delayed RPC history, so one receipt cannot starve others.
        sqlx::query("UPDATE prepared_transactions SET updated_at=now() WHERE id=$1 AND state IN ('submitted','confirmed')").bind(id).execute(pool).await?;
        if let Err(error) = reconcile_one(pool, rpc, cluster, id, &signature).await {
            tracing::warn!(transaction_id=%id, reason=%error, "Receipt reconciliation delayed; other transactions continue");
        }
    }
    Ok(())
}
async fn reconcile_one(
    pool: &PgPool,
    rpc: &Rpc,
    cluster: &str,
    id: Uuid,
    signature: &str,
) -> Result<bool> {
    let status = rpc.signature_status(signature).await?;
    let value = &status["value"][0];
    if value.is_null() {
        let height = rpc
            .call("getBlockHeight", json!([{"commitment":"finalized"}]))
            .await?
            .as_i64()
            .context("Missing block height")?;
        let updated=sqlx::query("UPDATE prepared_transactions SET state='expired',updated_at=now() WHERE id=$1 AND state IN ('submitted','confirmed') AND last_valid_block_height<$2").bind(id).bind(height).execute(pool).await?;
        if updated.rows_affected() == 0 {
            // An RPC acknowledgement is not proof that a leader received the packet.
            // Requeue the existing bounded job while retaining the identical signed wire.
            sqlx::query("UPDATE jobs SET state='pending',run_after=now()+interval '5 seconds',lease_owner=NULL,lease_until=NULL WHERE kind='broadcast' AND state='completed' AND attempts<max_attempts AND payload->>'transaction_id'=$1 AND EXISTS(SELECT 1 FROM prepared_transactions WHERE id=$2 AND state='submitted')")
                .bind(id.to_string()).bind(id).execute(pool).await?;
        }
        return Ok(updated.rows_affected() > 0);
    }
    if !value["err"].is_null() {
        sqlx::query("UPDATE prepared_transactions SET state='failed',updated_at=now() WHERE id=$1 AND state IN ('submitted','confirmed')").bind(id).execute(pool).await?;
        return Ok(true);
    }
    let commitment = value["confirmationStatus"].as_str().unwrap_or("processed");
    if commitment == "processed" {
        return Ok(false);
    }
    let transaction=rpc.call("getTransaction",json!([signature,{"encoding":"json","commitment":commitment,"maxSupportedTransactionVersion":0}])).await?;
    if transaction.is_null() {
        bail!("Confirmed transaction details not available yet");
    }
    let slot = transaction["slot"]
        .as_i64()
        .context("Receipt slot missing")?;
    if transaction["transaction"]["signatures"][0].as_str() != Some(signature) {
        bail!("RPC transaction signature mismatch");
    }
    if !transaction["meta"].is_object() || !transaction["meta"]["err"].is_null() {
        bail!("RPC receipt metadata is missing or inconsistent with successful status");
    }
    let mut tx = pool.begin().await?;
    // Fenced row state protects against concurrent reconciliation and terminal-state regression.
    let current: String =
        sqlx::query_scalar("SELECT state FROM prepared_transactions WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    if !["submitted", "confirmed"].contains(&current.as_str()) {
        return Ok(true);
    }
    record_events(&mut tx, cluster, signature, commitment, &transaction).await?;
    sqlx::query(
        "UPDATE prepared_transactions SET state=$2,confirmed_slot=$3,updated_at=now() WHERE id=$1",
    )
    .bind(id)
    .bind(commitment)
    .bind(slot)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(true)
}
fn bs58_decode(value: &str) -> Result<Vec<u8>> {
    if value.len() > 4096 {
        bail!("Chain event encoding exceeds supported bounds");
    }
    bs58::decode(value)
        .into_vec()
        .map_err(|_| anyhow::anyhow!("Invalid chain event encoding"))
}

/// Receipt ingestion is shared by submitted transaction recovery and finalized vault catch-up.
pub async fn record_events(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    cluster: &str,
    signature: &str,
    commitment: &str,
    transaction: &Value,
) -> Result<()> {
    if !transaction["meta"]["err"].is_null() {
        return Ok(());
    }
    crate::contracts::record_events(tx, cluster, signature, commitment, transaction).await?;
    let slot = transaction["slot"]
        .as_i64()
        .context("Transaction slot missing")?;
    let mut keys = transaction
        .pointer("/transaction/message/accountKeys")
        .and_then(Value::as_array)
        .context("Transaction keys missing")?
        .clone();
    for field in ["writable", "readonly"] {
        if let Some(loaded) = transaction["meta"]["loadedAddresses"][field].as_array() {
            keys.extend(loaded.iter().cloned());
        }
    }
    if let Some(groups) = transaction
        .pointer("/meta/innerInstructions")
        .and_then(Value::as_array)
    {
        for group in groups {
            let outer = group["index"]
                .as_i64()
                .context("Instruction index missing")?;
            for (index, ix) in group["instructions"]
                .as_array()
                .context("Inner instructions missing")?
                .iter()
                .enumerate()
            {
                let program_index = ix["programIdIndex"]
                    .as_u64()
                    .context("Program index missing")? as usize;
                if keys.get(program_index).and_then(Value::as_str) != Some(DFS) {
                    continue;
                }
                let encoded = ix["data"].as_str().context("Event encoding missing")?;
                let bytes = bs58_decode(encoded)?;
                if bytes.get(..8) != Some(&[0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]) {
                    continue;
                }
                let event = crate::native::invoke(
                    &json!({"operation":"fee_event","data":STANDARD.encode(bytes)}),
                )
                .await
                .context("Native DFS event could not be verified")?;
                if event["kind"] == "untracked" {
                    continue;
                }
                let vault = event["vault"].as_str().context("Fee event vault missing")?;
                let amount = event["amount"]
                    .as_str()
                    .context("Fee event amount missing")?;
                sqlx::query("INSERT INTO chain_events(cluster,signature,instruction_index,event_index,slot,commitment,data) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(cluster,signature,instruction_index,event_index) DO UPDATE SET commitment=EXCLUDED.commitment")
                    .bind(cluster).bind(signature).bind(outer as i32).bind(index as i32).bind(slot).bind(commitment).bind(&event).execute(&mut **tx).await?;
                if index >= 1000 || outer > i64::from(i32::MAX) / 1000 {
                    bail!("Instruction event index exceeds supported bounds");
                }
                let combined_index = outer
                    .checked_mul(1000)
                    .and_then(|n| n.checked_add(index as i64))
                    .context("Event index overflow")?;
                sqlx::query("INSERT INTO fee_accounting_entries(id,cluster,vault_address,signature,event_index,entry_type,recipient_wallet,amount,finalized) VALUES($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9) ON CONFLICT(cluster,signature,event_index,entry_type) DO UPDATE SET finalized=EXCLUDED.finalized")
                    .bind(Uuid::new_v4()).bind(cluster).bind(vault).bind(signature).bind(combined_index as i32).bind(event["kind"].as_str()).bind(event["recipient"].as_str()).bind(amount).bind(commitment=="finalized").execute(&mut **tx).await?;
            }
        }
    }
    Ok(())
}
