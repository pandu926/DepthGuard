use crate::{
    AppState,
    auth::Actor,
    error::{ApiError, ApiResult},
};
use axum::{
    Json,
    extract::{Path, Query, State},
};
use depthguard_domain::money::public_key;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Page {
    pub after: Option<String>,
    pub limit: Option<i64>,
}
pub async fn markets(
    State(s): State<AppState>,
    Query(page): Query<Page>,
) -> ApiResult<Json<Value>> {
    let limit = page.limit.unwrap_or(20);
    if !(1..=100).contains(&limit) {
        return Err(ApiError::bad("Limit must be between one and 100"));
    }
    if let Some(after) = &page.after {
        public_key(after).map_err(ApiError::bad)?;
    }
    let rows=sqlx::query("SELECT address,protocol,launch_id,state,context_slot,observed_at FROM markets WHERE cluster=$1 AND ($2::text IS NULL OR address>$2) ORDER BY address LIMIT $3").bind(&s.config.cluster).bind(page.after).bind(limit).fetch_all(&s.pool).await?;
    let items:Vec<Value>=rows.into_iter().map(|r|json!({"address":r.get::<String,_>("address"),"protocol":r.get::<String,_>("protocol"),"launch_id":r.get::<Option<uuid::Uuid>,_>("launch_id"),"state":r.get::<Value,_>("state"),"context_slot":r.get::<i64,_>("context_slot"),"observed_at":r.get::<chrono::DateTime<chrono::Utc>,_>("observed_at")})).collect();
    Ok(Json(
        json!({"cluster":s.config.cluster,"next_after":if items.len()==limit as usize{items.last().map(|v|&v["address"])}else{None},"items":items}),
    ))
}
pub async fn market(
    State(s): State<AppState>,
    Path(address): Path<String>,
) -> ApiResult<Json<Value>> {
    public_key(&address).map_err(ApiError::bad)?;
    let row=sqlx::query("SELECT protocol,launch_id,state,context_slot,observed_at FROM markets WHERE cluster=$1 AND address=$2").bind(&s.config.cluster).bind(&address).fetch_optional(&s.pool).await?.ok_or_else(ApiError::not_found)?;
    Ok(Json(
        json!({"cluster":s.config.cluster,"address":address,"protocol":row.get::<String,_>("protocol"),"launch_id":row.get::<Option<uuid::Uuid>,_>("launch_id"),"state":row.get::<Value,_>("state"),"context_slot":row.get::<i64,_>("context_slot"),"observed_at":row.get::<chrono::DateTime<chrono::Utc>,_>("observed_at"),"source":"finalized_launch_verification","quote_requires_fresh_rpc_snapshot":true}),
    ))
}
pub async fn earnings(State(s): State<AppState>, actor: Actor) -> ApiResult<Json<Value>> {
    let entries=sqlx::query("SELECT vault_address,entry_type,sum(amount)::text AS amount FROM fee_accounting_entries WHERE cluster=$1 AND finalized AND recipient_wallet=$2 GROUP BY vault_address,entry_type ORDER BY vault_address LIMIT 100").bind(&s.config.cluster).bind(&actor.wallet).fetch_all(&s.pool).await?;
    let funding=sqlx::query("SELECT data->>'vault' AS vault,coalesce((data->>'trading_fee_source')::boolean,false) AS trading_fee_source,sum((data->>'amount')::numeric)::text AS amount FROM chain_events WHERE cluster=$1 AND commitment='finalized' AND data->>'kind'='funding' AND EXISTS(SELECT 1 FROM fee_vaults v,jsonb_array_elements(v.recipients) r WHERE v.cluster=$1 AND v.address=data->>'vault' AND r->>'wallet'=$2) GROUP BY 1,2 ORDER BY 1,2 LIMIT 100").bind(&s.config.cluster).bind(&actor.wallet).fetch_all(&s.pool).await?;
    let funding:Vec<Value>=funding.into_iter().map(|r|json!({"vault":r.get::<String,_>("vault"),"trading_fee_source":r.get::<bool,_>("trading_fee_source"),"amount":r.get::<String,_>("amount")})).collect();
    let vaults=sqlx::query("SELECT v.address,v.quote_mint,a.data,a.slot FROM fee_vaults v LEFT JOIN LATERAL (SELECT data,slot FROM account_snapshots WHERE cluster=v.cluster AND address=v.address ORDER BY slot DESC LIMIT 1) a ON true WHERE v.cluster=$1 AND v.verified AND EXISTS(SELECT 1 FROM jsonb_array_elements(v.recipients) r WHERE r->>'wallet'=$2) ORDER BY v.address LIMIT 100").bind(&s.config.cluster).bind(&actor.wallet).fetch_all(&s.pool).await?;
    let vaults:Vec<Value>=vaults.into_iter().map(|r|{let state:Option<Value>=r.get("data");let pending=state.as_ref().and_then(|v|v["recipients"].as_array()).and_then(|users|users.iter().find(|u|u["wallet"]==actor.wallet));json!({"address":r.get::<String,_>("address"),"quote_mint":r.get::<String,_>("quote_mint"),"context_slot":r.get::<Option<i64>,_>("slot"),"recipient":pending,"snapshot_available":state.is_some()})}).collect();
    Ok(Json(
        json!({"wallet":actor.wallet,"cluster":s.config.cluster,"scope":"first_100_vaults","aggregation":"per_vault_and_quote_mint","finalized_claims":entries.into_iter().map(|r|json!({"vault":r.get::<String,_>("vault_address"),"type":r.get::<String,_>("entry_type"),"amount":r.get::<String,_>("amount")})).collect::<Vec<_>>(),"vaults":vaults,"funding_sources":funding,"native_pending_includes_all_vault_funding":true,"pending_source":"latest_finalized_native_snapshot","unconfirmed_fees_included":false}),
    ))
}
