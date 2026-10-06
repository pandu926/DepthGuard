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
use depthguard_domain::money::{Atomic, public_key};
use depthguard_infrastructure::{contracts, native};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use uuid::Uuid;
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PrepareInput {
    pub action: String,
    pub accounts: BTreeMap<String, String>,
    pub args: Value,
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RedemptionInput {
    pub burn_amount: Atomic,
}
fn enabled(s: &AppState) -> ApiResult<()> {
    if !s.config.contracts_enabled {
        return Err(ApiError::unavailable(
            "Contracts are not enabled on this deployment",
        ));
    }
    Ok(())
}
pub async fn state(
    State(s): State<AppState>,
    Path((kind, address)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    enabled(&s)?;
    public_key(&address).map_err(ApiError::bad)?;
    contracts::program(&kind).map_err(|_| ApiError::bad("Invalid contract kind"))?;
    s.rpc
        .verify_cluster(&s.config.cluster)
        .await
        .map_err(|_| ApiError::unavailable("RPC identity unavailable"))?;
    let (state, slot) = contracts::snapshot(&s.rpc, &kind, &address, None)
        .await
        .map_err(|_| ApiError::bad("Contract state unavailable or unsupported"))?;
    Ok(Json(
        json!({"address":address,"kind":kind,"cluster":s.config.cluster,"context_slot":slot,"commitment":"finalized","state":state}),
    ))
}
#[derive(Deserialize, serde::Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EncodeInput {
    pub publisher: String,
    pub parent: String,
    pub author: String,
    pub economy: depthguard_domain::economy::Economy,
}
pub async fn encode(
    State(s): State<AppState>,
    actor: Actor,
    Json(input): Json<EncodeInput>,
) -> ApiResult<Json<Value>> {
    enabled(&s)?;
    if input.publisher != actor.wallet {
        return Err(ApiError::forbidden());
    }
    let mut input = serde_json::to_value(input).map_err(|_| ApiError::bad("Invalid model"))?;
    input["operation"] = json!("contract_model");
    let result = native::invoke(&input)
        .await
        .map_err(|_| ApiError::bad("Invalid executable model terms"))?;
    Ok(Json(result))
}
pub async fn prepare(
    State(s): State<AppState>,
    actor: Actor,
    Json(mut input): Json<PrepareInput>,
) -> ApiResult<Json<Value>> {
    enabled(&s)?;
    if input.accounts.len() > 32 {
        return Err(ApiError::bad("Too many contract accounts"));
    }
    for address in input.accounts.values() {
        public_key(address).map_err(ApiError::bad)?;
    }
    for role in ["publisher", "launcher", "holder", "depositor", "reviewer"] {
        if let Some(key) = input.accounts.get(role)
            && key != &actor.wallet
        {
            return Err(ApiError::forbidden());
        }
    }
    s.rpc
        .verify_cluster(&s.config.cluster)
        .await
        .map_err(|_| ApiError::unavailable("RPC identity unavailable"))?;
    if input.action == "escrow_vote" {
        let vault = input
            .accounts
            .get("vault")
            .ok_or_else(|| ApiError::bad("Vault required"))?;
        let (state, _) = contracts::snapshot(&s.rpc, "escrow", vault, None)
            .await
            .map_err(|_| ApiError::bad("Escrow state unavailable"))?;
        input.accounts.insert(
            "beneficiary".into(),
            state["beneficiary"]
                .as_str()
                .ok_or_else(|| ApiError::bad("Beneficiary missing"))?
                .into(),
        );
        input.accounts.insert(
            "quote_mint".into(),
            state["quote_mint"]
                .as_str()
                .ok_or_else(|| ApiError::bad("Quote mint missing"))?
                .into(),
        );
    }
    let ix=native::invoke(&json!({"operation":"contract_build","action":input.action,"accounts":input.accounts,"args":input.args})).await.map_err(|_|ApiError::bad("Unsupported action or invalid contract arguments"))?;
    let deployed = s
        .rpc
        .account(
            ix["program_id"]
                .as_str()
                .ok_or_else(|| ApiError::bad("Invalid program"))?,
        )
        .await
        .map_err(|_| ApiError::unavailable("Contract program unavailable"))?;
    if deployed["value"]["executable"] != true {
        return Err(ApiError::unavailable("Contract program is not deployed"));
    }
    let latest = s
        .rpc
        .call("getLatestBlockhash", json!([{"commitment":"confirmed"}]))
        .await
        .map_err(|_| ApiError::unavailable("Blockhash unavailable"))?;
    let built=native::invoke(&json!({"operation":"message","payer":actor.wallet,"blockhash":latest["value"]["blockhash"],"instructions":ix.get("instructions").cloned().unwrap_or_else(||json!([ix]))})).await.map_err(|_|ApiError::bad("Contract transaction exceeds supported wire limits"))?;
    let wire = built["transaction"]
        .as_str()
        .ok_or_else(|| ApiError::bad("Missing unsigned wire"))?;
    let sim=s.rpc.call("simulateTransaction",json!([wire,{"encoding":"base64","sigVerify":false,"replaceRecentBlockhash":false,"commitment":"confirmed"}])).await.map_err(|_|ApiError::unavailable("Contract simulation unavailable"))?;
    if !sim["value"]["err"].is_null() {
        return Err(ApiError::bad("Contract rejected transaction simulation"));
    }
    let height = latest["value"]["lastValidBlockHeight"]
        .as_i64()
        .ok_or_else(|| ApiError::bad("Invalid block height"))?;
    let mut projections = Vec::new();
    let roles: &[&str] = match input.action.as_str() {
        "create_fee_vault" | "wrap_sol" | "unwrap_sol" => &[],
        "begin_model" | "write_model" | "seal_model" => &["model"],
        "initialize_launch" | "create_config" => &["model", "launch"],
        "create_pool" | "verify_migration" => &["launch"],
        "initialize_module" => &["model", "launch", "module_vault"],
        "fund_and_activate" => &["launch", "module_vault"],
        _ => &["vault"],
    };
    for role in roles {
        if let Some(address) = input.accounts.get(*role) {
            let kind = match *role {
                "model" => "model",
                "launch" => "launch",
                _ => {
                    if input.action.starts_with("escrow")
                        || input
                            .accounts
                            .get("module_program")
                            .is_some_and(|v| v == contracts::ESCROW)
                    {
                        "escrow"
                    } else {
                        "reserve"
                    }
                }
            };
            projections.push(json!({"address":address,"kind":kind}));
        }
    }
    let summary = json!({"kind":"contract_action","action":input.action,"program_id":ix["program_id"],"accounts":input.accounts,"projections":projections,"prepared_without_broadcast":true});
    let id = Uuid::new_v4();
    let mut tx = s.pool.begin().await?;
    sqlx::query("INSERT INTO prepared_transactions(id,owner_id,cluster,message,required_signers,last_valid_block_height,summary,unsigned_wire) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(id).bind(actor.id).bind(&s.config.cluster).bind(STANDARD.decode(built["message"].as_str().ok_or_else(||ApiError::bad("Message missing"))?).map_err(|_|ApiError::bad("Invalid message"))?).bind(&built["required_signers"]).bind(height).bind(&summary).bind(STANDARD.decode(wire).map_err(|_|ApiError::bad("Invalid wire"))?).execute(&mut *tx).await?;
    depthguard_infrastructure::store::audit(&mut tx, actor.id, "contract.prepare", id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"id":id,"state":"prepared","transaction":wire,"required_signers":built["required_signers"],"last_valid_block_height":height,"summary":summary,"broadcast_enabled":s.config.chain_writes}),
    ))
}
pub async fn redemption_quote(
    State(s): State<AppState>,
    Path((kind, address)): Path<(String, String)>,
    Json(input): Json<RedemptionInput>,
) -> ApiResult<Json<Value>> {
    enabled(&s)?;
    if !["escrow", "reserve"].contains(&kind.as_str()) {
        return Err(ApiError::bad("Invalid redemption module"));
    }
    public_key(&address).map_err(ApiError::bad)?;
    s.rpc
        .verify_cluster(&s.config.cluster)
        .await
        .map_err(|_| ApiError::unavailable("RPC identity unavailable"))?;
    let (vault, _) = contracts::snapshot(&s.rpc, &kind, &address, None)
        .await
        .map_err(|_| ApiError::bad("Vault unavailable"))?;
    // Derive the native ATA in the fixed Rust helper, then read vault, mint and balance coherently.
    let derived=native::invoke(&json!({"operation":"contract_quote_accounts","vault":address,"base_mint":vault["base_mint"],"quote_mint":vault["quote_mint"]})).await.map_err(|_|ApiError::bad("Invalid vault accounts"))?;
    let snapshot=s.rpc.call("getMultipleAccounts",json!([[address,vault["base_mint"],derived["token_vault"]],{"encoding":"base64","commitment":"finalized"}])).await.map_err(|_|ApiError::unavailable("Quote snapshot unavailable"))?;
    let result=native::invoke(&json!({"operation":"contract_redemption_quote","kind":kind,"vault":address,"burn_amount":input.burn_amount,"accounts":snapshot["value"]})).await.map_err(|_|ApiError::bad("Redemption inactive or amount unsupported"))?;
    Ok(Json(
        json!({"context_slot":snapshot["context"]["slot"],"commitment":"finalized","quote":result,"execution_requires_min_payout":true,"exit_fee_bps":0}),
    ))
}
