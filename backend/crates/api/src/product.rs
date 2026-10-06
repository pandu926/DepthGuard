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
#[derive(Default, Deserialize, schemars::JsonSchema)]
pub struct Page {
    pub offset: Option<i64>,
    pub limit: Option<i64>,
    pub search: Option<String>,
    pub mechanism: Option<String>,
}
impl Page {
    pub fn bounds(&self) -> ApiResult<(i64, i64)> {
        let n = self.limit.unwrap_or(24);
        let o = self.offset.unwrap_or(0);
        if !(1..=100).contains(&n)
            || !(0..=100000).contains(&o)
            || self.search.as_ref().is_some_and(|s| s.len() > 100)
        {
            return Err(ApiError::bad("Invalid pagination or search"));
        }
        Ok((n, o))
    }
}
pub async fn drafts(
    State(s): State<AppState>,
    actor: Actor,
    Query(p): Query<Page>,
) -> ApiResult<Json<Value>> {
    let (n, o) = p.bounds()?;
    let rows=sqlx::query("SELECT id,name,draft,revision,updated_at FROM models WHERE owner_id=$1 ORDER BY updated_at DESC LIMIT $2 OFFSET $3").bind(actor.id).bind(n+1).bind(o).fetch_all(&s.pool).await?;
    let mut items:Vec<Value>=rows.into_iter().map(|r|json!({"id":r.get::<uuid::Uuid,_>("id"),"name":r.get::<String,_>("name"),"economy":r.get::<Value,_>("draft"),"revision":r.get::<i64,_>("revision"),"updated_at":r.get::<chrono::DateTime<chrono::Utc>,_>("updated_at")})).collect();
    let more = items.len() > n as usize;
    items.truncate(n as usize);
    Ok(Json(
        json!({"items":items,"next_offset":if more{Some(o+n)}else{None}}),
    ))
}
pub async fn launches(
    State(s): State<AppState>,
    actor: Actor,
    Query(p): Query<Page>,
) -> ApiResult<Json<Value>> {
    let (n, o) = p.bounds()?;
    let rows=sqlx::query("SELECT l.id,l.state,l.metadata,f.launch_address FROM launches l LEFT JOIN factory_launches f ON f.launch_id=l.id WHERE l.owner_id=$1 AND l.cluster=$2 ORDER BY l.created_at DESC LIMIT $3 OFFSET $4").bind(actor.id).bind(&s.config.cluster).bind(n+1).bind(o).fetch_all(&s.pool).await?;
    let mut items:Vec<Value>=rows.into_iter().map(|r|json!({"id":r.get::<uuid::Uuid,_>("id"),"state":r.get::<String,_>("state"),"metadata":r.get::<Value,_>("metadata"),"launch_address":r.get::<Option<String>,_>("launch_address")})).collect();
    let more = items.len() > n as usize;
    items.truncate(n as usize);
    Ok(Json(
        json!({"items":items,"next_offset":if more{Some(o+n)}else{None}}),
    ))
}
pub async fn activity(
    State(s): State<AppState>,
    actor: Actor,
    Query(p): Query<Page>,
) -> ApiResult<Json<Value>> {
    let (n, o) = p.bounds()?;
    let rows=sqlx::query("SELECT id,state,signature,summary,created_at FROM prepared_transactions WHERE owner_id=$1 AND cluster=$2 ORDER BY created_at DESC LIMIT $3 OFFSET $4").bind(actor.id).bind(&s.config.cluster).bind(n+1).bind(o).fetch_all(&s.pool).await?;
    let mut items:Vec<Value>=rows.into_iter().map(|r|json!({"id":r.get::<uuid::Uuid,_>("id"),"state":r.get::<String,_>("state"),"signature":r.get::<Option<String>,_>("signature"),"summary":r.get::<Value,_>("summary"),"created_at":r.get::<chrono::DateTime<chrono::Utc>,_>("created_at")})).collect();
    let more = items.len() > n as usize;
    items.truncate(n as usize);
    Ok(Json(
        json!({"items":items,"next_offset":if more{Some(o+n)}else{None}}),
    ))
}
pub async fn portfolio(State(s): State<AppState>, actor: Actor) -> ApiResult<Json<Value>> {
    s.rpc
        .verify_cluster(&s.config.cluster)
        .await
        .map_err(|_| ApiError::unavailable("RPC identity unavailable"))?;
    let balance = s
        .rpc
        .call(
            "getBalance",
            json!([actor.wallet,{"commitment":"finalized"}]),
        )
        .await
        .map_err(|_| ApiError::unavailable("Balance unavailable"))?;
    let tokens=s.rpc.call("getTokenAccountsByOwner",json!([actor.wallet,{"programId":"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"},{"encoding":"jsonParsed","commitment":"finalized"}])).await.map_err(|_|ApiError::unavailable("Token balances unavailable"))?;
    let items:Vec<Value>=tokens["value"].as_array().ok_or_else(||ApiError::unavailable("Invalid token account response"))?.iter().filter_map(|v|{let i=&v["account"]["data"]["parsed"]["info"];(i["owner"]==actor.wallet).then(||json!({"account":v["pubkey"],"mint":i["mint"],"amount":i["tokenAmount"]["amount"],"decimals":i["tokenAmount"]["decimals"]}))}).collect();
    Ok(Json(
        json!({"wallet":actor.wallet,"cluster":s.config.cluster,"sol_lamports":balance["value"].as_u64().map(|v|v.to_string()),"context_slot":tokens["context"]["slot"],"commitment":"finalized","items":items}),
    ))
}
pub async fn tokens(State(s): State<AppState>, Query(p): Query<Page>) -> ApiResult<Json<Value>> {
    let (n, o) = p.bounds()?;
    let rows=sqlx::query("SELECT f.launch_id,f.launch_address,f.metadata,c.data,c.context_slot FROM factory_launches f JOIN launches l ON l.id=f.launch_id LEFT JOIN contract_accounts c ON c.cluster=l.cluster AND c.address=f.launch_address WHERE l.cluster=$1 AND coalesce((c.data->>'phase')::int,0)>=2 AND ($2::text IS NULL OR f.metadata->>'name' ILIKE '%'||$2||'%' OR f.metadata->>'symbol' ILIKE '%'||$2||'%') AND ($3::text IS NULL OR f.metadata->>'mechanism'=$3) ORDER BY f.created_at DESC LIMIT $4 OFFSET $5").bind(&s.config.cluster).bind(&p.search).bind(p.mechanism.filter(|v|!v.is_empty())).bind(n+1).bind(o).fetch_all(&s.pool).await?;
    let mut items:Vec<Value>=rows.into_iter().map(|r|json!({"id":r.get::<uuid::Uuid,_>("launch_id"),"address":r.get::<String,_>("launch_address"),"metadata":r.get::<Value,_>("metadata"),"chain_state":r.get::<Option<Value>,_>("data"),"context_slot":r.get::<Option<i64>,_>("context_slot")})).collect();
    let more = items.len() > n as usize;
    items.truncate(n as usize);
    Ok(Json(
        json!({"items":items,"next_offset":if more{Some(o+n)}else{None}}),
    ))
}
pub async fn token(
    State(s): State<AppState>,
    Path(address): Path<String>,
) -> ApiResult<Json<Value>> {
    public_key(&address).map_err(ApiError::bad)?;
    s.rpc
        .verify_cluster(&s.config.cluster)
        .await
        .map_err(|_| ApiError::unavailable("RPC identity unavailable"))?;
    let row=sqlx::query("SELECT f.metadata,f.plan,l.model_version_id FROM factory_launches f JOIN launches l ON l.id=f.launch_id WHERE f.launch_address=$1 AND l.cluster=$2").bind(&address).bind(&s.config.cluster).fetch_optional(&s.pool).await?.ok_or_else(ApiError::not_found)?;
    let (state, slot) =
        depthguard_infrastructure::contracts::snapshot(&s.rpc, "launch", &address, None)
            .await
            .map_err(|_| ApiError::unavailable("Launch state unavailable"))?;
    let plan: Value = row.get("plan");
    let pool = if state["phase"].as_u64().unwrap_or(0) >= 3 {
        state["damm_pool"].clone()
    } else {
        plan["accounts"]["pool"].clone()
    };
    let protocol = if state["phase"].as_u64().unwrap_or(0) >= 3 {
        "damm_v2"
    } else {
        "dbc"
    };
    let observations=sqlx::query("SELECT slot,state,observed_at FROM market_observations WHERE cluster=$1 AND address=$2 ORDER BY slot DESC LIMIT 100").bind(&s.config.cluster).bind(pool.as_str().unwrap_or("")).fetch_all(&s.pool).await?;
    Ok(Json(
        json!({"address":address,"metadata":row.get::<Value,_>("metadata"),"model_version_id":row.get::<uuid::Uuid,_>("model_version_id"),"accounts":plan["accounts"],"state":state,"context_slot":slot,"protocol":protocol,"pool":pool,"observations":observations.into_iter().rev().map(|r|json!({"slot":r.get::<i64,_>("slot"),"state":r.get::<Value,_>("state"),"observed_at":r.get::<chrono::DateTime<chrono::Utc>,_>("observed_at")})).collect::<Vec<_>>()}),
    ))
}
