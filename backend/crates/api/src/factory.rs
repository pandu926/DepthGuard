use crate::{
    AppState,
    auth::Actor,
    error::{ApiError, ApiResult},
};
use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use depthguard_domain::economy::Economy;
use depthguard_infrastructure::{contracts, native, signer};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;
#[derive(Deserialize, serde::Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FactoryInput {
    pub model_version_id: Uuid,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub reviewers: Vec<String>,
}
pub async fn create(
    State(s): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Json(input): Json<FactoryInput>,
) -> ApiResult<Json<Value>> {
    if !s.config.contracts_enabled {
        return Err(ApiError::unavailable("Factory contracts are disabled"));
    }
    let encryption = s.config.encryption_key.as_ref().ok_or_else(|| {
        ApiError::unavailable("Factory account signer encryption is not configured")
    })?;
    if input.name.trim().is_empty()
        || input.name.len() > 32
        || input.symbol.is_empty()
        || input.symbol.len() > 10
        || input.uri.len() > 200
        || !(input.uri.starts_with("https://") || input.uri.starts_with("ipfs://"))
    {
        return Err(ApiError::bad("Invalid token identity or metadata URI"));
    }
    for r in &input.reviewers {
        depthguard_domain::money::public_key(r).map_err(ApiError::bad)?;
    }
    let key = headers
        .get("idempotency-key")
        .and_then(|h| h.to_str().ok())
        .filter(|k| !k.is_empty() && k.len() <= 128)
        .ok_or_else(|| ApiError::bad("Idempotency-Key is required"))?;
    let hash = depthguard_domain::economy::hash_value(&json!(input));
    let mut tx = s.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("{}:factory:{key}", actor.id))
        .execute(&mut *tx)
        .await?;
    if let Some(r)=sqlx::query("SELECT request_hash,response FROM idempotency_keys WHERE owner_id=$1 AND scope='factory' AND key=$2").bind(actor.id).bind(key).fetch_optional(&mut *tx).await? {if r.get::<String,_>("request_hash")!=hash{return Err(ApiError::conflict("Idempotency key belongs to another launch"));}return Ok(Json(r.get("response")));}
    let row=sqlx::query("SELECT v.economy,v.source_version_id,m.owner_id FROM model_versions v JOIN models m ON m.id=v.model_id WHERE v.id=$1").bind(input.model_version_id).fetch_optional(&mut *tx).await?.ok_or_else(ApiError::not_found)?;
    let economy: Economy =
        serde_json::from_value(row.get("economy")).map_err(|_| ApiError::bad("Invalid model"))?;
    economy
        .contract_native_parameters()
        .map_err(ApiError::bad)?;
    let funding = matches!(
        economy.mechanism,
        depthguard_domain::economy::Mechanism::Funding
    );
    let threshold = economy
        .module
        .as_ref()
        .map(|m| m.reviewer_threshold)
        .unwrap_or(0) as usize;
    let unique: std::collections::BTreeSet<_> = input.reviewers.iter().collect();
    if funding {
        if !(3..=5).contains(&input.reviewers.len())
            || unique.len() != input.reviewers.len()
            || input.reviewers.contains(&actor.wallet)
            || threshold * 2 <= input.reviewers.len()
        {
            return Err(ApiError::bad(
                "Funding requires distinct reviewers excluding the beneficiary and a strict majority",
            ));
        }
    } else if !input.reviewers.is_empty() {
        return Err(ApiError::bad("This mechanism has no reviewers"));
    }
    s.rpc
        .verify_cluster(&s.config.cluster)
        .await
        .map_err(|_| ApiError::unavailable("RPC identity unavailable"))?;
    let address = native::invoke(&json!({"operation":"factory_platform"}))
        .await
        .map_err(|_| ApiError::unavailable("Platform adapter unavailable"))?;
    let state = s
        .rpc
        .account(address["address"].as_str().unwrap_or(""))
        .await
        .map_err(|_| ApiError::unavailable("Platform account unavailable"))?;
    if state["value"]["owner"] != contracts::REGISTRY {
        return Err(ApiError::unavailable("Factory platform is not initialized"));
    }
    let platform =
        native::invoke(&json!({"operation":"factory_platform","data":state["value"]["data"][0]}))
            .await
            .map_err(|_| ApiError::unavailable("Platform state unsupported"))?;
    if platform["paused"] == true {
        return Err(ApiError::unavailable("New factory launches are paused"));
    }
    let binding=sqlx::query("SELECT publisher,model_address FROM model_registry_bindings WHERE cluster=$1 AND version_id=$2").bind(&s.config.cluster).bind(input.model_version_id).fetch_optional(&mut *tx).await?;
    if binding.is_none() && row.get::<Uuid, _>("owner_id") != actor.id {
        return Err(ApiError::conflict(
            "Model owner must register this version before other wallets can launch it",
        ));
    }
    let parent = if let Some(source) = row.get::<Option<Uuid>, _>("source_version_id") {
        sqlx::query_scalar::<_, String>(
            "SELECT model_address FROM model_registry_bindings WHERE cluster=$1 AND version_id=$2",
        )
        .bind(&s.config.cluster)
        .bind(source)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| {
            ApiError::conflict("Register the original model before publishing its official fork")
        })?
    } else {
        "11111111111111111111111111111111".into()
    };
    let publisher = binding
        .as_ref()
        .map(|r| r.get::<String, _>("publisher"))
        .unwrap_or_else(|| actor.wallet.clone());
    let id = Uuid::new_v4();
    let mut signers = serde_json::Map::new();
    let mut secret_records = Vec::new();
    for purpose in [
        "config",
        "mint",
        "fee_base",
        "first_position",
        "second_position",
    ] {
        let (public, encrypted) = signer::create(encryption, id, purpose)
            .map_err(|_| ApiError::unavailable("Signer generation failed"))?;
        signers.insert(purpose.into(), json!(public));
        secret_records.push((purpose, public, encrypted));
    }
    let recipients = ordered_recipients([
        (actor.wallet.as_str(), economy.fee_policy.launcher_bps),
        (
            economy.fee_policy.author.as_str(),
            economy.fee_policy.author_bps,
        ),
        (
            platform["recipient"].as_str().unwrap_or(""),
            economy.fee_policy.platform_bps,
        ),
    ]);
    let nonce = u64::from_le_bytes(id.as_bytes()[..8].try_into().unwrap()).to_string();
    let plan=native::invoke(&json!({"operation":"factory_plan","wallet":actor.wallet,"publisher":publisher,"parent":parent,"author":economy.fee_policy.author,"economy":economy,"nonce":nonce,"config":signers["config"],"base_mint":signers["mint"],"fee_base":signers["fee_base"],"first_position_mint":signers["first_position"],"quote_mint":"So11111111111111111111111111111111111111112","name":input.name,"symbol":input.symbol,"uri":input.uri,"reviewers":input.reviewers,"recipients":recipients})).await.map_err(|_|ApiError::bad("Factory model or instruction compilation failed"))?;
    let metadata = json!({"name":input.name,"symbol":input.symbol,"uri":input.uri,"mechanism":economy.mechanism,"launcher":actor.wallet,"publisher":publisher,"quote_mint":"So11111111111111111111111111111111111111112","base_decimals":economy.base_decimals,"parameters":economy.contract_native_parameters().map_err(ApiError::bad)?,"recipients":recipients,"model_hash":plan["encoded"]["canonical_json_hash"],"damm_config":platform["damm_config"]});
    sqlx::query("INSERT INTO launches(id,owner_id,model_version_id,cluster,metadata) VALUES($1,$2,$3,$4,$5)").bind(id).bind(actor.id).bind(input.model_version_id).bind(&s.config.cluster).bind(&metadata).execute(&mut *tx).await?;
    for (purpose, public, encrypted) in secret_records {
        sqlx::query("INSERT INTO launch_account_signers(launch_id,purpose,public_key,encrypted_key) VALUES($1,$2,$3,$4)").bind(id).bind(purpose).bind(public).bind(encrypted).execute(&mut *tx).await?;
    }
    sqlx::query("INSERT INTO factory_launches(launch_id,model_address,launch_address,plan,metadata) VALUES($1,$2,$3,$4,$5)").bind(id).bind(plan["accounts"]["model"].as_str()).bind(plan["accounts"]["launch"].as_str()).bind(&plan).bind(&metadata).execute(&mut *tx).await?;
    let response = json!({"id":id,"address":plan["accounts"]["launch"],"state":"draft"});
    sqlx::query("INSERT INTO idempotency_keys(owner_id,scope,key,request_hash,response) VALUES($1,'factory',$2,$3,$4)").bind(actor.id).bind(key).bind(hash).bind(&response).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(response))
}
pub async fn get(
    State(s): State<AppState>,
    actor: Actor,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let r=sqlx::query("SELECT f.plan,f.metadata,l.state FROM factory_launches f JOIN launches l ON l.id=f.launch_id WHERE f.launch_id=$1 AND l.owner_id=$2 AND l.cluster=$3").bind(id).bind(actor.id).bind(&s.config.cluster).fetch_optional(&s.pool).await?.ok_or_else(ApiError::not_found)?;
    let steps=sqlx::query("SELECT w.step,w.transaction_id,p.state,p.signature FROM workflow_steps w LEFT JOIN prepared_transactions p ON p.id=w.transaction_id WHERE w.launch_id=$1").bind(id).fetch_all(&s.pool).await?;
    let plan: Value = r.get("plan");
    Ok(Json(
        json!({"id":id,"state":r.get::<String,_>("state"),"metadata":r.get::<Value,_>("metadata"),"accounts":plan["accounts"],"steps":plan["steps"].as_array().unwrap().iter().map(|v|v["step"].clone()).collect::<Vec<_>>(),"transactions":steps.into_iter().map(|r|json!({"step":r.get::<String,_>("step"),"id":r.get::<Option<Uuid>,_>("transaction_id"),"state":r.get::<Option<String>,_>("state"),"signature":r.get::<Option<String>,_>("signature")})).collect::<Vec<_>>()}),
    ))
}
pub async fn next(
    State(s): State<AppState>,
    actor: Actor,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    if !s.config.contracts_enabled {
        return Err(ApiError::unavailable("Factory contracts are disabled"));
    }
    s.rpc
        .verify_cluster(&s.config.cluster)
        .await
        .map_err(|_| ApiError::unavailable("RPC identity unavailable"))?;
    let encryption = s
        .config
        .encryption_key
        .as_ref()
        .ok_or_else(|| ApiError::unavailable("Signer encryption unavailable"))?;
    let mut tx = s.pool.begin().await?;
    let row=sqlx::query("SELECT f.plan,l.model_version_id FROM factory_launches f JOIN launches l ON l.id=f.launch_id WHERE f.launch_id=$1 AND l.owner_id=$2 AND l.cluster=$3 FOR UPDATE OF l").bind(id).bind(actor.id).bind(&s.config.cluster).fetch_optional(&mut *tx).await?.ok_or_else(ApiError::not_found)?;
    let plan: Value = row.get("plan");
    let native_migrated = native_migrated(&s, &plan).await.unwrap_or(false);
    let current = contracts::snapshot(
        &s.rpc,
        "launch",
        plan["accounts"]["launch"].as_str().unwrap_or(""),
        None,
    )
    .await
    .ok()
    .map(|v| v.0);
    for step in plan["steps"]
        .as_array()
        .ok_or_else(|| ApiError::bad("Factory plan missing"))?
    {
        let name = step["step"].as_str().unwrap();
        if let Some(c) = &current {
            let phase = c["phase"].as_u64().unwrap_or(0);
            if (name == "initialize_launch")
                || (name == "create_config" && phase >= 1)
                || (name == "create_pool" && phase >= 2)
                || (name == "initialize_module" && c["module_initialized"] == true)
                || (name == "native_migration" && (phase >= 3 || native_migrated))
                || (name == "verify_migration" && phase >= 3)
                || (name == "fund_and_activate" && phase >= 4)
            {
                continue;
            }
        }
        if name.contains("model")
            && let Ok((m, _)) = contracts::snapshot(
                &s.rpc,
                "model",
                plan["accounts"]["model"].as_str().unwrap(),
                None,
            )
            .await
        {
            if m["sealed"] == true {
                verify_model_binding(&m, &plan)?;
                sqlx::query("INSERT INTO model_registry_bindings(cluster,version_id,publisher,model_address,json_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING").bind(&s.config.cluster).bind(row.get::<Uuid,_>("model_version_id")).bind(plan["accounts"]["publisher"].as_str()).bind(plan["accounts"]["model"].as_str()).bind(plan["encoded"]["canonical_json_hash"].as_str()).execute(&mut *tx).await?;
                continue;
            }
            let uploaded = m["uploaded_bytes"].as_u64().unwrap_or(0);
            if name == "begin_model"
                || name.starts_with("write_model_")
                    && uploaded
                        >= (name
                            .trim_start_matches("write_model_")
                            .parse::<u64>()
                            .unwrap_or(0)
                            * 600
                            + 600)
                            .min(plan["encoded"]["size"].as_u64().unwrap_or(0))
            {
                continue;
            }
        }
        let existing=sqlx::query("SELECT p.id,p.state,p.unsigned_wire,p.last_valid_block_height FROM workflow_steps w JOIN prepared_transactions p ON p.id=w.transaction_id WHERE w.launch_id=$1 AND w.step=$2").bind(id).bind(name).fetch_optional(&mut *tx).await?;
        if let Some(p) = existing {
            let state: String = p.get("state");
            if state == "finalized" {
                continue;
            }
            if ["prepared", "submitted", "confirmed"].contains(&state.as_str()) {
                let height = s
                    .rpc
                    .call("getBlockHeight", json!([{"commitment":"finalized"}]))
                    .await
                    .map_err(|_| ApiError::unavailable("Block height unavailable"))?
                    .as_i64()
                    .unwrap_or(0);
                if state != "prepared" || height <= p.get::<i64, _>("last_valid_block_height") {
                    return Ok(Json(
                        json!({"id":p.get::<Uuid,_>("id"),"state":state,"step":name,"transaction":STANDARD.encode(p.get::<Vec<u8>,_>("unsigned_wire"))}),
                    ));
                }
                sqlx::query("UPDATE prepared_transactions SET state='expired' WHERE id=$1")
                    .bind(p.get::<Uuid, _>("id"))
                    .execute(&mut *tx)
                    .await?;
            }
        }
        let ix = &step["instruction"];
        let latest = s
            .rpc
            .call("getLatestBlockhash", json!([{"commitment":"confirmed"}]))
            .await
            .map_err(|_| ApiError::unavailable("Blockhash unavailable"))?;
        let built=native::invoke(&json!({"operation":"message","payer":actor.wallet,"blockhash":latest["value"]["blockhash"],"instructions":[ix]})).await.map_err(|_|ApiError::bad("Factory transaction exceeds wire limits"))?;
        let message = STANDARD
            .decode(built["message"].as_str().unwrap())
            .map_err(|_| ApiError::bad("Invalid message"))?;
        let mut wire = STANDARD
            .decode(built["transaction"].as_str().unwrap())
            .map_err(|_| ApiError::bad("Invalid wire"))?;
        if let Some(signers) = step["signers"].as_array() {
            for purpose in signers {
                let purpose = purpose.as_str().unwrap();
                let record=sqlx::query("SELECT public_key,encrypted_key FROM launch_account_signers WHERE launch_id=$1 AND purpose=$2").bind(id).bind(purpose).fetch_one(&mut *tx).await?;
                signer::partial_sign(
                    encryption,
                    signer::Identity {
                        launch: id,
                        purpose,
                        public: &record.get::<String, _>("public_key"),
                    },
                    &record.get::<Vec<u8>, _>("encrypted_key"),
                    &message,
                    &built["required_signers"],
                    &mut wire,
                )
                .map_err(|_| ApiError::unavailable("Factory account signing failed"))?;
            }
        }
        let encoded = STANDARD.encode(&wire);
        let sim = s
            .rpc
            .call(
                "simulateTransaction",
                json!([encoded,{"encoding":"base64","sigVerify":false,"commitment":"confirmed"}]),
            )
            .await
            .map_err(|_| ApiError::unavailable("Simulation unavailable"))?;
        if !sim["value"]["err"].is_null() {
            let logs = sim["value"]["logs"]
                .as_array()
                .map(|v| v.iter().rev().take(6).cloned().collect::<Vec<_>>());
            tracing::warn!(step=name,logs=?logs,"Factory simulation rejected");
            return Err(ApiError::bad(format!(
                "Factory {name} simulation rejected; check current state and wallet balance"
            )));
        }
        let tid = Uuid::new_v4();
        let summary = json!({"kind":"contract_action","action":name,"launch_id":id,"projections":step["projections"],"accounts":plan["accounts"],"program_id":ix["program_id"]});
        sqlx::query("INSERT INTO prepared_transactions(id,owner_id,launch_id,cluster,message,required_signers,last_valid_block_height,summary,unsigned_wire) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)").bind(tid).bind(actor.id).bind(id).bind(&s.config.cluster).bind(message).bind(&built["required_signers"]).bind(latest["value"]["lastValidBlockHeight"].as_i64().unwrap()).bind(&summary).bind(wire).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO workflow_steps(launch_id,step,state,transaction_id) VALUES($1,$2,'prepared',$3) ON CONFLICT(launch_id,step) DO UPDATE SET transaction_id=$3,state='prepared',updated_at=now()").bind(id).bind(name).bind(tid).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(Json(
            json!({"id":tid,"state":"prepared","step":name,"transaction":encoded,"summary":summary,"broadcast_enabled":s.config.chain_writes}),
        ));
    }
    let complete_state = match current.as_ref().and_then(|c| c["phase"].as_u64()) {
        Some(4) => "funded",
        Some(3) => "migrated",
        _ => "trading",
    };
    sqlx::query("UPDATE launches SET state=$2 WHERE id=$1")
        .bind(id)
        .bind(complete_state)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(
        json!({"state":"complete","address":plan["accounts"]["launch"]}),
    ))
}

pub async fn graduate(
    State(s): State<AppState>,
    actor: Actor,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    if !s.config.contracts_enabled {
        return Err(ApiError::unavailable("Factory contracts are disabled"));
    }
    s.rpc
        .verify_cluster(&s.config.cluster)
        .await
        .map_err(|_| ApiError::unavailable("RPC identity unavailable"))?;
    let mut tx = s.pool.begin().await?;
    let row=sqlx::query("SELECT f.plan,f.metadata FROM factory_launches f JOIN launches l ON l.id=f.launch_id WHERE l.id=$1 AND l.owner_id=$2 AND l.cluster=$3 FOR UPDATE OF l").bind(id).bind(actor.id).bind(&s.config.cluster).fetch_optional(&mut *tx).await?.ok_or_else(ApiError::not_found)?;
    let mut plan: Value = row.get("plan");
    let metadata: Value = row.get("metadata");
    let (state, _) = contracts::snapshot(
        &s.rpc,
        "launch",
        plan["accounts"]["launch"].as_str().unwrap(),
        None,
    )
    .await
    .map_err(|_| ApiError::unavailable("Launch state unavailable"))?;
    if state["phase"].as_u64().unwrap_or(0) < 2 {
        return Err(ApiError::conflict(
            "Complete token launch before graduation",
        ));
    }
    if !plan["steps"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["step"] == "native_migration")
    {
        let signers =
            sqlx::query("SELECT purpose,public_key FROM launch_account_signers WHERE launch_id=$1")
                .bind(id)
                .fetch_all(&mut *tx)
                .await?;
        let keys: std::collections::BTreeMap<String, String> = signers
            .into_iter()
            .map(|r| (r.get("purpose"), r.get("public_key")))
            .collect();
        let tail=native::invoke(&json!({"operation":"factory_graduation","accounts":plan["accounts"],"damm_config":metadata["damm_config"],"first_position_mint":state["first_position_mint"],"second_position_mint":keys["second_position"],"capital":metadata["mechanism"]=="funding"||metadata["mechanism"]=="backed"})).await.map_err(|_|ApiError::bad("Graduation derivation failed"))?;
        plan["steps"]
            .as_array_mut()
            .unwrap()
            .extend(tail["steps"].as_array().unwrap().iter().cloned());
        sqlx::query("UPDATE factory_launches SET plan=$2 WHERE launch_id=$1")
            .bind(id)
            .bind(&plan)
            .execute(&mut *tx)
            .await?;
    }
    if state["phase"] == 2 && native_migrated(&s, &plan).await? {
        let pool = plan["steps"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["step"] == "native_migration")
            .and_then(|v| v["instruction"]["damm_pool"].as_str())
            .ok_or_else(|| ApiError::bad("DAMM derivation missing"))?;
        let actual = resolve_position(&s, &plan, pool).await?;
        let args = json!({"operation":"factory_graduation","accounts":plan["accounts"],"damm_config":metadata["damm_config"],"first_position_mint":actual,"second_position_mint":state["first_position_mint"],"capital":false});
        let derived = native::invoke(&args)
            .await
            .map_err(|_| ApiError::bad("Verified position derivation failed"))?;
        let replacement = derived["steps"][1].clone();
        let in_flight: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workflow_steps w JOIN prepared_transactions p ON p.id=w.transaction_id WHERE w.launch_id=$1 AND w.step='verify_migration' AND p.state IN ('prepared','submitted','confirmed'))").bind(id).fetch_one(&mut *tx).await?;
        if !in_flight {
            for step in plan["steps"].as_array_mut().unwrap() {
                if step["step"] == "verify_migration" {
                    *step = replacement.clone();
                }
            }
            sqlx::query("UPDATE factory_launches SET plan=$2 WHERE launch_id=$1")
                .bind(id)
                .bind(&plan)
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;
    next(State(s), actor, Path(id)).await
}
fn verify_model_binding(state: &Value, plan: &Value) -> ApiResult<()> {
    if state["digest"] != plan["encoded"]["digest"]
        || state["json_hash"] != plan["encoded"]["json_hash"]
        || state["publisher"] != plan["accounts"]["publisher"]
    {
        return Err(ApiError::conflict(
            "Sealed model does not match this immutable economy version",
        ));
    }
    Ok(())
}
async fn native_migrated(s: &AppState, plan: &Value) -> ApiResult<bool> {
    let address = plan["accounts"]["pool"]
        .as_str()
        .ok_or_else(|| ApiError::bad("Pool missing"))?;
    let a = s
        .rpc
        .call(
            "getAccountInfo",
            json!([address,{"encoding":"base64","commitment":"finalized"}]),
        )
        .await
        .map_err(|_| ApiError::unavailable("Native pool unavailable"))?;
    if a["value"].is_null() {
        return Ok(false);
    }
    if a["value"]["owner"] != "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN" {
        return Err(ApiError::bad("Native pool owner mismatch"));
    }
    let native = native::invoke(
        &json!({"operation":"describe","protocol":"dbc","pool_data":a["value"]["data"][0]}),
    )
    .await
    .map_err(|_| ApiError::bad("Native pool decoding failed"))?;
    Ok(native["is_migrated"] == 1)
}
async fn resolve_position(s: &AppState, plan: &Value, pool: &str) -> ApiResult<String> {
    let vault = plan["accounts"]["fee_vault"].as_str().unwrap();
    let accounts = s.rpc.call("getTokenAccountsByOwner", json!([vault,{"programId":"TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"},{"encoding":"jsonParsed","commitment":"finalized"}])).await.map_err(|_| ApiError::unavailable("Position ownership unavailable"))?;
    let mut matches = Vec::new();
    for token in accounts["value"]
        .as_array()
        .ok_or_else(|| ApiError::bad("Position token accounts missing"))?
        .iter()
        .take(100)
    {
        let info = &token["account"]["data"]["parsed"]["info"];
        if info["owner"] != vault
            || info["tokenAmount"]["amount"] != "1"
            || info["tokenAmount"]["decimals"] != 0
        {
            continue;
        }
        let Some(mint) = info["mint"].as_str() else {
            continue;
        };
        let derived =
            native::invoke(&json!({"operation":"factory_position","pool":pool,"mint":mint}))
                .await
                .map_err(|_| ApiError::bad("Position address derivation failed"))?;
        if token["pubkey"] != derived["nft"] {
            continue;
        }
        let position = s
            .rpc
            .call(
                "getAccountInfo",
                json!([derived["position"],{"encoding":"base64","commitment":"finalized"}]),
            )
            .await
            .map_err(|_| ApiError::unavailable("Position state unavailable"))?;
        if position["value"]["owner"] != "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG" {
            continue;
        }
        if native::invoke(&json!({"operation":"factory_position","pool":pool,"mint":mint,"data":position["value"]["data"][0]})).await.is_ok() { matches.push(mint.to_owned()); }
    }
    if matches.len() != 1 {
        return Err(ApiError::conflict(
            "Expected one verifiable native fee-vault position",
        ));
    }
    Ok(matches.remove(0))
}
pub async fn register_model(
    State(s): State<AppState>,
    actor: Actor,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    if !s.config.contracts_enabled {
        return Err(ApiError::unavailable("Factory contracts are disabled"));
    }
    s.rpc
        .verify_cluster(&s.config.cluster)
        .await
        .map_err(|_| ApiError::unavailable("RPC identity unavailable"))?;
    let mut tx = s.pool.begin().await?;
    let row=sqlx::query("SELECT v.economy,v.source_version_id FROM model_versions v JOIN models m ON m.id=v.model_id WHERE v.id=$1 AND m.owner_id=$2 FOR UPDATE OF m").bind(id).bind(actor.id).fetch_optional(&mut *tx).await?.ok_or_else(ApiError::not_found)?;
    let plan = if let Some(plan) = sqlx::query_scalar::<_, Value>(
        "SELECT plan FROM model_publications WHERE cluster=$1 AND version_id=$2",
    )
    .bind(&s.config.cluster)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    {
        plan
    } else {
        let economy: Economy = serde_json::from_value(row.get("economy"))
            .map_err(|_| ApiError::bad("Invalid economy"))?;
        let parent = if let Some(source) = row.get::<Option<Uuid>, _>("source_version_id") {
            sqlx::query_scalar::<_,String>("SELECT model_address FROM model_registry_bindings WHERE cluster=$1 AND version_id=$2").bind(&s.config.cluster).bind(source).fetch_optional(&mut *tx).await?.ok_or_else(||ApiError::conflict("Register the original model before its fork"))?
        } else {
            "11111111111111111111111111111111".into()
        };
        let plan=native::invoke(&json!({"operation":"factory_publication","publisher":actor.wallet,"parent":parent,"author":economy.fee_policy.author,"economy":economy})).await.map_err(|_|ApiError::bad("Model is outside the executable factory profile"))?;
        sqlx::query(
            "INSERT INTO model_publications(cluster,version_id,publisher,plan) VALUES($1,$2,$3,$4)",
        )
        .bind(&s.config.cluster)
        .bind(id)
        .bind(&actor.wallet)
        .bind(&plan)
        .execute(&mut *tx)
        .await?;
        plan
    };
    let model = plan["accounts"]["model"].as_str().unwrap();
    let state = contracts::snapshot(&s.rpc, "model", model, None)
        .await
        .ok()
        .map(|v| v.0);
    if state.as_ref().is_some_and(|s| s["sealed"] == true) {
        verify_model_binding(state.as_ref().unwrap(), &plan)?;
        sqlx::query("INSERT INTO model_registry_bindings(cluster,version_id,publisher,model_address,json_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING").bind(&s.config.cluster).bind(id).bind(&actor.wallet).bind(model).bind(plan["encoded"]["canonical_json_hash"].as_str()).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(Json(json!({"state":"complete","model":model})));
    }
    for step in plan["steps"].as_array().unwrap() {
        let name = step["step"].as_str().unwrap();
        if let Some(m) = &state {
            let uploaded = m["uploaded_bytes"].as_u64().unwrap_or(0);
            if name == "begin_model"
                || (name.starts_with("write_model_")
                    && uploaded
                        >= ((name
                            .trim_start_matches("write_model_")
                            .parse::<u64>()
                            .unwrap_or(0)
                            + 1)
                            * 600)
                            .min(plan["encoded"]["size"].as_u64().unwrap_or(0)))
            {
                continue;
            }
        }
        if let Some(p)=sqlx::query("SELECT p.id,p.state,p.unsigned_wire,p.last_valid_block_height FROM model_publication_steps w JOIN prepared_transactions p ON p.id=w.transaction_id WHERE w.cluster=$1 AND w.version_id=$2 AND w.step=$3").bind(&s.config.cluster).bind(id).bind(name).fetch_optional(&mut *tx).await?{let status:String=p.get("state");if status=="finalized"{continue;}
if ["prepared","submitted","confirmed"].contains(&status.as_str()){let height=s.rpc.call("getBlockHeight",json!([{"commitment":"finalized"}])).await.map_err(|_|ApiError::unavailable("Height unavailable"))?.as_i64().unwrap_or(0);if status!="prepared"||height<=p.get::<i64,_>("last_valid_block_height"){return Ok(Json(json!({"id":p.get::<Uuid,_>("id"),"state":status,"transaction":STANDARD.encode(p.get::<Vec<u8>,_>("unsigned_wire")),"step":name})));}sqlx::query("UPDATE prepared_transactions SET state='expired' WHERE id=$1").bind(p.get::<Uuid,_>("id")).execute(&mut *tx).await?;}}
        let latest = s
            .rpc
            .call("getLatestBlockhash", json!([{"commitment":"confirmed"}]))
            .await
            .map_err(|_| ApiError::unavailable("Blockhash unavailable"))?;
        let built=native::invoke(&json!({"operation":"message","payer":actor.wallet,"blockhash":latest["value"]["blockhash"],"instructions":[step["instruction"]]})).await.map_err(|_|ApiError::bad("Publication wire exceeds limits"))?;
        let wire = built["transaction"].as_str().unwrap();
        let sim = s
            .rpc
            .call(
                "simulateTransaction",
                json!([wire,{"encoding":"base64","sigVerify":false,"commitment":"confirmed"}]),
            )
            .await
            .map_err(|_| ApiError::unavailable("Publication simulation unavailable"))?;
        if !sim["value"]["err"].is_null() {
            return Err(ApiError::bad(
                "Publication simulation rejected; check wallet funding and platform state",
            ));
        }
        let tid = Uuid::new_v4();
        let summary = json!({"kind":"contract_action","action":name,"model_version_id":id,"projections":[{"address":model,"kind":"model"}]});
        sqlx::query("INSERT INTO prepared_transactions(id,owner_id,cluster,message,required_signers,last_valid_block_height,summary,unsigned_wire) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(tid).bind(actor.id).bind(&s.config.cluster).bind(STANDARD.decode(built["message"].as_str().unwrap()).map_err(|_|ApiError::bad("Invalid message"))?).bind(&built["required_signers"]).bind(latest["value"]["lastValidBlockHeight"].as_i64().unwrap()).bind(summary).bind(STANDARD.decode(wire).map_err(|_|ApiError::bad("Invalid wire"))?).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO model_publication_steps(cluster,version_id,step,transaction_id) VALUES($1,$2,$3,$4) ON CONFLICT(cluster,version_id,step) DO UPDATE SET transaction_id=$4").bind(&s.config.cluster).bind(id).bind(name).bind(tid).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(Json(
            json!({"id":tid,"state":"prepared","transaction":wire,"step":name,"broadcast_enabled":s.config.chain_writes}),
        ));
    }
    Err(ApiError::conflict(
        "Publication is awaiting finalized account reconciliation",
    ))
}

fn ordered_recipients(entries: [(&str, u16); 3]) -> Vec<Value> {
    let mut out = Vec::<(String, u32)>::new();
    for (wallet, bps) in entries {
        if let Some(prior) = out.iter_mut().find(|v| v.0 == wallet) {
            prior.1 += u32::from(bps);
        } else {
            out.push((wallet.to_owned(), u32::from(bps)));
        }
    }
    out.into_iter()
        .map(|(wallet, share)| json!({"wallet":wallet,"share":share}))
        .collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sealed_binding_rejects_a_different_json_commitment_or_publisher() {
        let plan = json!({"encoded":{"digest":"typed","json_hash":"canonical"},"accounts":{"publisher":"author"}});
        let mut state = json!({"digest":"typed","json_hash":"canonical","publisher":"author"});
        assert!(verify_model_binding(&state, &plan).is_ok());
        state["json_hash"] = json!("another-economy");
        assert!(verify_model_binding(&state, &plan).is_err());
        state["json_hash"] = json!("canonical");
        state["publisher"] = json!("other-wallet");
        assert!(verify_model_binding(&state, &plan).is_err());
    }
    #[test]
    fn factory_preserves_recipient_order_and_merges_duplicate_roles() {
        let r = ordered_recipients([
            ("z_launcher", 8000),
            ("z_launcher", 1000),
            ("a_platform", 1000),
        ]);
        assert_eq!(
            r,
            json!([{"wallet":"z_launcher","share":9000},{"wallet":"a_platform","share":1000}])
                .as_array()
                .unwrap()
                .clone()
        );
        let r = ordered_recipients([
            ("z_launcher", 8000),
            ("b_author", 1000),
            ("a_platform", 1000),
        ]);
        assert_eq!(
            r.iter()
                .map(|v| v["wallet"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["z_launcher", "b_author", "a_platform"]
        );
    }
}
