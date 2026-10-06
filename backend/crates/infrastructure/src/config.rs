use anyhow::{Context, Result, bail};
use std::{env, net::SocketAddr, path::PathBuf};
#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub bind: SocketAddr,
    pub origin: String,
    pub cluster: String,
    pub cookie_secure: bool,
    pub rpc_urls: Vec<String>,
    pub artifacts_dir: PathBuf,
    pub chain_writes: bool,
    pub contracts_enabled: bool,
    pub encryption_key: Option<[u8; 32]>,
    pub platform_wallet: Option<String>,
    pub damm_config: Option<String>,
}
impl Config {
    pub fn from_env() -> Result<Self> {
        let cluster = env::var("SOLANA_CLUSTER").unwrap_or_else(|_| "localnet".into());
        if !["localnet", "devnet", "mainnet-beta"].contains(&cluster.as_str()) {
            bail!("Unsupported SOLANA_CLUSTER");
        }
        let origin = env::var("APP_ORIGIN").unwrap_or_else(|_| "http://127.0.0.1:8800".into());
        let parsed = reqwest::Url::parse(&origin).context("Invalid APP_ORIGIN")?;
        if !["https", "http"].contains(&parsed.scheme())
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.host_str().is_none()
            || parsed.path() != "/"
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || parsed.origin().ascii_serialization() != origin
        {
            bail!("APP_ORIGIN must be a canonical HTTP origin");
        }
        let cookie_secure = parsed.scheme() == "https";
        if cluster == "mainnet-beta" && !cookie_secure {
            bail!("Mainnet requires HTTPS");
        }
        let rpc_urls: Vec<String> = env::var("SOLANA_RPC_URLS")
            .unwrap_or_else(|_| "http://127.0.0.1:8899".into())
            .split(',')
            .map(str::trim)
            .map(str::to_owned)
            .collect();
        for url in &rpc_urls {
            let parsed = reqwest::Url::parse(url).context("Invalid RPC configuration")?;
            if cluster != "localnet" && parsed.scheme() != "https" {
                bail!("Public RPC endpoints require TLS");
            }
        }
        let contracts_enabled = env::var("ENABLE_CONTRACTS").is_ok_and(|s| s == "true");
        if contracts_enabled && cluster == "mainnet-beta" {
            bail!("Contract mainnet execution requires separate immutable release acceptance");
        }
        let chain_writes = env::var("ENABLE_CHAIN_WRITES").is_ok_and(|s| s == "true");
        // Mainnet stays unavailable until target program, fee routing and recovery evidence are complete.
        if chain_writes && cluster == "mainnet-beta" {
            bail!(
                "Mainnet broadcast requires native launch and DFS certification; only localnet/devnet writes can be enabled"
            );
        }
        let encryption_key = env::var("KEY_ENCRYPTION_KEY")
            .ok()
            .filter(|v| !v.is_empty())
            .map(|v| -> Result<[u8; 32]> {
                hex::decode(v)
                    .context("Invalid account signer encryption key")?
                    .try_into()
                    .map_err(|_| anyhow::anyhow!("KEY_ENCRYPTION_KEY must contain 32 bytes in hex"))
            })
            .transpose()?;
        let platform_wallet = env::var("PLATFORM_FEE_WALLET")
            .ok()
            .filter(|v| !v.is_empty());
        let damm_config = env::var("DAMM_MIGRATION_CONFIG")
            .ok()
            .filter(|v| !v.is_empty());
        for value in [&platform_wallet, &damm_config].into_iter().flatten() {
            depthguard_domain::money::public_key(value).map_err(anyhow::Error::msg)?;
        }
        Ok(Self {
            database_url: env::var("DATABASE_URL").context("DATABASE_URL is required")?,
            bind: env::var("BIND_ADDRESS")
                .unwrap_or_else(|_| "127.0.0.1:8800".into())
                .parse()?,
            origin,
            cluster,
            cookie_secure,
            rpc_urls,
            artifacts_dir: env::var("ARTIFACTS_DIR")
                .unwrap_or_else(|_| "artifacts".into())
                .into(),
            chain_writes,
            contracts_enabled,
            encryption_key,
            platform_wallet,
            damm_config,
        })
    }
}
