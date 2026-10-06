use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use solana_instruction::{AccountMeta, Instruction};
use solana_message::Message;
use std::str::FromStr;
pub fn build(v: &Value) -> Result<Value> {
    let payer = solana_instruction::AccountMeta::new(
        v["payer"].as_str().context("Payer required")?.parse()?,
        true,
    )
    .pubkey;
    let hash = solana_hash::Hash::from_str(v["blockhash"].as_str().context("Blockhash required")?)?;
    let compute_program = solana_instruction::AccountMeta::new_readonly(
        "ComputeBudget111111111111111111111111111111".parse()?,
        false,
    )
    .pubkey;
    let mut limit = vec![2u8];
    limit.extend_from_slice(&600_000u32.to_le_bytes());
    let mut price = vec![3u8];
    price.extend_from_slice(&1_000u64.to_le_bytes());
    let mut instructions = vec![
        Instruction {
            program_id: compute_program,
            accounts: vec![],
            data: limit,
        },
        Instruction {
            program_id: compute_program,
            accounts: vec![],
            data: price,
        },
    ];
    for ix in v["instructions"]
        .as_array()
        .context("Instructions required")?
    {
        let accounts = ix["accounts"]
            .as_array()
            .context("Accounts required")?
            .iter()
            .map(|a| {
                Ok(AccountMeta {
                    pubkey: a["address"].as_str().context("Address required")?.parse()?,
                    is_signer: a["signer"].as_bool().unwrap_or(false),
                    is_writable: a["writable"].as_bool().unwrap_or(false),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        instructions.push(Instruction {
            program_id: ix["program_id"]
                .as_str()
                .context("Program required")?
                .parse()?,
            accounts,
            data: STANDARD.decode(ix["data"].as_str().context("Data required")?)?,
        });
    }
    ensure!(
        !instructions.is_empty() && instructions.len() <= 8,
        "Invalid instruction count"
    );
    let message = Message::new_with_blockhash(&instructions, Some(&payer), &hash);
    let bytes = message.serialize();
    let count = message.header.num_required_signatures as usize;
    ensure!(count > 0 && count < 128, "Invalid signer count");
    let mut wire = vec![count as u8];
    wire.resize(1 + count * 64, 0);
    wire.extend_from_slice(&bytes);
    ensure!(wire.len() <= 1232, "Transaction exceeds Solana packet size");
    Ok(
        json!({"message":STANDARD.encode(bytes),"transaction":STANDARD.encode(wire),"required_signers":message.account_keys.iter().take(count).map(ToString::to_string).collect::<Vec<_>>()}),
    )
}
