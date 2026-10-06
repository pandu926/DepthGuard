use depthguard_api::{AppState, router};
use depthguard_infrastructure::{config::Config, store};
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=warn".into()),
        )
        .init();
    if std::env::args().any(|a| a == "contract") {
        println!(
            "{}",
            serde_json::to_string_pretty(&depthguard_api::contract::document())?
        );
        return Ok(());
    }
    let config = Config::from_env()?;
    let pool = store::connect(&config.database_url).await?;
    if std::env::args().any(|a| a == "migrate") {
        store::migrate(&pool).await?;
        tracing::info!("Database migrations complete");
        return Ok(());
    }
    // Database migrations run as a separate deployment step.
    store::assert_schema(&pool).await?;
    let bind = config.bind;
    let app = router(AppState::new(pool.clone(), config)?);
    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!(%bind,"DepthGuard API listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await?;
    pool.close().await;
    Ok(())
}
async fn shutdown() {
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("Signal handler");
    tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{}}
    tracing::info!("Graceful shutdown requested");
}
