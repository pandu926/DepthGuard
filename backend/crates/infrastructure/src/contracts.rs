use crate::{native, rpc::Rpc};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
pub const REGISTRY: &str = "5sUGNQ5pymevqfVmg99rgQ2jM4aVSo6RqhJtSK7VrPYz";
pub const ESCROW: &str = "8zEaBFNNVDx9U4Cr111xfZjUmX7JMBapJhd6yT4XwtuZ";
pub const RESERVE: &str = "7kaGXYpxPuCoh5o2AhxRoU8F13UUkHjfxVZUTYsKG88Y";
pub fn program(kind: &str) -> Result<&'static str> {
    match kind {
        "model" | "launch" => Ok(REGISTRY),
        "escrow" => Ok(ESCROW),
        "reserve" => Ok(RESERVE),
        _ => anyhow::bail!("Unsupported contract account kind"),
    }
}
pub async fn snapshot(
    rpc: &Rpc,
    kind: &str,
    address: &str,
    min_slot: Option<i64>,
) -> Result<(Value, u64)> {
    let owner = program(kind)?;
    let response=rpc.call("getAccountInfo",json!([address,{"encoding":"base64","commitment":"finalized","minContextSlot":min_slot}])).await?;
    ensure!(
        response["value"]["owner"] == owner,
        "Contract owner mismatch"
    );
    let data = native::invoke(
        &json!({"operation":"contract_state","kind":kind,"data":response["value"]["data"][0]}),
    )
    .await?;
    Ok((
        data,
        response["context"]["slot"]
            .as_u64()
            .context("Context slot required")?,
    ))
}
pub async fn index_receipts(pool: &PgPool, rpc: &Rpc, cluster: &str) -> Result<()> {
    rpc.verify_cluster(cluster).await?;
    let rows=sqlx::query("SELECT p.id,p.summary,p.confirmed_slot FROM prepared_transactions p WHERE p.cluster=$1 AND p.state='finalized' AND p.summary->>'kind'='contract_action' AND NOT EXISTS(SELECT 1 FROM contract_receipts c WHERE c.transaction_id=p.id) ORDER BY p.updated_at LIMIT 10").bind(cluster).fetch_all(pool).await?;
    for row in rows {
        let summary: Value = row.get("summary");
        let mut snapshots = Vec::new();
        for account in summary["projections"]
            .as_array()
            .context("Projection list required")?
        {
            let address = account["address"].as_str().context("Address required")?;
            let kind = account["kind"].as_str().context("Kind required")?;
            let (data, slot) = snapshot(rpc, kind, address, row.get("confirmed_slot")).await?;
            snapshots.push((
                address.to_owned(),
                kind.to_owned(),
                data,
                i64::try_from(slot)?,
            ));
        }
        let mut tx = pool.begin().await?;
        for (address, kind, data, slot) in snapshots {
            sqlx::query("INSERT INTO contract_accounts(cluster,address,kind,program_id,data,context_slot) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(cluster,address) DO UPDATE SET data=EXCLUDED.data,context_slot=EXCLUDED.context_slot,observed_at=now() WHERE contract_accounts.context_slot<=EXCLUDED.context_slot").bind(cluster).bind(address).bind(&kind).bind(program(&kind)?).bind(data).bind(slot).execute(&mut *tx).await?;
        }
        sqlx::query(
            "INSERT INTO contract_receipts(transaction_id) VALUES($1) ON CONFLICT DO NOTHING",
        )
        .bind(row.get::<uuid::Uuid, _>("id"))
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
    }
    Ok(())
}
/// Program-data logs are accepted only while the runtime invocation stack identifies our program.
pub async fn record_events(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    cluster: &str,
    signature: &str,
    commitment: &str,
    transaction: &Value,
) -> Result<()> {
    let Some(logs) = transaction["meta"]["logMessages"].as_array() else {
        return Ok(());
    };
    ensure!(logs.len() <= 10000, "Receipt log limit exceeded");
    let mut stack = Vec::<String>::new();
    for (index, line) in logs.iter().enumerate() {
        let Some(line) = line.as_str() else {
            continue;
        };
        if let Some(rest) = line.strip_prefix("Program ") {
            let fields = rest.split_whitespace().collect::<Vec<_>>();
            if fields.len() == 3 && fields[1] == "invoke" {
                let depth = fields[2].trim_matches(['[', ']']).parse::<usize>()?;
                ensure!(depth > 0 && depth <= 5, "Invalid invocation depth");
                stack.truncate(depth - 1);
                stack.push(fields[0].into());
            } else if fields.len() >= 2
                && (fields[1] == "success" || fields[1] == "failed:")
                && stack.last().is_some_and(|id| id == fields[0])
            {
                stack.pop();
            }
        }
        if let Some(encoded) = line.strip_prefix("Program data: ")
            && let Some(program) = stack.last()
            && [REGISTRY, ESCROW, RESERVE].contains(&program.as_str())
        {
            let mut event = native::invoke(
                &json!({"operation":"contract_event","program_id":program,"data":encoded}),
            )
            .await?;
            if event["kind"] == "untracked" {
                continue;
            }
            event["program_id"] = json!(program);
            event["source"] = json!("runtime_program_data_log");
            sqlx::query("INSERT INTO chain_events(cluster,signature,instruction_index,event_index,slot,commitment,data) VALUES($1,$2,-1,$3,$4,$5,$6) ON CONFLICT(cluster,signature,instruction_index,event_index) DO UPDATE SET commitment=EXCLUDED.commitment").bind(cluster).bind(signature).bind(i32::try_from(index)?).bind(transaction["slot"].as_i64().context("Receipt slot required")?).bind(commitment).bind(event).execute(&mut **tx).await?;
        }
    }
    Ok(())
}
