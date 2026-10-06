use anyhow::{Context, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use litesvm::LiteSVM;
use serde_json::{Value, json};
use solana_account::{Account, ReadableAccount};
use solana_address::Address;
use solana_clock::Clock;
use solana_transaction::versioned::VersionedTransaction;
use std::{
    io::{BufRead, Write},
    str::FromStr,
};
fn address(v: &Value, k: &str) -> Result<Address> {
    Ok(Address::from_str(
        v[k].as_str().context("Address required")?,
    )?)
}
fn run(vm: &mut LiteSVM, v: &Value) -> Result<Value> {
    match v["op"].as_str().context("Operation required")? {
        "load" => {
            let bytes = std::fs::read(v["path"].as_str().context("Path required")?)?;
            vm.add_program(address(v, "address")?, &bytes)
                .map_err(|e| anyhow::anyhow!("Program loading failed: {e:?}"))?;
            Ok(json!(true))
        }
        "get" => {
            let a = vm.get_account(&address(v, "address")?);
            Ok(a.map(|a|json!({"data":STANDARD.encode(a.data()),"lamports":a.lamports().to_string(),"owner":a.owner().to_string(),"executable":a.executable()})).unwrap_or(Value::Null))
        }
        "set" => {
            let a = &v["account"];
            vm.set_account(
                address(v, "address")?,
                Account {
                    lamports: a["lamports"]
                        .as_str()
                        .context("Lamports required")?
                        .parse()?,
                    data: STANDARD.decode(a["data"].as_str().context("Data required")?)?,
                    owner: address(a, "owner")?,
                    executable: a["executable"].as_bool().unwrap_or(false),
                    rent_epoch: 0,
                },
            )?;
            Ok(json!(true))
        }
        "clock" => {
            let c = vm.get_sysvar::<Clock>();
            Ok(json!({"slot":c.slot.to_string(),"unixTimestamp":c.unix_timestamp.to_string()}))
        }
        "set_clock" => {
            let mut c = vm.get_sysvar::<Clock>();
            c.slot = v["slot"].as_str().context("Slot required")?.parse()?;
            c.unix_timestamp = v["unixTimestamp"]
                .as_str()
                .context("Time required")?
                .parse()?;
            vm.set_sysvar(&c);
            Ok(json!(true))
        }
        "blockhash" => Ok(json!(vm.latest_blockhash().to_string())),
        "expire" => {
            vm.expire_blockhash();
            Ok(json!(true))
        }
        "airdrop" => {
            vm.airdrop(
                &address(v, "address")?,
                v["amount"].as_str().context("Amount required")?.parse()?,
            )
            .map_err(|e| anyhow::anyhow!("Airdrop failed: {e:?}"))?;
            Ok(json!(true))
        }
        "rent" => Ok(json!(
            vm.minimum_balance_for_rent_exemption(
                v["size"].as_u64().context("Size required")? as usize
            )
            .to_string()
        )),
        "sigverify" => {
            let value = v["value"].as_bool().context("Flag required")?;
            *vm = std::mem::replace(vm, LiteSVM::new()).with_sigverify(value);
            Ok(json!(true))
        }
        "send" | "simulate" => {
            let wire = STANDARD.decode(v["wire"].as_str().context("Wire required")?)?;
            let tx: VersionedTransaction = bincode::deserialize(&wire)?;
            if v["op"] == "send" {
                match vm.send_transaction(tx) {
                    Ok(m) => Ok(
                        json!({"logs":m.logs,"computeUnits":m.compute_units_consumed.to_string(),"signature":m.signature.as_ref()}),
                    ),
                    Err(e) => anyhow::bail!("{:?}\n{}", e.err, e.meta.logs.join("\n")),
                }
            } else {
                match vm.simulate_transaction(tx) {
                    Ok(s) => Ok(
                        json!({"logs":s.meta.logs,"computeUnits":s.meta.compute_units_consumed.to_string()}),
                    ),
                    Err(e) => anyhow::bail!("{:?}\n{}", e.err, e.meta.logs.join("\n")),
                }
            }
        }
        _ => anyhow::bail!("Unknown test operation"),
    }
}
fn main() -> Result<()> {
    let mut vm = LiteSVM::new();
    let mut out = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines() {
        let line = line?;
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(v) => match run(&mut vm, &v) {
                Ok(result) => json!({"ok":true,"result":result}),
                Err(e) => json!({"ok":false,"error":e.to_string()}),
            },
            Err(e) => json!({"ok":false,"error":e.to_string()}),
        };
        writeln!(out, "{response}")?;
        out.flush()?;
    }
    Ok(())
}
