use crate::{native, rpc::Rpc};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use uuid::Uuid;
const DBC: &str = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const DAMM: &str = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
const DFS: &str = "dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh";
/// Only finalized receipts advance the launch workflow. Account reads prove authority and LP locks.
pub async fn reconcile_launches(
    pool: &PgPool,
    rpc: &Rpc,
    cluster: &str,
    damm_config: Option<&str>,
) -> Result<()> {
    let rows=sqlx::query("SELECT p.id,p.launch_id,p.workflow_step,p.summary,p.confirmed_slot,l.metadata FROM prepared_transactions p JOIN launches l ON l.id=p.launch_id JOIN workflow_steps w ON w.launch_id=p.launch_id AND w.step=p.workflow_step WHERE p.cluster=$1 AND p.state='finalized' AND w.state='prepared' ORDER BY p.updated_at LIMIT 10").bind(cluster).fetch_all(pool).await?;
    for row in rows {
        let id: Uuid = row.get("id");
        let launch: Uuid = row.get("launch_id");
        let step: String = row.get("workflow_step");
        let metadata: Value = row.get("metadata");
        let summary: Value = row.get("summary");
        let keys =
            sqlx::query("SELECT purpose,public_key FROM launch_account_signers WHERE launch_id=$1")
                .bind(launch)
                .fetch_all(pool)
                .await?;
        let keys: std::collections::BTreeMap<String, String> = keys
            .into_iter()
            .map(|r| (r.get("purpose"), r.get("public_key")))
            .collect();
        let mut input = json!({"operation":"verify_launch","step":step,"wallet":metadata["launcher"],"config":keys["config"],"base_mint":keys["mint"],"quote_mint":metadata["quote_mint"],"fee_vault":summary["fee_vault"],"parameters":metadata["parameters"],"recipients":metadata["recipients"]});
        let mut accounts: Vec<(String, String, &str)> = vec![];
        if step == "fee_vault" {
            accounts.push((
                summary["fee_vault"]
                    .as_str()
                    .context("Fee vault missing")?
                    .into(),
                DFS.into(),
                "vault_data",
            ));
        } else {
            accounts.push((keys["config"].clone(), DBC.into(), "config_data"));
            if step == "pool" {
                accounts.push((
                    summary["instruction"]["pool"]
                        .as_str()
                        .context("Pool address missing")?
                        .into(),
                    DBC.into(),
                    "pool_data",
                ));
            }
            if step == "migration" {
                let mut derived = input.clone();
                derived["operation"] = json!("dbc_pool");
                derived["name"] = metadata["name"].clone();
                derived["symbol"] = metadata["symbol"].clone();
                derived["uri"] = metadata["uri"].clone();
                let pool_ix = native::invoke(&derived).await?;
                accounts.push((
                    pool_ix["pool"]
                        .as_str()
                        .context("DBC address missing")?
                        .into(),
                    DBC.into(),
                    "pool_data",
                ));
                let mut migrated = input.clone();
                migrated["operation"] = json!("dbc_migrate");
                migrated["damm_config"] = json!(damm_config.context("Migration config required")?);
                migrated["first_position_mint"] = json!(keys["first_position"]);
                migrated["second_position_mint"] = json!(keys["second_position"]);
                let migration = native::invoke(&migrated).await?;
                let metas = migration["accounts"]
                    .as_array()
                    .context("Migration accounts missing")?;
                input["damm_pool"] = migration["damm_pool"].clone();
                input["first_position_mint"] = json!(keys["first_position"]);
                accounts.push((
                    migration["damm_pool"]
                        .as_str()
                        .context("DAMM address missing")?
                        .into(),
                    DAMM.into(),
                    "damm_data",
                ));
                accounts.push((
                    metas[7]["address"]
                        .as_str()
                        .context("Position address missing")?
                        .into(),
                    DAMM.into(),
                    "position_data",
                ));
                accounts.push((
                    metas[6]["address"]
                        .as_str()
                        .context("Position NFT address missing")?
                        .into(),
                    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb".into(),
                    "position_nft_data",
                ));
            }
        }
        let addresses: Vec<&str> = accounts.iter().map(|(a, _, _)| a.as_str()).collect();
        let snapshot = rpc
            .call(
                "getMultipleAccounts",
                json!([addresses,{"encoding":"base64","commitment":"finalized","minContextSlot":row.get::<Option<i64>,_>("confirmed_slot")}]),
            )
            .await?;
        let observed = snapshot["value"]
            .as_array()
            .context("Account snapshot missing")?;
        if observed.len() != accounts.len() {
            bail!("Incomplete verification snapshot");
        }
        for ((_, owner, field), value) in accounts.iter().zip(observed) {
            if value["owner"] != *owner {
                bail!("Native account ownership mismatch");
            }
            input[*field] = value["data"][0].clone();
        }
        let evidence = native::invoke(&input).await;
        let mut tx = pool.begin().await?;
        match evidence {
            Ok(mut evidence) => {
                evidence["context_slot"] = snapshot["context"]["slot"].clone();
                sqlx::query("UPDATE workflow_steps SET state='verified',evidence=$3,updated_at=now() WHERE launch_id=$1 AND step=$2 AND transaction_id=$4").bind(launch).bind(&step).bind(&evidence).bind(id).execute(&mut *tx).await?;
                let consumed: Vec<&str> = match step.as_str() {
                    "config" => vec!["config"],
                    "pool" => vec!["mint"],
                    "migration" => vec!["first_position", "second_position"],
                    _ => vec![],
                };
                sqlx::query("UPDATE launch_account_signers SET encrypted_key=''::bytea,consumed_at=now() WHERE launch_id=$1 AND purpose=ANY($2) AND consumed_at IS NULL").bind(launch).bind(consumed).execute(&mut *tx).await?;
                let state = match step.as_str() {
                    "fee_vault" => "fee_vault_ready",
                    "config" => "config_ready",
                    "pool" => "trading",
                    "migration" => "migrated",
                    _ => bail!("Unknown workflow step"),
                };
                sqlx::query("UPDATE launches SET state=$2 WHERE id=$1")
                    .bind(launch)
                    .bind(state)
                    .execute(&mut *tx)
                    .await?;
                sqlx::query("INSERT INTO outbox(topic,payload) VALUES('launch.step_verified',$1)")
                    .bind(json!({"launch_id":launch,"step":step,"transaction_id":id}))
                    .execute(&mut *tx)
                    .await?;
                if step == "fee_vault" {
                    sqlx::query("INSERT INTO fee_vaults(cluster,address,launch_id,quote_mint,recipients,verified) VALUES($1,$2,$3,$4,$5,true) ON CONFLICT(cluster,address) DO UPDATE SET verified=true")
                        .bind(cluster).bind(summary["fee_vault"].as_str()).bind(launch).bind(metadata["quote_mint"].as_str()).bind(&metadata["recipients"]).execute(&mut *tx).await?;
                }
                if step == "pool" || step == "migration" {
                    let address = if step == "pool" {
                        &summary["instruction"]["pool"]
                    } else {
                        &summary["instruction"]["damm_pool"]
                    };
                    let protocol = if step == "pool" { "dbc" } else { "damm_v2" };
                    sqlx::query("INSERT INTO markets(cluster,address,protocol,launch_id,state,context_slot) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(cluster,address) DO UPDATE SET state=EXCLUDED.state,context_slot=EXCLUDED.context_slot,observed_at=now()")
                        .bind(cluster).bind(address.as_str()).bind(protocol).bind(launch).bind(&evidence).bind(snapshot["context"]["slot"].as_i64()).execute(&mut *tx).await?;
                }
            }
            Err(_) => {
                sqlx::query("UPDATE prepared_transactions SET state='verification_failed',updated_at=now() WHERE id=$1 AND state='finalized'").bind(id).execute(&mut *tx).await?;
                sqlx::query("UPDATE workflow_steps SET state='verification_failed',evidence=$3,updated_at=now() WHERE launch_id=$1 AND step=$2").bind(launch).bind(&step).bind(json!({"reason":"Native state, model parameters or fee authority did not verify"})).execute(&mut *tx).await?;
                sqlx::query("UPDATE launches SET state='verification_failed' WHERE id=$1")
                    .bind(launch)
                    .execute(&mut *tx)
                    .await?;
            }
        }
        tx.commit().await?;
    }
    Ok(())
}
