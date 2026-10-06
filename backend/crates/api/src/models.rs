use crate::{
    AppState,
    auth::Actor,
    error::{ApiError, ApiResult},
};
use axum::{
    Json,
    extract::{Path, Query, State},
};
use depthguard_domain::economy::Economy;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateModel {
    name: String,
    economy: Economy,
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateModel {
    name: String,
    economy: Economy,
    revision: i64,
}
#[derive(Deserialize, schemars::JsonSchema)]
pub struct Pagination {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub search: Option<String>,
    pub mechanism: Option<String>,
}
pub async fn create(
    State(s): State<AppState>,
    actor: Actor,
    Json(input): Json<CreateModel>,
) -> ApiResult<Json<Value>> {
    validate_name(&input.name)?;
    if input.economy.fee_policy.author != actor.wallet {
        return Err(ApiError::bad(
            "New models must attribute the authenticated author",
        ));
    }
    let validation = input.economy.validate();
    if !validation.valid {
        return Err(ApiError::bad(validation.issues.join("; ")));
    }
    let id = Uuid::new_v4();
    let mut tx = s.pool.begin().await?;
    sqlx::query("INSERT INTO models(id,owner_id,name,draft) VALUES($1,$2,$3,$4)")
        .bind(id)
        .bind(actor.id)
        .bind(input.name)
        .bind(json!(input.economy))
        .execute(&mut *tx)
        .await?;
    depthguard_infrastructure::store::audit(&mut tx, actor.id, "model.create", id).await?;
    tx.commit().await?;
    Ok(Json(json!({"id":id,"revision":1,"validation":validation})))
}
pub async fn update(
    State(s): State<AppState>,
    actor: Actor,
    Path(id): Path<Uuid>,
    Json(input): Json<UpdateModel>,
) -> ApiResult<Json<Value>> {
    validate_name(&input.name)?;
    let mut tx = s.pool.begin().await?;
    let old =
        sqlx::query("SELECT draft,revision FROM models WHERE id=$1 AND owner_id=$2 FOR UPDATE")
            .bind(id)
            .bind(actor.id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(ApiError::not_found)?;
    let prior: Economy = serde_json::from_value(old.get("draft"))
        .map_err(|_| ApiError::bad("Stored model schema is invalid"))?;
    if serde_json::to_value(&prior.fee_policy).unwrap() != json!(input.economy.fee_policy) {
        return Err(ApiError::bad(
            "Attribution and fee policy are immutable across edits and forks",
        ));
    }
    if old.get::<i64, _>("revision") != input.revision {
        return Err(ApiError::conflict(
            "Draft revision changed; reload before editing",
        ));
    }
    let validation = input.economy.validate();
    if !validation.valid {
        return Err(ApiError::bad(validation.issues.join("; ")));
    }
    let revision:i64=sqlx::query_scalar("UPDATE models SET name=$3,draft=$4,revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING revision")
        .bind(id).bind(actor.id).bind(input.name).bind(json!(input.economy)).fetch_one(&mut *tx).await?;
    depthguard_infrastructure::store::audit(&mut tx, actor.id, "model.update", id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"id":id,"revision":revision,"validation":validation}),
    ))
}
pub async fn get(
    State(s): State<AppState>,
    actor: Actor,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let row = sqlx::query(
        "SELECT name,draft,revision,source_version_id FROM models WHERE id=$1 AND owner_id=$2",
    )
    .bind(id)
    .bind(actor.id)
    .fetch_optional(&s.pool)
    .await?
    .ok_or_else(ApiError::not_found)?;
    Ok(Json(
        json!({"id":id,"name":row.get::<String,_>("name"),"economy":row.get::<Value,_>("draft"),"revision":row.get::<i64,_>("revision"),"source_version_id":row.get::<Option<Uuid>,_>("source_version_id")}),
    ))
}
pub async fn publish(
    State(s): State<AppState>,
    actor: Actor,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let mut tx = s.pool.begin().await?;
    let row = sqlx::query(
        "SELECT draft,source_version_id FROM models WHERE id=$1 AND owner_id=$2 FOR UPDATE",
    )
    .bind(id)
    .bind(actor.id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(ApiError::not_found)?;
    let economy: Economy = serde_json::from_value(row.get("draft"))
        .map_err(|_| ApiError::bad("Invalid stored economy"))?;
    let compiled = economy
        .compile()
        .map_err(|issues| ApiError::bad(issues.join("; ")))?;
    let version: i32 = sqlx::query_scalar(
        "SELECT coalesce(max(version),0)+1 FROM model_versions WHERE model_id=$1",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    let version_id = Uuid::new_v4();
    sqlx::query("INSERT INTO model_versions(id,model_id,version,content_hash,economy,compiled,source_version_id,author_wallet) VALUES($1,$2,$3,$4,$5,$6,$7,$8)")
        .bind(version_id).bind(id).bind(version).bind(&compiled.content_hash).bind(json!(economy)).bind(json!(compiled)).bind(row.get::<Option<Uuid>,_>("source_version_id")).bind(&economy.fee_policy.author).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO outbox(topic,payload) VALUES('model.published',$1)")
        .bind(json!({"version_id":version_id,"hash":compiled.content_hash}))
        .execute(&mut *tx)
        .await?;
    depthguard_infrastructure::store::audit(&mut tx, actor.id, "model.publish", version_id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"id":version_id,"version":version,"compiled":compiled}),
    ))
}
pub async fn browse(
    State(s): State<AppState>,
    Query(p): Query<Pagination>,
) -> ApiResult<Json<Value>> {
    let rows=sqlx::query("SELECT v.id,v.model_id,v.version,v.content_hash,v.author_wallet,v.compiled,m.name FROM model_versions v JOIN models m ON m.id=v.model_id WHERE ($3::text IS NULL OR m.name ILIKE '%'||$3||'%') AND ($4::text IS NULL OR v.economy->>'mechanism'=$4) ORDER BY v.published_at DESC LIMIT $1 OFFSET $2")
        .bind(p.limit.unwrap_or(25).clamp(1,100)).bind(p.offset.unwrap_or(0).clamp(0,100000)).bind(p.search.filter(|s|!s.is_empty())).bind(p.mechanism.filter(|s|!s.is_empty())).fetch_all(&s.pool).await?;
    Ok(Json(
        json!({"items":rows.into_iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"model_id":r.get::<Uuid,_>("model_id"),"version":r.get::<i32,_>("version"),"content_hash":r.get::<String,_>("content_hash"),"author":r.get::<String,_>("author_wallet"),"name":r.get::<String,_>("name"),"compiled":r.get::<Value,_>("compiled")})).collect::<Vec<_>>()}),
    ))
}
pub async fn version(State(s): State<AppState>, Path(id): Path<Uuid>) -> ApiResult<Json<Value>> {
    let row = sqlx::query(
        "SELECT v.economy,v.compiled,v.content_hash,v.source_version_id,u.wallet AS publisher,m.name,b.model_address FROM model_versions v JOIN models m ON m.id=v.model_id JOIN users u ON u.id=m.owner_id LEFT JOIN model_registry_bindings b ON b.version_id=v.id AND b.cluster=$2 WHERE v.id=$1",
    )
    .bind(id)
    .bind(&s.config.cluster)
    .fetch_optional(&s.pool)
    .await?
    .ok_or_else(ApiError::not_found)?;
    Ok(Json(
        json!({"id":id,"publisher":row.get::<String,_>("publisher"),"name":row.get::<String,_>("name"),"registry_address":row.get::<Option<String>,_>("model_address"),"economy":row.get::<Value,_>("economy"),"compiled":row.get::<Value,_>("compiled"),"content_hash":row.get::<String,_>("content_hash"),"source_version_id":row.get::<Option<Uuid>,_>("source_version_id")}),
    ))
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ForkInput {
    name: String,
}
pub async fn fork(
    State(s): State<AppState>,
    actor: Actor,
    Path(id): Path<Uuid>,
    Json(input): Json<ForkInput>,
) -> ApiResult<Json<Value>> {
    validate_name(&input.name)?;
    let mut tx = s.pool.begin().await?;
    let economy: Value = sqlx::query_scalar("SELECT economy FROM model_versions WHERE id=$1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let new_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO models(id,owner_id,name,draft,source_version_id) VALUES($1,$2,$3,$4,$5)",
    )
    .bind(new_id)
    .bind(actor.id)
    .bind(input.name)
    .bind(economy)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    depthguard_infrastructure::store::audit(&mut tx, actor.id, "model.fork", new_id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"id":new_id,"revision":1,"source_version_id":id}),
    ))
}
fn validate_name(name: &str) -> ApiResult<()> {
    if name.trim().is_empty() || name.chars().count() > 80 {
        return Err(ApiError::bad("Model name must contain 1 to 80 characters"));
    }
    Ok(())
}
pub async fn validate(Json(economy): Json<Economy>) -> Json<Value> {
    Json(json!(economy.validate()))
}
pub async fn compile(Json(economy): Json<Economy>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(
        economy.compile().map_err(|e| ApiError::bad(e.join("; ")))?
    )))
}

pub async fn native_parameters(Json(mut economy): Json<Economy>) -> ApiResult<Json<Value>> {
    economy.native_config = None;
    let parameters = economy
        .contract_native_parameters()
        .map_err(ApiError::bad)?;
    Ok(Json(
        json!({"protocol":"dbc","root":"ConfigParameters","parameters":parameters,"profile":"factory_wsol_immutable_permanent_lp","research_overrides_require_native_evidence":true}),
    ))
}
