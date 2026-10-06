use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::RwLock;
const MAINNET: &str = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const DEVNET: &str = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
#[derive(Clone)]
struct Identity {
    genesis: String,
    verified_at: Instant,
}
/// URLs may contain credentials. Diagnostics identify only provider indexes and methods.
#[derive(Clone)]
pub struct Rpc {
    urls: Arc<Vec<String>>,
    client: reqwest::Client,
    id: Arc<AtomicU64>,
    expected: Arc<RwLock<Option<String>>>,
    identities: Arc<RwLock<Vec<Option<Identity>>>>,
}
impl Rpc {
    pub fn new(urls: Vec<String>) -> Result<Self> {
        if urls.is_empty() || urls.len() > 3 {
            bail!("RPC requires one to three providers");
        }
        Ok(Self {
            identities: Arc::new(RwLock::new(vec![None; urls.len()])),
            urls: Arc::new(urls),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(4))
                .connect_timeout(Duration::from_secs(2))
                .build()?,
            id: Arc::new(AtomicU64::new(1)),
            expected: Arc::new(RwLock::new(None)),
        })
    }
    async fn raw(&self, index: usize, method: &str, params: &Value) -> Result<Value> {
        let id = self.id.fetch_add(1, Ordering::Relaxed);
        let response = self
            .client
            .post(&self.urls[index])
            .json(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("RPC transport unavailable at provider {index}"))?;
        if !response.status().is_success() {
            bail!("RPC HTTP failure at provider {index}");
        }
        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| anyhow::anyhow!("RPC body unavailable at provider {index}"))?
        {
            if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
                bail!("RPC response exceeds limit at provider {index}");
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("Invalid RPC JSON at provider {index}"))?;
        if value["id"] != id {
            bail!("RPC response ID mismatch at provider {index}");
        }
        Ok(value)
    }
    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let work = async {
            let rounds = if method.starts_with("get") || method == "simulateTransaction" {
                2
            } else {
                1
            };
            for round in 0..rounds {
                if round > 0 {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
                for index in 0..self.urls.len() {
                    if let Some(expected) = self.expected.read().await.clone() {
                        let cached = self.identities.read().await[index].clone();
                        let valid = cached.is_some_and(|c| {
                            c.genesis == expected
                                && c.verified_at.elapsed() < Duration::from_secs(60)
                        });
                        if !valid {
                            let Ok(identity) = self.raw(index, "getGenesisHash", &json!([])).await
                            else {
                                continue;
                            };
                            if identity["result"].as_str() != Some(&expected) {
                                tracing::warn!(provider = index, "RPC cluster mismatch");
                                continue;
                            }
                            self.identities.write().await[index] = Some(Identity {
                                genesis: expected,
                                verified_at: Instant::now(),
                            });
                        }
                    }
                    match self.raw(index, method, &params).await {
                        Ok(value) => {
                            if let Some(result) = value.get("result") {
                                return Ok(result.clone());
                            }
                            let code = value["error"]["code"].as_i64().unwrap_or(0);
                            if [-32005, -32603].contains(&code) {
                                continue;
                            }
                            bail!("RPC rejected {method} at provider {index} (code {code})");
                        }
                        Err(_) => {
                            tracing::warn!(provider = index, method, "RPC provider unavailable")
                        }
                    }
                }
            }
            bail!("All RPC providers unavailable for {method}")
        };
        tokio::time::timeout(Duration::from_secs(10), work)
            .await
            .map_err(|_| anyhow::anyhow!("RPC deadline exceeded for {method}"))?
    }
    pub async fn verify_cluster(&self, cluster: &str) -> Result<()> {
        let genesis = self.call("getGenesisHash", json!([])).await?;
        let genesis = genesis
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Invalid genesis response"))?;
        let valid = match cluster {
            "mainnet-beta" => genesis == MAINNET,
            "devnet" => genesis == DEVNET,
            "localnet" => genesis != MAINNET && genesis != DEVNET,
            _ => false,
        };
        if !valid {
            bail!("RPC cluster identity mismatch");
        }
        let mut expected = self.expected.write().await;
        if expected.as_ref().is_some_and(|e| e != genesis) {
            bail!("RPC genesis changed during the session");
        }
        *expected = Some(genesis.into());
        Ok(())
    }
    pub async fn account(&self, address: &str) -> Result<Value> {
        self.call(
            "getAccountInfo",
            json!([address,{"encoding":"base64","commitment":"confirmed"}]),
        )
        .await
    }
    pub async fn signature_status(&self, signature: &str) -> Result<Value> {
        self.call(
            "getSignatureStatuses",
            json!([[signature],{"searchTransactionHistory":true}]),
        )
        .await
    }
}
