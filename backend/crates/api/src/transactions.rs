use crate::{
    AppState,
    auth::Actor,
    error::{ApiError, ApiResult},
};
use axum::{
    Json,
    extract::{Path, State},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use depthguard_domain::money::public_key;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;
const DFS: &str = "dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh";
pub async fn vault(
    State(s): State<AppState>,
    Path(address): Path<String>,
) -> ApiResult<Json<Value>> {
    let (data, slot) = vault_snapshot(&s, &address).await?;
    let description = depthguard_infrastructure::native::invoke(
        &json!({"operation":"fee_vault","vault_data":data}),
    )
    .await
    .map_err(|_| ApiError::bad("Fee vault version unsupported"))?;
    Ok(Json(
        json!({"address":address,"cluster":s.config.cluster,"context_slot":slot,"state":description,"native_program":DFS,"platform_binding_verified":false}),
    ))
}
async fn vault_snapshot(s: &AppState, address: &str) -> ApiResult<(String, u64)> {
    public_key(address).map_err(ApiError::bad)?;
    s.rpc
        .verify_cluster(&s.config.cluster)
        .await
        .map_err(|_| ApiError::unavailable("RPC cluster verification failed"))?;
    let response = s
        .rpc
        .account(address)
        .await
        .map_err(|_| ApiError::unavailable("Fee vault unavailable"))?;
    if response["value"]["owner"] != DFS {
        return Err(ApiError::bad(
            "Account is not owned by the native fee-sharing program",
        ));
    }
    Ok((
        response["value"]["data"][0]
            .as_str()
            .ok_or_else(|| ApiError::bad("Invalid fee vault encoding"))?
            .into(),
        response["context"]["slot"]
            .as_u64()
            .ok_or_else(|| ApiError::bad("Missing context slot"))?,
    ))
}
pub async fn prepare_claim(
    State(s): State<AppState>,
    actor: Actor,
    Path(address): Path<String>,
) -> ApiResult<Json<Value>> {
    let (data, slot) = vault_snapshot(&s, &address).await?;
    let instruction = depthguard_infrastructure::native::invoke(
        &json!({"operation":"fee_claim","vault_data":data,"vault":address,"wallet":actor.wallet}),
    )
    .await
    .map_err(|_| ApiError::bad("Wallet has no supported claimable fees"))?;
    let mint = instruction["quote_mint"]
        .as_str()
        .ok_or_else(|| ApiError::bad("Missing quote mint"))?;
    let mint_state = s
        .rpc
        .account(mint)
        .await
        .map_err(|_| ApiError::unavailable("Quote mint unavailable"))?;
    const TOKEN: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    if mint_state["value"]["owner"] != TOKEN {
        return Err(ApiError::bad(
            "Only standard SPL quote mints are supported for claims",
        ));
    }
    let receiver = instruction["receiver"]
        .as_str()
        .ok_or_else(|| ApiError::bad("Missing receiver"))?;
    // Idempotent ATA creation is safe when the recipient already has an account.
    let ata = json!({"program_id":"ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL","accounts":[
        {"address":actor.wallet,"signer":true,"writable":true},{"address":receiver,"signer":false,"writable":true},
        {"address":actor.wallet,"signer":false,"writable":false},{"address":mint,"signer":false,"writable":false},
        {"address":"11111111111111111111111111111111","signer":false,"writable":false},{"address":TOKEN,"signer":false,"writable":false}],"data":STANDARD.encode([1u8])});
    let latest = s
        .rpc
        .call(
            "getLatestBlockhash",
            json!([{"commitment":"confirmed","minContextSlot":slot}]),
        )
        .await
        .map_err(|_| ApiError::unavailable("Blockhash unavailable"))?;
    let height = latest["value"]["lastValidBlockHeight"]
        .as_i64()
        .ok_or_else(|| ApiError::bad("Invalid block height"))?;
    let built=depthguard_infrastructure::native::invoke(&json!({"operation":"message","payer":actor.wallet,"blockhash":latest["value"]["blockhash"],"instructions":[ata,instruction]})).await.map_err(|_|ApiError::bad("Native transaction preparation failed"))?;
    let wire = built["transaction"]
        .as_str()
        .ok_or_else(|| ApiError::bad("Missing unsigned wire"))?;
    let simulated=s.rpc.call("simulateTransaction",json!([wire,{"encoding":"base64","sigVerify":false,"replaceRecentBlockhash":false,"commitment":"confirmed","minContextSlot":slot}])).await.map_err(|_|ApiError::bad("Claim simulation unavailable"))?;
    if !simulated["value"]["err"].is_null() {
        return Err(ApiError::bad("Native program rejected claim simulation"));
    }
    let message = STANDARD
        .decode(
            built["message"]
                .as_str()
                .ok_or_else(|| ApiError::bad("Missing message"))?,
        )
        .map_err(|_| ApiError::bad("Invalid message encoding"))?;
    let id = Uuid::new_v4();
    let summary = json!({"kind":"dfs_claim","vault":address,"recipient":actor.wallet,"quote_mint":mint,"expected_pending":instruction["pending"],"context_slot":slot,"simulation":"unsigned_simulation","prepared_without_broadcast":true,"instructions":["create_recipient_ata_idempotent","claim_native_fee"]});
    sqlx::query("INSERT INTO prepared_transactions(id,owner_id,cluster,message,required_signers,last_valid_block_height,summary,unsigned_wire) VALUES($1,$2,$3,$4,$5,$6,$7,$8)")
        .bind(id).bind(actor.id).bind(&s.config.cluster).bind(message).bind(&built["required_signers"]).bind(height).bind(&summary).bind(STANDARD.decode(wire).map_err(|_| ApiError::bad("Invalid prepared wire"))?).execute(&s.pool).await?;
    Ok(Json(
        json!({"id":id,"state":"prepared","transaction":wire,"required_signers":built["required_signers"],"last_valid_block_height":height,"summary":summary,"broadcast_enabled":s.config.chain_writes}),
    ))
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SubmitInput {
    transaction: String,
}
pub async fn submit(
    State(s): State<AppState>,
    actor: Actor,
    Path(id): Path<Uuid>,
    Json(input): Json<SubmitInput>,
) -> ApiResult<Json<Value>> {
    if !s.config.chain_writes {
        return Err(ApiError::unavailable(
            "Broadcast is disabled for this deployment",
        ));
    }
    let wire = STANDARD
        .decode(&input.transaction)
        .map_err(|_| ApiError::bad("Invalid transaction encoding"))?;
    let mut tx = s.pool.begin().await?;
    let row=sqlx::query("SELECT message,required_signers,state,signature,cluster FROM prepared_transactions WHERE id=$1 AND owner_id=$2 FOR UPDATE").bind(id).bind(actor.id).fetch_optional(&mut *tx).await?.ok_or_else(ApiError::not_found)?;
    let signers: Vec<String> = serde_json::from_value(row.get("required_signers"))
        .map_err(|_| ApiError::bad("Invalid stored signer list"))?;
    if signers.first() != Some(&actor.wallet) || row.get::<String, _>("cluster") != s.config.cluster
    {
        return Err(ApiError::forbidden());
    }
    let message: Vec<u8> = row.get("message");
    let signature =
        depthguard_application::transaction::verify_signed_wire(&wire, &message, &signers)
            .map_err(ApiError::bad)?;
    let state: String = row.get("state");
    if state != "prepared" {
        if row.get::<Option<String>, _>("signature").as_ref() != Some(&signature) {
            return Err(ApiError::conflict(
                "Transaction was already submitted with another signature",
            ));
        }
        return Ok(Json(json!({"id":id,"signature":signature,"state":state})));
    }
    sqlx::query("UPDATE prepared_transactions SET signed_wire=$2,signature=$3,state='submitted',updated_at=now() WHERE id=$1").bind(id).bind(wire).bind(&signature).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO jobs(id,kind,payload,max_attempts) VALUES($1,'broadcast',$2,10)")
        .bind(Uuid::new_v4())
        .bind(json!({"transaction_id":id}))
        .execute(&mut *tx)
        .await?;
    depthguard_infrastructure::store::audit(&mut tx, actor.id, "transaction.submit", id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"id":id,"signature":signature,"state":"submitted"}),
    ))
}
pub async fn get(
    State(s): State<AppState>,
    actor: Actor,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let row=sqlx::query("SELECT state,signature,cluster,summary,last_valid_block_height,unsigned_wire FROM prepared_transactions WHERE id=$1 AND owner_id=$2").bind(id).bind(actor.id).fetch_optional(&s.pool).await?.ok_or_else(ApiError::not_found)?;
    Ok(Json(
        json!({"id":id,"state":row.get::<String,_>("state"),"signature":row.get::<Option<String>,_>("signature"),"cluster":row.get::<String,_>("cluster"),"summary":row.get::<Value,_>("summary"),"last_valid_block_height":row.get::<i64,_>("last_valid_block_height"),"transaction":row.get::<Option<Vec<u8>>,_>("unsigned_wire").map(|w|STANDARD.encode(w))}),
    ))
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SweepInput {
    pub protocol: String,
}
pub async fn prepare_sweep(
    State(s): State<AppState>,
    actor: Actor,
    Path(id): Path<Uuid>,
    Json(input): Json<SweepInput>,
) -> ApiResult<Json<Value>> {
    if !["dbc", "damm_v2"].contains(&input.protocol.as_str()) {
        return Err(ApiError::bad("Unsupported fee source protocol"));
    }
    let market=sqlx::query("SELECT m.address,l.metadata FROM markets m JOIN launches l ON l.id=m.launch_id WHERE m.cluster=$1 AND m.launch_id=$2 AND m.protocol=$3").bind(&s.config.cluster).bind(id).bind(&input.protocol).fetch_optional(&s.pool).await?.ok_or_else(ApiError::not_found)?;
    let vault: String = sqlx::query_scalar(
        "SELECT address FROM fee_vaults WHERE cluster=$1 AND launch_id=$2 AND verified",
    )
    .bind(&s.config.cluster)
    .bind(id)
    .fetch_optional(&s.pool)
    .await?
    .ok_or_else(ApiError::not_found)?;
    let metadata: Value = market.get("metadata");
    if !metadata["recipients"]
        .as_array()
        .is_some_and(|v| v.iter().any(|r| r["wallet"] == actor.wallet))
    {
        return Err(ApiError::forbidden());
    }
    let address: String = market.get("address");
    let (vault_data, slot) = vault_snapshot(&s, &vault).await?;
    let pool_response = s
        .rpc
        .account(&address)
        .await
        .map_err(|_| ApiError::unavailable("Fee source pool unavailable"))?;
    let expected = if input.protocol == "dbc" {
        "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"
    } else {
        "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"
    };
    if pool_response["value"]["owner"] != expected {
        return Err(ApiError::bad("Fee source pool owner mismatch"));
    }
    let mut request = json!({"operation":"fee_sweep","protocol":input.protocol,"pool":address,"wallet":actor.wallet,"vault":vault,"vault_data":vault_data,"pool_data":pool_response["value"]["data"][0]});
    let keys =
        sqlx::query("SELECT purpose,public_key FROM launch_account_signers WHERE launch_id=$1")
            .bind(id)
            .fetch_all(&s.pool)
            .await?;
    let keys: std::collections::BTreeMap<String, String> = keys
        .into_iter()
        .map(|r| (r.get("purpose"), r.get("public_key")))
        .collect();
    if input.protocol == "dbc" {
        let config = s
            .rpc
            .account(&keys["config"])
            .await
            .map_err(|_| ApiError::unavailable("Fee config unavailable"))?;
        if config["value"]["owner"] != expected {
            return Err(ApiError::bad("Config owner mismatch"));
        }
        request["config_data"] = config["value"]["data"][0].clone();
    } else {
        let mut migration = metadata.clone();
        migration["operation"] = json!("dbc_migrate");
        migration["wallet"] = metadata["launcher"].clone();
        migration["config"] = json!(keys["config"]);
        migration["base_mint"] = json!(keys["mint"]);
        let factory =
            sqlx::query_scalar::<_, Value>("SELECT plan FROM factory_launches WHERE launch_id=$1")
                .bind(id)
                .fetch_optional(&s.pool)
                .await?;
        let first = if let Some(plan) = factory {
            let (state, _) = depthguard_infrastructure::contracts::snapshot(
                &s.rpc,
                "launch",
                plan["accounts"]["launch"]
                    .as_str()
                    .ok_or_else(|| ApiError::bad("Launch address missing"))?,
                None,
            )
            .await
            .map_err(|_| ApiError::unavailable("Verified launch state unavailable"))?;
            if state["phase"].as_u64().unwrap_or(0) < 3 {
                return Err(ApiError::conflict(
                    "Verify migration before collecting DAMM fees",
                ));
            }
            state["first_position_mint"].clone()
        } else {
            json!(keys["first_position"])
        };
        migration["first_position_mint"] = first;
        migration["second_position_mint"] = json!(keys["second_position"]);
        migration["damm_config"] = if metadata["damm_config"].is_string() {
            metadata["damm_config"].clone()
        } else {
            json!(
                s.config
                    .damm_config
                    .as_ref()
                    .ok_or_else(|| ApiError::unavailable("DAMM migration config missing"))?
            )
        };
        let derived = depthguard_infrastructure::native::invoke(&migration)
            .await
            .map_err(|_| ApiError::bad("Position derivation failed"))?;
        request["position"] = derived["accounts"][7]["address"].clone();
        request["position_nft_account"] = derived["accounts"][6]["address"].clone();
    }
    let instructions = depthguard_infrastructure::native::invoke(&request)
        .await
        .map_err(|_| ApiError::bad("Native fee sweep rejected"))?;
    let latest = s
        .rpc
        .call(
            "getLatestBlockhash",
            json!([{"commitment":"confirmed","minContextSlot":slot}]),
        )
        .await
        .map_err(|_| ApiError::unavailable("Blockhash unavailable"))?;
    let built=depthguard_infrastructure::native::invoke(&json!({"operation":"message","payer":actor.wallet,"blockhash":latest["value"]["blockhash"],"instructions":instructions["instructions"]})).await.map_err(|_|ApiError::bad("Fee sweep message cannot be compiled"))?;
    let wire = built["transaction"]
        .as_str()
        .ok_or_else(|| ApiError::bad("Missing transaction"))?;
    let simulated=s.rpc.call("simulateTransaction",json!([wire,{"encoding":"base64","sigVerify":false,"replaceRecentBlockhash":false,"commitment":"confirmed","minContextSlot":slot}])).await.map_err(|_|ApiError::unavailable("Fee sweep simulation unavailable"))?;
    if !simulated["value"]["err"].is_null() {
        return Err(ApiError::bad("Native fee sweep simulation rejected"));
    }
    let prepared = Uuid::new_v4();
    let height = latest["value"]["lastValidBlockHeight"]
        .as_i64()
        .ok_or_else(|| ApiError::bad("Block height missing"))?;
    let summary = json!({"kind":"dfs_fee_sweep","source":input.protocol,"launch_id":id,"vault":vault,"basis":"native_claimed_trading_fees_only","context_slot":slot,"prepared_without_broadcast":true});
    let mut tx = s.pool.begin().await?;
    sqlx::query("INSERT INTO prepared_transactions(id,owner_id,launch_id,cluster,message,required_signers,last_valid_block_height,summary,unsigned_wire) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)").bind(prepared).bind(actor.id).bind(id).bind(&s.config.cluster).bind(STANDARD.decode(built["message"].as_str().ok_or_else(||ApiError::bad("Message missing"))?).map_err(|_|ApiError::bad("Invalid message"))?).bind(&built["required_signers"]).bind(height).bind(&summary).bind(STANDARD.decode(wire).map_err(|_|ApiError::bad("Invalid wire"))?).execute(&mut *tx).await?;
    depthguard_infrastructure::store::audit(&mut tx, actor.id, "fee_sweep.prepare", prepared)
        .await?;
    tx.commit().await?;
    Ok(Json(
        json!({"id":prepared,"state":"prepared","transaction":wire,"required_signers":built["required_signers"],"last_valid_block_height":height,"summary":summary,"broadcast_enabled":s.config.chain_writes}),
    ))
}
