use crate::{
    AppState,
    error::{ApiError, ApiResult},
};
use axum::{Json, extract::State};
use base64::{Engine, engine::general_purpose::STANDARD};
use depthguard_domain::money::{Atomic, public_key};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
const DBC: &str = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const DAMM: &str = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
const CLOCK: &str = "SysvarC1ock11111111111111111111111111111111";
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct QuoteRequest {
    pub protocol: String,
    pub pool: String,
    pub amount: Atomic,
    pub base_for_quote: bool,
    pub mode: String,
    pub slippage_bps: u16,
}
pub async fn quote(
    State(s): State<AppState>,
    Json(input): Json<QuoteRequest>,
) -> ApiResult<Json<Value>> {
    let (request, slot, timestamp) = snapshot(&s, &input).await?;
    let result = depthguard_infrastructure::native::invoke(&request)
        .await
        .map_err(|_| ApiError::bad("Quote rejected by the pinned native SDK"))?;
    ensure_quote_mint(&s, &result).await?;
    let amount_out: u128 = result["output"]
        .as_str()
        .ok_or_else(|| ApiError::unavailable("Invalid native quote response"))?
        .parse()
        .map_err(|_| ApiError::unavailable("Invalid native quote amount"))?;
    let amount_in: u128 = result["input"]
        .as_str()
        .ok_or_else(|| ApiError::unavailable("Invalid native quote response"))?
        .parse()
        .map_err(|_| ApiError::unavailable("Invalid native quote amount"))?;
    let min_out = amount_out * (10000 - u128::from(input.slippage_bps)) / 10000;
    let max_in = (amount_in * (10000 + u128::from(input.slippage_bps))).div_ceil(10000);
    Ok(Json(
        json!({"evidence":"sdk_quote","protocol":input.protocol,"pool":input.pool,"cluster":s.config.cluster,"context_slot":slot,"timestamp":timestamp,"snapshot_hash":hex::encode(Sha256::digest(request.to_string())),"result":result,"minimum_output":Atomic(min_out),"maximum_input":Atomic(max_in),"transfer_fee_support":false,"deployment_certified":false}),
    ))
}
fn account_data(account: &Value, owner: &str) -> ApiResult<String> {
    if account["owner"] != owner || account["executable"] != false {
        return Err(ApiError::bad("Account owner or executable flag is invalid"));
    }
    account["data"][0]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| ApiError::bad("Account data is missing"))
}

async fn snapshot(s: &AppState, input: &QuoteRequest) -> ApiResult<(Value, u64, i64)> {
    public_key(&input.pool).map_err(ApiError::bad)?;
    if input.amount.0 == 0
        || input.amount.0 > u64::MAX.into()
        || input.slippage_bps == 0
        || input.slippage_bps > 1000
    {
        return Err(ApiError::bad(
            "Quote requires a positive u64 input and 1 to 1000 slippage basis points",
        ));
    }
    if !["exact_in", "exact_out", "partial_fill"].contains(&input.mode.as_str()) {
        return Err(ApiError::bad("Unsupported quote mode"));
    }
    let program = match input.protocol.as_str() {
        "dbc" => DBC,
        "damm_v2" => DAMM,
        _ => return Err(ApiError::bad("Unsupported protocol")),
    };
    // A separate identity check precedes reads so provider failover cannot quietly switch networks.
    s.rpc
        .verify_cluster(&s.config.cluster)
        .await
        .map_err(|_| ApiError::unavailable("RPC cluster verification failed"))?;
    let first = s
        .rpc
        .account(&input.pool)
        .await
        .map_err(|_| ApiError::unavailable("Pool state unavailable"))?;
    let pool = account_data(&first["value"], program)?;
    let described = depthguard_infrastructure::native::invoke(
        &json!({"operation":"describe","protocol":input.protocol,"pool_data":pool}),
    )
    .await
    .map_err(|_| {
        ApiError::unavailable("Native SDK adapter unavailable or account version unsupported")
    })?;
    let mut addresses = vec![input.pool.clone(), CLOCK.into()];
    if input.protocol == "dbc" {
        addresses.push(
            described["config"]
                .as_str()
                .ok_or_else(|| ApiError::bad("Pool config is missing"))?
                .into(),
        );
    }
    let snapshot=s.rpc.call("getMultipleAccounts",json!([addresses,{"encoding":"base64","commitment":"confirmed","minContextSlot":first["context"]["slot"]}])).await.map_err(|_|ApiError::unavailable("Coherent account snapshot unavailable"))?;
    let slot = snapshot["context"]["slot"]
        .as_u64()
        .ok_or_else(|| ApiError::unavailable("Snapshot slot is missing"))?;
    let accounts = snapshot["value"]
        .as_array()
        .ok_or_else(|| ApiError::unavailable("Snapshot accounts are missing"))?;
    if accounts.len() != addresses.len() {
        return Err(ApiError::unavailable("Incomplete account snapshot"));
    }
    let pool = account_data(&accounts[0], program)?;
    let clock = STANDARD
        .decode(
            accounts[1]["data"][0]
                .as_str()
                .ok_or_else(|| ApiError::unavailable("Clock unavailable"))?,
        )
        .map_err(|_| ApiError::bad("Clock decoding failed"))?;
    if clock.len() != 40 {
        return Err(ApiError::bad("Invalid clock account"));
    }
    let timestamp = i64::from_le_bytes(clock[32..40].try_into().unwrap());
    if timestamp < 0 {
        return Err(ApiError::bad("Negative chain timestamp is unsupported"));
    }
    let mut request = json!({"protocol":input.protocol,"pool_data":pool,"amount":input.amount,"mode":input.mode,"base_for_quote":input.base_for_quote,"slot":slot.to_string(),"timestamp":timestamp.to_string()});
    if input.protocol == "dbc" {
        request["config_data"] = json!(account_data(&accounts[2], DBC)?);
        request["config_address"] = json!(addresses[2]);
    }
    Ok((request, slot, timestamp))
}

async fn ensure_quote_mint(s: &AppState, quote: &Value) -> ApiResult<()> {
    let mint = quote["quote_mint"]
        .as_str()
        .ok_or_else(|| ApiError::bad("Quote mint missing"))?;
    let response = s
        .rpc
        .account(mint)
        .await
        .map_err(|_| ApiError::unavailable("Quote mint unavailable"))?;
    let data = account_data(
        &response["value"],
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    )?;
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| ApiError::bad("Invalid quote mint"))?;
    if bytes.len() != 82 || bytes[45] != 1 {
        return Err(ApiError::bad(
            "Only initialized standard SPL quote mints are supported",
        ));
    }
    Ok(())
}
pub async fn prepare_swap(
    State(s): State<AppState>,
    actor: crate::auth::Actor,
    Json(input): Json<QuoteRequest>,
) -> ApiResult<Json<Value>> {
    let (mut request, slot, _) = snapshot(&s, &input).await?;
    request["operation"] = json!("swap_prepare");
    request["wallet"] = json!(actor.wallet);
    request["pool"] = json!(input.pool);
    request["slippage_bps"] = json!(input.slippage_bps);
    let instruction = depthguard_infrastructure::native::invoke(&request)
        .await
        .map_err(|_| ApiError::bad("Native swap preparation rejected"))?;
    ensure_quote_mint(&s, &instruction["quote"]).await?;
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
    let built=depthguard_infrastructure::native::invoke(&json!({"operation":"message","payer":actor.wallet,"blockhash":latest["value"]["blockhash"],"instructions":instruction["instructions"]})).await.map_err(|_|ApiError::bad("Swap transaction exceeds supported limits"))?;
    let wire = built["transaction"]
        .as_str()
        .ok_or_else(|| ApiError::bad("Missing transaction"))?;
    let simulated=s.rpc.call("simulateTransaction",json!([wire,{"encoding":"base64","sigVerify":false,"replaceRecentBlockhash":false,"commitment":"confirmed","minContextSlot":slot}])).await.map_err(|_|ApiError::unavailable("Swap simulation unavailable"))?;
    if !simulated["value"]["err"].is_null() {
        return Err(ApiError::bad(
            "Swap simulation rejected; check balances and current liquidity",
        ));
    }
    let message = STANDARD
        .decode(
            built["message"]
                .as_str()
                .ok_or_else(|| ApiError::bad("Missing message"))?,
        )
        .map_err(|_| ApiError::bad("Invalid message"))?;
    let id = uuid::Uuid::new_v4();
    let summary = json!({"kind":"swap","protocol":input.protocol,"pool":input.pool,"quote":instruction["quote"],"slippage_bps":input.slippage_bps,"slippage_bound":instruction["slippage_bound"],"context_slot":slot,"native_sol_wrapping":false,"prepared_without_broadcast":true});
    sqlx::query("INSERT INTO prepared_transactions(id,owner_id,cluster,message,required_signers,last_valid_block_height,summary,unsigned_wire) VALUES($1,$2,$3,$4,$5,$6,$7,$8)")
        .bind(id).bind(actor.id).bind(&s.config.cluster).bind(message).bind(&built["required_signers"]).bind(height).bind(&summary).bind(STANDARD.decode(wire).map_err(|_|ApiError::bad("Invalid wire"))?).execute(&s.pool).await?;
    Ok(Json(
        json!({"id":id,"state":"prepared","transaction":wire,"required_signers":built["required_signers"],"last_valid_block_height":height,"summary":summary,"broadcast_enabled":s.config.chain_writes}),
    ))
}
