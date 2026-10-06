use crate::{contracts, native, rpc::Rpc};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
/// Reconcile factory projections from finalized accounts, including externally submitted actions.
pub async fn refresh(pool: &PgPool, rpc: &Rpc, cluster: &str) -> Result<()> {
    rpc.verify_cluster(cluster).await?;
    let rows=sqlx::query("SELECT f.launch_id,f.launch_address,f.plan,f.metadata FROM factory_launches f JOIN launches l ON l.id=f.launch_id LEFT JOIN contract_accounts c ON c.cluster=l.cluster AND c.address=f.launch_address WHERE l.cluster=$1 ORDER BY f.checked_at NULLS FIRST LIMIT 5").bind(cluster).fetch_all(pool).await?;
    for r in rows {
        let address: String = r.get("launch_address");
        let plan: Value = r.get("plan");
        let metadata: Value = r.get("metadata");
        let id: uuid::Uuid = r.get("launch_id");
        sqlx::query("UPDATE factory_launches SET checked_at=now() WHERE launch_id=$1")
            .bind(id)
            .execute(pool)
            .await?;
        let snapshot = finalized_account(rpc, &address).await?;
        if snapshot["value"].is_null() {
            continue;
        }
        ensure!(
            snapshot["value"]["owner"] == contracts::REGISTRY,
            "Launch owner mismatch"
        );
        let state=native::invoke(&json!({"operation":"contract_state","kind":"launch","data":snapshot["value"]["data"][0]})).await?;
        ensure!(
            state["model"] == plan["accounts"]["model"]
                && state["base_mint"] == plan["accounts"]["base_mint"]
                && state["launcher"] == metadata["launcher"],
            "Launch identity mismatch"
        );
        let slot = snapshot["context"]["slot"]
            .as_i64()
            .context("Launch slot missing")?;
        sqlx::query("INSERT INTO contract_accounts(cluster,address,kind,program_id,data,context_slot) VALUES($1,$2,'launch',$3,$4,$5) ON CONFLICT(cluster,address) DO UPDATE SET data=$4,context_slot=$5,observed_at=now() WHERE contract_accounts.context_slot<=$5").bind(cluster).bind(&address).bind(contracts::REGISTRY).bind(&state).bind(slot).execute(pool).await?;
        let phase = state["phase"].as_u64().context("Phase missing")?;
        if phase >= 2 {
            let protocol = if phase >= 3 { "damm_v2" } else { "dbc" };
            let market = if phase >= 3 {
                state["damm_pool"].as_str().context("DAMM missing")?
            } else {
                plan["accounts"]["pool"].as_str().context("DBC missing")?
            };
            let a = finalized_account(rpc, market).await?;
            let owner = if protocol == "dbc" {
                "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"
            } else {
                "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"
            };
            ensure!(a["value"]["owner"] == owner, "Market owner mismatch");
            let described=native::invoke(&json!({"operation":"describe","protocol":protocol,"pool_data":a["value"]["data"][0]})).await?;
            let market_slot = a["context"]["slot"]
                .as_i64()
                .context("Market slot missing")?;
            sqlx::query("INSERT INTO markets(cluster,address,protocol,launch_id,state,context_slot) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(cluster,address) DO UPDATE SET state=$5,context_slot=$6,observed_at=now() WHERE markets.context_slot<=$6").bind(cluster).bind(market).bind(protocol).bind(id).bind(&described).bind(market_slot).execute(pool).await?;
            sqlx::query("INSERT INTO market_observations(cluster,address,slot,state) SELECT $1,$2,$3,$4 WHERE NOT EXISTS(SELECT 1 FROM market_observations WHERE cluster=$1 AND address=$2 AND observed_at>now()-interval '30 seconds') ON CONFLICT DO NOTHING").bind(cluster).bind(market).bind(market_slot).bind(described).execute(pool).await?;
            let v = finalized_account(
                rpc,
                state["fee_vault"].as_str().context("Fee vault missing")?,
            )
            .await?;
            ensure!(
                v["value"]["owner"] == "dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh",
                "Fee owner mismatch"
            );
            let fees = native::invoke(
                &json!({"operation":"fee_vault","vault_data":v["value"]["data"][0]}),
            )
            .await?;
            let mut actual = fees["recipients"]
                .as_array()
                .context("Recipients missing")?
                .iter()
                .map(|v| {
                    (
                        v["wallet"].as_str().unwrap_or("").to_owned(),
                        v["share"].as_u64().unwrap_or(0),
                    )
                })
                .collect::<Vec<_>>();
            let mut expected = metadata["recipients"]
                .as_array()
                .context("Policy missing")?
                .iter()
                .map(|v| {
                    (
                        v["wallet"].as_str().unwrap_or("").to_owned(),
                        v["share"].as_u64().unwrap_or(0),
                    )
                })
                .collect::<Vec<_>>();
            actual.sort();
            expected.sort();
            ensure!(actual == expected, "Fee recipient mismatch");
            sqlx::query("INSERT INTO fee_vaults(cluster,address,launch_id,quote_mint,recipients,verified) VALUES($1,$2,$3,$4,$5,true) ON CONFLICT(cluster,address) DO NOTHING").bind(cluster).bind(state["fee_vault"].as_str()).bind(id).bind(metadata["quote_mint"].as_str()).bind(&metadata["recipients"]).execute(pool).await?;
        }
        if state["module_initialized"] == true {
            let kind = if metadata["mechanism"] == "funding" {
                "escrow"
            } else {
                "reserve"
            };
            let vault = plan["accounts"]["module_vault"]
                .as_str()
                .context("Module missing")?;
            let (data, module_slot) = contracts::snapshot(rpc, kind, vault, None).await?;
            sqlx::query("INSERT INTO contract_accounts(cluster,address,kind,program_id,data,context_slot) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(cluster,address) DO UPDATE SET data=$5,context_slot=$6,observed_at=now() WHERE contract_accounts.context_slot<=$6").bind(cluster).bind(vault).bind(kind).bind(contracts::program(kind)?).bind(data).bind(i64::try_from(module_slot)?).execute(pool).await?;
        }
        let label = match phase {
            0 => "declared",
            1 => "config_ready",
            2 => "trading",
            3 => "migrated",
            4 => "funded",
            _ => "unknown",
        };
        sqlx::query("UPDATE launches SET state=$2 WHERE id=$1")
            .bind(id)
            .bind(label)
            .execute(pool)
            .await?;
    }
    Ok(())
}

async fn finalized_account(rpc: &Rpc, address: &str) -> Result<Value> {
    rpc.call(
        "getAccountInfo",
        json!([address,{"encoding":"base64","commitment":"finalized"}]),
    )
    .await
}
