use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use litesvm::LiteSVM;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use solana_account::{Account, ReadableAccount};
use solana_address::Address;
use solana_clock::Clock;
use solana_transaction::versioned::VersionedTransaction;
use std::{
    io::{Read, Write},
    str::FromStr,
};
const PROGRAMS: [(&str, &str, &str); 4] = [
    (
        "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
        "dynamic_bonding_curve.so",
        "71e06857b67882bff19d9c57134b150530a168973eea30c75edc7ceec4eaf401",
    ),
    (
        "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
        "cp_amm.so",
        "af48ce6be0f2c589b389751596e8b5303b5ca444e6d46708fff008e7689ab6e9",
    ),
    (
        "dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh",
        "dynamic_fee_sharing.so",
        "54cb4f771847aa1220bbc82792336f2fa3a68b206d5df80df0c989ad0704b0a8",
    ),
    (
        "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
        "metaplex.so",
        "28d1fcad13c77e5c976289a6983d1258309af4a9762cf50aef80b5537732e87f",
    ),
];
fn run(v: &Value) -> Result<Value> {
    let dir = std::env::var("SBF_FIXTURES_DIR").unwrap_or_else(|_| "proof/fixtures".into());
    let mut svm = LiteSVM::new().with_blockhash_check(false);
    for (id, file, hash) in PROGRAMS {
        let bytes = std::fs::read(std::path::Path::new(&dir).join(file))?;
        ensure!(
            hex::encode(Sha256::digest(&bytes)) == hash,
            "Program binary checksum mismatch"
        );
        svm.add_program(Address::from_str(id)?, &bytes)
            .map_err(|_| anyhow::anyhow!("Program loading failed"))?;
    }
    let accounts = v["accounts"]
        .as_array()
        .context("Initial accounts required")?;
    ensure!(accounts.len() <= 100, "Too many accounts");
    for account in accounts {
        let data = STANDARD.decode(account["data"].as_str().context("Account data required")?)?;
        ensure!(data.len() <= 16_384, "Account exceeds size limit");
        let address = Address::from_str(
            account["address"]
                .as_str()
                .context("Account address required")?,
        )?;
        let owner = Address::from_str(
            account["owner"]
                .as_str()
                .context("Account owner required")?,
        )?;
        ensure!(
            !account["executable"].as_bool().unwrap_or(false),
            "User supplied executable accounts are prohibited"
        );
        let lamports = account["lamports"]
            .as_str()
            .context("Atomic lamports required")?
            .parse()?;
        svm.set_account(
            address,
            Account {
                lamports,
                data,
                owner,
                executable: false,
                rent_epoch: 0,
            },
        )?;
    }
    let mut clock = svm.get_sysvar::<Clock>();
    clock.slot = v["slot"].as_str().context("Slot required")?.parse()?;
    clock.unix_timestamp = v["timestamp"]
        .as_str()
        .context("Timestamp required")?
        .parse()?;
    svm.set_sysvar(&clock);
    let wire = STANDARD.decode(v["transaction"].as_str().context("Transaction required")?)?;
    ensure!(wire.len() <= 1232, "Transaction exceeds Solana packet size");
    let transaction: VersionedTransaction = bincode::deserialize(&wire)?;
    let simulated = svm
        .simulate_transaction(transaction)
        .map_err(|e| anyhow::anyhow!("SBF simulation rejected: {:?}", e.err))?;
    let receiver = Address::from_str(
        v["output_account"]
            .as_str()
            .context("Output account required")?,
    )?;
    let amount = |data: &[u8]| -> Result<u64> {
        ensure!(data.len() >= 72, "Token account too short");
        Ok(u64::from_le_bytes(data[64..72].try_into()?))
    };
    let before = svm
        .get_account(&receiver)
        .map(|a| amount(&a.data))
        .transpose()?
        .unwrap_or(0);
    let after = simulated
        .post_accounts
        .iter()
        .find(|(a, _)| a == &receiver)
        .map(|(_, a)| amount(a.data()))
        .transpose()?
        .unwrap_or(before);
    ensure!(after >= before, "Output account balance decreased");
    Ok(
        json!({"evidence":"local_sbf","execution":"simulated","signature_verification":true,"blockhash_check":false,"initial_state":"supplied_offline_snapshot","output":(after-before).to_string(),"compute_units":simulated.meta.compute_units_consumed.to_string(),"logs":simulated.meta.logs,"program_hashes":PROGRAMS.iter().map(|(_,f,h)|json!({"file":f,"sha256":h})).collect::<Vec<_>>()}),
    )
}
fn main() -> Result<()> {
    let mut bytes = Vec::new();
    std::io::stdin().take(1_048_577).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 1_048_576, "Input exceeds limit");
    let v: Value = serde_json::from_slice(&bytes)?;
    let result = match run(&v) {
        Ok(result) => json!({"ok":true,"result":result}),
        Err(e) => json!({"ok":false,"error":e.to_string()}),
    };
    std::io::stdout().write_all(&serde_json::to_vec(&result)?)?;
    Ok(())
}
