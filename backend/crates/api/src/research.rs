use crate::{
    AppState,
    auth::Actor,
    error::{ApiError, ApiResult},
};
use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
    response::{
        Sse,
        sse::{Event, KeepAlive},
    },
};
use depthguard_application::research::{Case, ResearchRequest, run_case};
use depthguard_domain::economy::hash_value;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use std::convert::Infallible;
use uuid::Uuid;
pub async fn preview(Json(case): Json<Case>) -> ApiResult<Json<Value>> {
    if case.orders.len() > 100 {
        return Err(ApiError::bad(
            "Preview is limited to 100 orders; submit a research job for larger runs",
        ));
    }
    Ok(Json(run_case(&case, "preview", 0)))
}
pub async fn enqueue(
    State(s): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Json(mut request): Json<ResearchRequest>,
) -> ApiResult<Json<Value>> {
    for case in &mut request.cases {
        if let Some(dataset_id) = case.inputs.get("dataset_id") {
            let dataset_id: Uuid = serde_json::from_value(dataset_id.clone())
                .map_err(|_| ApiError::bad("Invalid dataset identifier"))?;
            if !matches!(
                case.scenario,
                depthguard_application::research::Scenario::HistoricalReplay
            ) || request.evidence != "analytical"
            {
                return Err(ApiError::bad(
                    "Normalized datasets support analytical historical replay only",
                ));
            }
            if !case.orders.is_empty() {
                return Err(ApiError::bad(
                    "Specify a dataset window or explicit orders, not both",
                ));
            }
            let row = sqlx::query(
                "SELECT data,content_hash,provenance FROM datasets WHERE id=$1 AND owner_id=$2",
            )
            .bind(dataset_id)
            .bind(actor.id)
            .fetch_optional(&s.pool)
            .await?
            .ok_or_else(ApiError::not_found)?;
            let data: Value = row.get("data");
            let records = data
                .as_array()
                .ok_or_else(|| ApiError::bad("Dataset records missing"))?;
            let start = case
                .inputs
                .get("window_start")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            let end = case
                .inputs
                .get("window_end")
                .and_then(Value::as_u64)
                .unwrap_or(records.len() as u64) as usize;
            if start >= end || end > records.len() || end - start > 1000 {
                return Err(ApiError::bad(
                    "Historical window must contain one to 1000 records",
                ));
            }
            for record in &records[start..end] {
                let order=serde_json::from_value(json!({"direction":record["direction"],"amount":record["amount"],"exact_out":false})).map_err(|_|ApiError::bad("Historical record lacks a supported direction and atomic amount"))?;
                case.orders.push(order);
            }
            case.inputs["dataset_hash"] = json!(row.get::<String, _>("content_hash"));
            case.inputs["dataset_provenance"] = row.get("provenance");
            case.inputs["window_start"] = json!(start);
            case.inputs["window_end"] = json!(end);
        }
    }
    request.validate().map_err(ApiError::bad)?;
    let key = headers
        .get("idempotency-key")
        .and_then(|h| h.to_str().ok())
        .filter(|k| !k.is_empty() && k.len() <= 128)
        .ok_or_else(|| ApiError::bad("Idempotency-Key must contain 1 to 128 characters"))?;
    let hash = hash_value(&json!(request));
    let mut tx = s.pool.begin().await?;
    // Serializes only this owner's key, allowing independent users and experiments to proceed.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("{}:research:{}", actor.id, key))
        .execute(&mut *tx)
        .await?;
    if let Some(row)=sqlx::query("SELECT request_hash,response FROM idempotency_keys WHERE owner_id=$1 AND scope='research' AND key=$2").bind(actor.id).bind(key).fetch_optional(&mut *tx).await? {
        if row.get::<String,_>("request_hash")!=hash {return Err(ApiError::conflict("Idempotency key was already used with another request"));}
        return Ok(Json(row.get("response")));
    }
    sqlx::query("SELECT id FROM users WHERE id=$1 FOR UPDATE")
        .bind(actor.id)
        .execute(&mut *tx)
        .await?;
    let pending: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM research_jobs WHERE owner_id=$1 AND status IN ('queued','running')",
    )
    .bind(actor.id)
    .fetch_one(&mut *tx)
    .await?;
    if pending >= 5 {
        return Err(ApiError::conflict(
            "A user may have at most five active research jobs",
        ));
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO research_jobs(id,owner_id,request,total) VALUES($1,$2,$3,$4)")
        .bind(id)
        .bind(actor.id)
        .bind(json!(request))
        .bind(request.cases.len() as i32)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO jobs(id,kind,payload) VALUES($1,'research',$2)")
        .bind(Uuid::new_v4())
        .bind(json!({"research_id":id}))
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO outbox(topic,payload) VALUES('research.queued',$1)")
        .bind(json!({"id":id}))
        .execute(&mut *tx)
        .await?;
    let response = json!({"id":id,"status":"queued","total":request.cases.len()});
    sqlx::query("INSERT INTO idempotency_keys(owner_id,scope,key,request_hash,response) VALUES($1,'research',$2,$3,$4)").bind(actor.id).bind(key).bind(hash).bind(&response).execute(&mut *tx).await?;
    depthguard_infrastructure::store::audit(&mut tx, actor.id, "research.enqueue", id).await?;
    tx.commit().await?;
    Ok(Json(response))
}
pub async fn get(
    State(s): State<AppState>,
    actor: Actor,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    Ok(Json(job_view(&s, &actor, id).await?))
}
async fn job_view(s: &AppState, actor: &Actor, id: Uuid) -> ApiResult<Value> {
    let row=sqlx::query("SELECT status,progress,total,cancel_requested,error FROM research_jobs WHERE id=$1 AND owner_id=$2").bind(id).bind(actor.id).fetch_optional(&s.pool).await?.ok_or_else(ApiError::not_found)?;
    Ok(
        json!({"id":id,"status":row.get::<String,_>("status"),"progress":row.get::<i32,_>("progress"),"total":row.get::<i32,_>("total"),"cancel_requested":row.get::<bool,_>("cancel_requested"),"error":row.get::<Option<String>,_>("error")}),
    )
}
pub async fn cancel(
    State(s): State<AppState>,
    actor: Actor,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let updated=sqlx::query("UPDATE research_jobs SET cancel_requested=true WHERE id=$1 AND owner_id=$2 AND status IN ('queued','running')").bind(id).bind(actor.id).execute(&s.pool).await?;
    if updated.rows_affected() == 0 {
        return Err(ApiError::not_found());
    }
    Ok(Json(json!({"id":id,"cancel_requested":true})))
}
pub async fn export(
    State(s): State<AppState>,
    actor: Actor,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let row = sqlx::query("SELECT request,status FROM research_jobs WHERE id=$1 AND owner_id=$2")
        .bind(id)
        .bind(actor.id)
        .fetch_optional(&s.pool)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let results: Vec<Value> =
        sqlx::query_scalar("SELECT result FROM research_cases WHERE job_id=$1 ORDER BY case_index")
            .bind(id)
            .fetch_all(&s.pool)
            .await?;
    let body = json!({"job_id":id,"request":row.get::<Value,_>("request"),"status":row.get::<String,_>("status"),"results":results,"schema_version":1});
    Ok(Json(
        json!({"content_hash":hash_value(&body),"artifact":body}),
    ))
}
pub async fn events(
    State(s): State<AppState>,
    actor: Actor,
    Path(id): Path<Uuid>,
) -> ApiResult<Sse<impl futures::Stream<Item = Result<Event, Infallible>>>> {
    job_view(&s, &actor, id).await?;
    let permit = s
        .streams
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError {
            status: axum::http::StatusCode::TOO_MANY_REQUESTS,
            code: "stream_limit",
            message: "Too many progress streams; retry shortly".into(),
        })?;
    let stream = futures::stream::unfold(
        (s, actor, id, 0u16, false, permit),
        |(s, actor, id, count, done, permit)| async move {
            if done || count >= 150 {
                return None;
            }
            if count > 0 {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
            let data = match job_view(&s, &actor, id).await {
                Ok(v) => v,
                Err(_) => json!({"status":"unavailable"}),
            };
            let terminal = matches!(
                data["status"].as_str(),
                Some("completed" | "cancelled" | "failed" | "unavailable")
            );
            let event = Event::default()
                .event("progress")
                .id(count.to_string())
                .data(data.to_string());
            Some((Ok(event), (s, actor, id, count + 1, terminal, permit)))
        },
    );
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DatasetInput {
    pub data: Value,
    pub provenance: Value,
}
pub async fn dataset_create(
    State(s): State<AppState>,
    actor: Actor,
    Json(input): Json<DatasetInput>,
) -> ApiResult<Json<Value>> {
    let orders = input.data.as_array().ok_or_else(|| {
        ApiError::bad("Dataset data must be an array of normalized historical records")
    })?;
    if orders.is_empty() || orders.len() > 10_000 {
        return Err(ApiError::bad("Dataset requires 1 to 10000 records"));
    }
    if !input.provenance.is_object()
        || input
            .provenance
            .get("source")
            .and_then(Value::as_str)
            .is_none()
    {
        return Err(ApiError::bad("Dataset provenance requires a source"));
    }
    let mut prior = 0;
    for row in orders {
        let slot = row
            .get("slot")
            .and_then(Value::as_u64)
            .ok_or_else(|| ApiError::bad("Historical record requires a slot"))?;
        if slot < prior {
            return Err(ApiError::bad("Dataset records must be in slot order"));
        }
        prior = slot;
        if !matches!(
            row.get("direction").and_then(Value::as_str),
            Some("buy" | "sell")
        ) {
            return Err(ApiError::bad("Historical direction must be buy or sell"));
        }
        let amount = row
            .get("amount")
            .ok_or_else(|| ApiError::bad("Historical record requires an atomic amount"))?;
        serde_json::from_value::<depthguard_domain::money::Atomic>(amount.clone())
            .map_err(|e| ApiError::bad(e.to_string()))?;
    }
    let record_count = orders.len();
    let id = Uuid::new_v4();
    let hash = hash_value(&input.data);
    sqlx::query(
        "INSERT INTO datasets(id,owner_id,content_hash,data,provenance) VALUES($1,$2,$3,$4,$5)",
    )
    .bind(id)
    .bind(actor.id)
    .bind(&hash)
    .bind(input.data)
    .bind(input.provenance)
    .execute(&s.pool)
    .await?;
    Ok(Json(
        json!({"id":id,"content_hash":hash,"records":record_count}),
    ))
}
pub async fn dataset_get(
    State(s): State<AppState>,
    actor: Actor,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let row = sqlx::query(
        "SELECT data,provenance,content_hash FROM datasets WHERE id=$1 AND owner_id=$2",
    )
    .bind(id)
    .bind(actor.id)
    .fetch_optional(&s.pool)
    .await?
    .ok_or_else(ApiError::not_found)?;
    Ok(Json(
        json!({"id":id,"data":row.get::<Value,_>("data"),"provenance":row.get::<Value,_>("provenance"),"content_hash":row.get::<String,_>("content_hash")}),
    ))
}

pub async fn enqueue_grid(
    state: State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Json(grid): Json<depthguard_application::research::GridRequest>,
) -> ApiResult<Json<Value>> {
    let request = grid.expand().map_err(ApiError::bad)?;
    enqueue(state, actor, headers, Json(request)).await
}
