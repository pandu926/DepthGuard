use anyhow::{Result, bail};
use serde_json::Value;
use std::{process::Stdio, time::Duration};
use tokio::{io::AsyncWriteExt, process::Command};
/// Separate Rust process prevents incompatible Anchor account types from entering API code.
pub async fn invoke(input: &Value) -> Result<Value> {
    let binary = std::env::var("NATIVE_HELPER_PATH").unwrap_or_else(|_| "depthguard-native".into());
    let mut child = Command::new(binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow::anyhow!("Native helper stdin unavailable"))?;
    let bytes = serde_json::to_vec(input)?;
    if bytes.len() > 1_048_576 {
        bail!("Native helper request exceeds limit");
    }
    stdin.write_all(&bytes).await?;
    drop(stdin);
    let output = tokio::time::timeout(Duration::from_secs(3), child.wait_with_output()).await??;
    if !output.status.success() || output.stdout.len() > 1_048_576 {
        bail!("Native helper execution failed");
    }
    let response: Value = serde_json::from_slice(&output.stdout)?;
    if response["ok"] != true {
        bail!("Native quote rejected by pinned SDK");
    }
    Ok(response["result"].clone())
}

pub async fn simulate_sbf(input: &Value) -> Result<Value> {
    let binary = std::env::var("SBF_HELPER_PATH").unwrap_or_else(|_| "depthguard-sbf".into());
    let mut child = Command::new(binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow::anyhow!("SBF helper stdin unavailable"))?;
    let bytes = serde_json::to_vec(input)?;
    if bytes.len() > 1_048_576 {
        bail!("SBF request exceeds limit");
    }
    stdin.write_all(&bytes).await?;
    drop(stdin);
    let output = tokio::time::timeout(Duration::from_secs(10), child.wait_with_output()).await??;
    if !output.status.success() || output.stdout.len() > 1_048_576 {
        bail!("SBF helper execution failed");
    }
    let response: Value = serde_json::from_slice(&output.stdout)?;
    if response["ok"] != true {
        bail!("SBF program simulation rejected the supplied snapshot");
    }
    Ok(response["result"].clone())
}
