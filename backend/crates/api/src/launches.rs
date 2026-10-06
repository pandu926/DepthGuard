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
use depthguard_domain::{economy::Economy, money::public_key};
use depthguard_infrastructure::{native, signer, store};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LaunchInput {
    pub model_version_id: Uuid,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub quote_mint: String,
}
pub async fn create(
    State(s): State<AppState>,
    actor: Actor,
    Json(input): Json<LaunchInput>,
) -> ApiResult<Json<Value>> {
    let key = s.config.encryption_key.as_ref().ok_or_else(|| {
        ApiError::unavailable("Account signer encryption is required for launch preparation")
    })?;
    let platform = s
        .config
        .platform_wallet
        .as_ref()
        .ok_or_else(|| ApiError::unavailable("Platform fee wallet is not configured"))?;
    public_key(&input.quote_mint).map_err(ApiError::bad)?;
    if input.name.is_empty()
        || input.name.len() > 32
        || input.symbol.is_empty()
        || input.symbol.len() > 10
        || input.uri.len() > 200
        || !["https://", "ipfs://"]
            .iter()
            .any(|p| input.uri.starts_with(p))
    {
        return Err(ApiError::bad("Invalid launch metadata"));
    }
    let mut tx = s.pool.begin().await?;
    let economy: Value = sqlx::query_scalar("SELECT economy FROM model_versions WHERE id=$1")
        .bind(input.model_version_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let economy: Economy = serde_json::from_value(economy)
        .map_err(|_| ApiError::bad("Invalid published model schema"))?;
    let parameters = economy.native_parameters().map_err(ApiError::bad)?;
    let id = Uuid::new_v4();
    let mut recipients = std::collections::BTreeMap::<String, u32>::new();
    for (wallet, share) in [
        (&actor.wallet, economy.fee_policy.launcher_bps),
        (&economy.fee_policy.author, economy.fee_policy.author_bps),
        (platform, economy.fee_policy.platform_bps),
    ] {
        *recipients.entry(wallet.clone()).or_default() += u32::from(share);
    }
    if recipients.len() < 2 {
        return Err(ApiError::bad(
            "Native fee sharing requires at least two unique recipients",
        ));
    }
    let metadata = json!({"name":input.name,"symbol":input.symbol,"uri":input.uri,"quote_mint":input.quote_mint,"parameters":parameters,"launcher":actor.wallet,"recipients":recipients.into_iter().map(|(wallet,share)|json!({"wallet":wallet,"share":share})).collect::<Vec<_>>(),"quote_decimals":economy.quote_decimals,"model_hash":depthguard_domain::economy::hash_value(&json!(economy))});
    sqlx::query("INSERT INTO launches(id,owner_id,model_version_id,cluster,metadata) VALUES($1,$2,$3,$4,$5)").bind(id).bind(actor.id).bind(input.model_version_id).bind(&s.config.cluster).bind(&metadata).execute(&mut *tx).await?;
    let mut accounts = serde_json::Map::new();
    for purpose in ["config", "mint", "first_position", "second_position"] {
        let (public, encrypted) = signer::create(key, id, purpose)
            .map_err(|_| ApiError::unavailable("Account signer generation failed"))?;
        accounts.insert(purpose.into(), json!(public));
        sqlx::query("INSERT INTO launch_account_signers(launch_id,purpose,public_key,encrypted_key) VALUES($1,$2,$3,$4)").bind(id).bind(purpose).bind(public).bind(encrypted).execute(&mut *tx).await?;
    }
    store::audit(&mut tx, actor.id, "launch.create", id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"id":id,"state":"draft","accounts":accounts,"metadata":metadata,"broadcast_enabled":s.config.chain_writes}),
    ))
}
pub async fn get(
    State(s): State<AppState>,
    actor: Actor,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let row = sqlx::query(
        "SELECT state,metadata,model_version_id,cluster FROM launches WHERE id=$1 AND owner_id=$2",
    )
    .bind(id)
    .bind(actor.id)
    .fetch_optional(&s.pool)
    .await?
    .ok_or_else(ApiError::not_found)?;
    let accounts =
        sqlx::query("SELECT purpose,public_key FROM launch_account_signers WHERE launch_id=$1")
            .bind(id)
            .fetch_all(&s.pool)
            .await?;
    let steps=sqlx::query("SELECT step,state,evidence,transaction_id FROM workflow_steps WHERE launch_id=$1 ORDER BY step").bind(id).fetch_all(&s.pool).await?;
    Ok(Json(
        json!({"id":id,"state":row.get::<String,_>("state"),"cluster":row.get::<String,_>("cluster"),"model_version_id":row.get::<Uuid,_>("model_version_id"),"metadata":row.get::<Value,_>("metadata"),"accounts":accounts.into_iter().map(|r|json!({"purpose":r.get::<String,_>("purpose"),"address":r.get::<String,_>("public_key")})).collect::<Vec<_>>(),"steps":steps.into_iter().map(|r|json!({"step":r.get::<String,_>("step"),"state":r.get::<String,_>("state"),"evidence":r.get::<Value,_>("evidence"),"transaction_id":r.get::<Option<Uuid>,_>("transaction_id")})).collect::<Vec<_>>()}),
    ))
}
pub async fn prepare(
    State(s): State<AppState>,
    actor: Actor,
    Path((id, step)): Path<(Uuid, String)>,
) -> ApiResult<Json<Value>> {
    let purpose = match step.as_str() {
        "fee_vault" | "config" => vec!["config"],
        "pool" => vec!["mint"],
        "migration" => vec!["first_position", "second_position"],
        _ => return Err(ApiError::bad("Unsupported native launch step")),
    };
    let key = s
        .config
        .encryption_key
        .as_ref()
        .ok_or_else(|| ApiError::unavailable("Account signer encryption is not configured"))?;
    let mut tx = s.pool.begin().await?;
    let row = sqlx::query(
        "SELECT metadata,cluster,state FROM launches WHERE id=$1 AND owner_id=$2 FOR UPDATE",
    )
    .bind(id)
    .bind(actor.id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(ApiError::not_found)?;
    if row.get::<String, _>("state") == "verification_failed" {
        return Err(ApiError::conflict(
            "Launch verification failed; operator review is required",
        ));
    }
    if row.get::<String, _>("cluster") != s.config.cluster {
        return Err(ApiError::forbidden());
    }
    if let Some(existing)=sqlx::query("SELECT id,state,last_valid_block_height,unsigned_wire FROM prepared_transactions WHERE launch_id=$1 AND workflow_step=$2 AND state IN ('prepared','submitted','confirmed','finalized') ORDER BY created_at DESC LIMIT 1").bind(id).bind(&step).fetch_optional(&mut *tx).await?{
        let current=existing.get::<String,_>("state");
        let height=s.rpc.call("getBlockHeight",json!([{"commitment":"finalized"}])).await.map_err(|_|ApiError::unavailable("Block height unavailable"))?.as_i64().ok_or_else(||ApiError::bad("Invalid block height"))?;
        if current=="prepared"&&height>existing.get::<i64,_>("last_valid_block_height") {
            sqlx::query("UPDATE prepared_transactions SET state='expired',updated_at=now() WHERE id=$1").bind(existing.get::<Uuid,_>("id")).execute(&mut *tx).await?;
        } else {
            return Ok(Json(json!({"id":existing.get::<Uuid,_>("id"),"state":current,"reused":true,"transaction":existing.get::<Option<Vec<u8>>,_>("unsigned_wire").map(|w|STANDARD.encode(w))})));
        }
    }

    let predecessor = match step.as_str() {
        "config" => Some("fee_vault"),
        "pool" => Some("config"),
        "migration" => Some("pool"),
        _ => None,
    };
    if let Some(prior) = predecessor {
        let ready:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workflow_steps WHERE launch_id=$1 AND step=$2 AND state='verified')").bind(id).bind(prior).fetch_one(&mut *tx).await?;
        if !ready {
            return Err(ApiError::conflict(
                "Previous launch step must be verified first",
            ));
        }
    }
    let metadata: Value = row.get("metadata");
    let mint = metadata["quote_mint"]
        .as_str()
        .ok_or_else(|| ApiError::bad("Quote mint missing"))?;
    s.rpc
        .verify_cluster(&s.config.cluster)
        .await
        .map_err(|_| ApiError::unavailable("RPC identity verification failed"))?;
    let quote = s
        .rpc
        .account(mint)
        .await
        .map_err(|_| ApiError::unavailable("Quote mint unavailable"))?;
    if quote["value"]["owner"] != "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" {
        return Err(ApiError::bad(
            "Native launch profile requires a standard SPL quote mint",
        ));
    }
    let mint_data = STANDARD
        .decode(
            quote["value"]["data"][0]
                .as_str()
                .ok_or_else(|| ApiError::bad("Invalid quote mint"))?,
        )
        .map_err(|_| ApiError::bad("Invalid quote mint encoding"))?;
    if mint_data.len() != 82
        || mint_data[45] != 1
        || Some(u64::from(mint_data[44])) != metadata["quote_decimals"].as_u64()
    {
        return Err(ApiError::bad(
            "Quote decimals or mint initialization differ from the published model",
        ));
    }
    let accounts = sqlx::query(
        "SELECT purpose,public_key,encrypted_key FROM launch_account_signers WHERE launch_id=$1",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    let mut map = std::collections::BTreeMap::<String, (String, Vec<u8>)>::new();
    for a in accounts {
        map.insert(
            a.get("purpose"),
            (a.get("public_key"), a.get("encrypted_key")),
        );
    }
    if map.len() != 4 {
        return Err(ApiError::unavailable(
            "Launch account signer records are incomplete",
        ));
    }
    let vault_create=native::invoke(&json!({"operation":"fee_create","base":map["config"].0,"wallet":actor.wallet,"quote_mint":mint,"recipients":metadata["recipients"]})).await.map_err(|_|ApiError::bad("Native fee vault parameters rejected"))?;
    let vault = vault_create["vault"].clone();
    let mut input = json!({"wallet":actor.wallet,"config":map["config"].0,"base_mint":map["mint"].0,"quote_mint":mint,"fee_vault":vault,"parameters":metadata["parameters"],"name":metadata["name"],"symbol":metadata["symbol"],"uri":metadata["uri"]});
    let mut ix = match step.as_str() {
        "fee_vault" => vault_create,
        "config" => {
            input["operation"] = json!("dbc_config");
            native::invoke(&input)
                .await
                .map_err(|_| ApiError::bad("Config instruction compilation failed"))?
        }
        "pool" => {
            input["operation"] = json!("dbc_pool");
            native::invoke(&input)
                .await
                .map_err(|_| ApiError::bad("Pool instruction compilation failed"))?
        }
        "migration" => {
            input["operation"] = json!("dbc_migrate");
            input["damm_config"] =
                json!(
                    s.config
                        .damm_config
                        .as_ref()
                        .ok_or_else(|| ApiError::unavailable(
                            "Verified DAMM migration config is required"
                        ))?
                );
            input["first_position_mint"] = json!(map["first_position"].0);
            input["second_position_mint"] = json!(map["second_position"].0);
            native::invoke(&input)
                .await
                .map_err(|_| ApiError::bad("Migration instruction compilation failed"))?
        }
        _ => unreachable!(),
    };
    let latest = s
        .rpc
        .call("getLatestBlockhash", json!([{"commitment":"confirmed"}]))
        .await
        .map_err(|_| ApiError::unavailable("Blockhash unavailable"))?;
    let built=native::invoke(&json!({"operation":"message","payer":actor.wallet,"blockhash":latest["value"]["blockhash"],"instructions":[ix]})).await.map_err(|_|ApiError::bad("Native launch transaction exceeds limits or cannot compile"))?;
    let message = STANDARD
        .decode(
            built["message"]
                .as_str()
                .ok_or_else(|| ApiError::bad("Compiled message missing"))?,
        )
        .map_err(|_| ApiError::bad("Invalid message encoding"))?;
    let mut wire = STANDARD
        .decode(
            built["transaction"]
                .as_str()
                .ok_or_else(|| ApiError::bad("Compiled transaction missing"))?,
        )
        .map_err(|_| ApiError::bad("Invalid transaction encoding"))?;
    for p in purpose {
        let (public, encrypted) = &map[p];
        signer::partial_sign(
            key,
            signer::Identity {
                launch: id,
                purpose: p,
                public,
            },
            encrypted,
            &message,
            &built["required_signers"],
            &mut wire,
        )
        .map_err(|_| ApiError::unavailable("Account signer could not be authenticated"))?;
    }
    let encoded = STANDARD.encode(wire);
    let simulated=s.rpc.call("simulateTransaction",json!([encoded,{"encoding":"base64","sigVerify":false,"replaceRecentBlockhash":false,"commitment":"confirmed"}])).await.map_err(|_|ApiError::bad("Launch simulation unavailable"))?;
    if !simulated["value"]["err"].is_null() {
        return Err(ApiError::bad(
            "Native program rejected launch simulation; inspect configuration and wallet funding",
        ));
    }
    let tx_id = Uuid::new_v4();
    let height = latest["value"]["lastValidBlockHeight"]
        .as_i64()
        .ok_or_else(|| ApiError::bad("Missing block height"))?;
    ix["model_hash"] = metadata["model_hash"].clone();
    let summary = json!({"kind":"launch_step","step":step,"launch_id":id,"fee_vault":vault,"wallet":actor.wallet,"quote_mint":mint,"instruction":ix,"simulation":"unsigned_simulation","prepared_without_broadcast":true});
    sqlx::query("INSERT INTO prepared_transactions(id,owner_id,launch_id,cluster,message,required_signers,last_valid_block_height,summary,workflow_step,unsigned_wire) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)").bind(tx_id).bind(actor.id).bind(id).bind(&s.config.cluster).bind(message).bind(&built["required_signers"]).bind(height).bind(&summary).bind(&step).bind(STANDARD.decode(&encoded).map_err(|_|ApiError::bad("Invalid prepared wire"))?).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO workflow_steps(launch_id,step,state,evidence,transaction_id) VALUES($1,$2,'prepared',$3,$4) ON CONFLICT(launch_id,step) DO UPDATE SET state='prepared',evidence=EXCLUDED.evidence,transaction_id=EXCLUDED.transaction_id,updated_at=now()").bind(id).bind(&step).bind(&summary).bind(tx_id).execute(&mut *tx).await?;
    store::audit(&mut tx, actor.id, "launch.prepare", tx_id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"id":tx_id,"state":"prepared","transaction":encoded,"required_signers":built["required_signers"],"last_valid_block_height":height,"summary":summary,"broadcast_enabled":s.config.chain_writes}),
    ))
}
