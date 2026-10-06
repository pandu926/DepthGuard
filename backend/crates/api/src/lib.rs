pub mod auth;
pub mod catalog;
pub mod contract;
pub mod error;
pub mod factory;
pub mod launches;
pub mod markets;
pub mod middleware;
pub mod models;
pub mod modules;
pub mod product;
pub mod research;
pub mod transactions;
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderValue, Method},
    routing::{get, post},
};
use depthguard_infrastructure::{config::Config, rpc::Rpc};
use serde_json::{Value, json};
use sha2::Digest;
use sqlx::PgPool;
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tower_http::{cors::CorsLayer, timeout::TimeoutLayer, trace::TraceLayer};
#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub config: Arc<Config>,
    pub rpc: Rpc,
    pub requests: Arc<AtomicU64>,
    pub errors: Arc<AtomicU64>,
    pub latency_micros: Arc<AtomicU64>,
    pub inflight: Arc<tokio::sync::Semaphore>,
    pub streams: Arc<tokio::sync::Semaphore>,
}
impl AppState {
    pub fn new(pool: PgPool, config: Config) -> anyhow::Result<Self> {
        Ok(Self {
            pool,
            rpc: Rpc::new(config.rpc_urls.clone())?,
            config: Arc::new(config),
            requests: Arc::new(AtomicU64::new(0)),
            errors: Arc::new(AtomicU64::new(0)),
            latency_micros: Arc::new(AtomicU64::new(0)),
            inflight: Arc::new(tokio::sync::Semaphore::new(32)),
            streams: Arc::new(tokio::sync::Semaphore::new(32)),
        })
    }
}
pub fn router(s: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(
            s.config
                .origin
                .parse::<HeaderValue>()
                .expect("Validated origin"),
        )
        .allow_credentials(true)
        .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::DELETE])
        .allow_headers([
            axum::http::header::CONTENT_TYPE,
            axum::http::header::HeaderName::from_static("x-csrf-token"),
            axum::http::header::HeaderName::from_static("idempotency-key"),
        ]);
    Router::new()
        .route(
            "/health/live",
            get(|| async { Json(json!({"status":"alive"})) }),
        )
        .route("/health/ready", get(ready))
        .route("/metrics", get(metrics))
        .route(
            "/api/v1/openapi.json",
            get(|| async { Json(contract::document()) }),
        )
        .route("/api/v1/capabilities", get(capabilities))
        .route("/api/v1/tokens", get(product::tokens))
        .route("/api/v1/tokens/{address}", get(product::token))
        .route("/api/v1/me/models", get(product::drafts))
        .route("/api/v1/me/launches", get(product::launches))
        .route("/api/v1/me/activity", get(product::activity))
        .route("/api/v1/me/portfolio", get(product::portfolio))
        .route(
            "/api/v1/factory/models/{id}/next",
            post(factory::register_model),
        )
        .route("/api/v1/factory/launches", post(factory::create))
        .route("/api/v1/factory/launches/{id}", get(factory::get))
        .route("/api/v1/factory/launches/{id}/next", post(factory::next))
        .route(
            "/api/v1/factory/launches/{id}/graduate",
            post(factory::graduate),
        )
        .route("/api/v1/contracts/prepare", post(modules::prepare))
        .route("/api/v1/contracts/models/encode", post(modules::encode))
        .route("/api/v1/contracts/{kind}/{address}", get(modules::state))
        .route(
            "/api/v1/contracts/{kind}/{address}/redemption-quote",
            post(modules::redemption_quote),
        )
        .route("/api/v1/parameters", get(parameters))
        .route("/api/v1/markets", get(catalog::markets))
        .route("/api/v1/markets/{address}", get(catalog::market))
        .route("/api/v1/me/earnings", get(catalog::earnings))
        .route("/api/v1/quotes", post(markets::quote))
        .route("/api/v1/swaps/prepare", post(markets::prepare_swap))
        .route("/api/v1/native/validate", post(native_validate))
        .route("/api/v1/fee-vaults/{address}", get(transactions::vault))
        .route(
            "/api/v1/fee-vaults/{address}/claims/prepare",
            post(transactions::prepare_claim),
        )
        .route("/api/v1/transactions/{id}", get(transactions::get))
        .route(
            "/api/v1/transactions/{id}/submit",
            post(transactions::submit),
        )
        .route("/api/v1/auth/challenges", post(auth::challenge))
        .route("/api/v1/auth/verify", post(auth::verify))
        .route("/api/v1/auth/logout", post(auth::logout))
        .route("/api/v1/me", get(auth::me))
        .route("/api/v1/launches", post(launches::create))
        .route("/api/v1/launches/{id}", get(launches::get))
        .route(
            "/api/v1/launches/{id}/fees/sweep/prepare",
            post(transactions::prepare_sweep),
        )
        .route(
            "/api/v1/launches/{id}/steps/{step}/prepare",
            post(launches::prepare),
        )
        .route("/api/v1/models", post(models::create))
        .route(
            "/api/v1/models/{id}",
            get(models::get).patch(models::update),
        )
        .route("/api/v1/models/{id}/publish", post(models::publish))
        .route("/api/v1/model-versions", get(models::browse))
        .route("/api/v1/model-versions/{id}", get(models::version))
        .route("/api/v1/model-versions/{id}/fork", post(models::fork))
        .route("/api/v1/economies/validate", post(models::validate))
        .route("/api/v1/economies/compile", post(models::compile))
        .route(
            "/api/v1/economies/native-parameters",
            post(models::native_parameters),
        )
        .route("/api/v1/previews", post(research::preview))
        .route("/api/v1/simulations", post(research::enqueue))
        .route("/api/v1/simulations/grids", post(research::enqueue_grid))
        .route("/api/v1/simulations/{id}", get(research::get))
        .route("/api/v1/simulations/{id}/cancel", post(research::cancel))
        .route("/api/v1/simulations/{id}/export", get(research::export))
        .route("/api/v1/simulations/{id}/events", get(research::events))
        .route("/api/v1/datasets", post(research::dataset_create))
        .route("/api/v1/datasets/{id}", get(research::dataset_get))
        .fallback(|| async { error::ApiError::not_found() })
        .layer(axum::middleware::from_fn_with_state(
            s.clone(),
            middleware::guard,
        ))
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(cors)
        .layer(TimeoutLayer::with_status_code(
            axum::http::StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(310),
        ))
        .layer(TraceLayer::new_for_http())
        .with_state(s)
}
async fn ready(State(s): State<AppState>) -> Result<Json<Value>, error::ApiError> {
    sqlx::query("SELECT 1").execute(&s.pool).await?;
    Ok(Json(
        json!({"status":"ready","database":"connected","chain_write_capability":s.config.chain_writes}),
    ))
}
async fn metrics(State(s): State<AppState>) -> String {
    let queue: i64 =
        sqlx::query_scalar("SELECT count(*) FROM jobs WHERE state IN ('pending','running')")
            .fetch_one(&s.pool)
            .await
            .unwrap_or(-1);
    let heartbeat:Option<f64>=sqlx::query_scalar("SELECT extract(epoch FROM observed_at)::float8 FROM service_heartbeats WHERE service='research-worker'").fetch_optional(&s.pool).await.unwrap_or(None);
    let backup_path = s.config.artifacts_dir.join(".backup-success");
    let backup = tokio::fs::read_to_string(backup_path)
        .await
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(0);
    format!(
        "# TYPE depthguard_queue_depth gauge\ndepthguard_queue_depth {queue}\n# TYPE depthguard_requests_total counter\ndepthguard_requests_total {}\n# TYPE depthguard_errors_total counter\ndepthguard_errors_total {}\n# TYPE depthguard_request_duration_seconds_sum counter\ndepthguard_request_duration_seconds_sum {}\n# TYPE depthguard_worker_heartbeat_seconds gauge\ndepthguard_worker_heartbeat_seconds {}\n# TYPE depthguard_backup_success_seconds gauge\ndepthguard_backup_success_seconds {backup}\n",
        s.requests.load(Ordering::Relaxed),
        s.errors.load(Ordering::Relaxed),
        s.latency_micros.load(Ordering::Relaxed) as f64 / 1_000_000.0,
        heartbeat.unwrap_or(0.0)
    )
}
async fn capabilities(State(s): State<AppState>) -> Json<Value> {
    Json(
        json!({"cluster":s.config.cluster,"factory":{"enabled":s.config.contracts_enabled,"preparation":s.config.contracts_enabled&&s.config.encryption_key.is_some(),"broadcast":s.config.chain_writes},"schema_version":1,"engine_version":depthguard_domain::economy::ENGINE_VERSION,"analytical_research":true,"native_launch":{"preparation":s.config.encryption_key.is_some()&&s.config.platform_wallet.is_some(),"profile":"spl_immutable_quote_fees_permanent_partner_lp","mechanisms":["meme","asset_quote"],"broadcast":s.config.chain_writes},"native_fee_sharing":"dfs_vault_claim_and_finalized_receipt_verification","sdk_quote":true,"local_sbf":std::env::var("SBF_HELPER_PATH").is_ok(),"funding_escrow":s.config.contracts_enabled,"burn_redemption":s.config.contracts_enabled,"mainnet_broadcast":false,"production_certified":false,"gates":["Target-network deployment and RPC reliability acceptance","Off-host backup restore and sustained load acceptance","External security review before handling public-network production launches"]}),
    )
}
async fn parameters() -> Json<Value> {
    Json(
        serde_json::from_str(include_str!(
            "../../../../docs/research/native-parameter-schema.json"
        ))
        .expect("Checked-in parameter schema"),
    )
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeInput {
    protocol: String,
    root: String,
    parameters: Value,
}
async fn native_validate(Json(input): Json<NativeInput>) -> Result<Json<Value>, error::ApiError> {
    let bytes = depthguard_domain::native::encode(&input.protocol, &input.root, &input.parameters)
        .map_err(error::ApiError::bad)?;
    Ok(Json(
        json!({"valid":true,"evidence":"idl_structure_and_selected_constraints","deployment_certified":false,"borsh_bytes":bytes.len(),"borsh_sha256":hex::encode(sha2::Sha256::digest(&bytes))}),
    ))
}
