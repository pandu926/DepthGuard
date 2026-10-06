mod contracts;
mod factory;
mod fees;
mod launch;
mod message;
mod swap;
use anchor_lang::Discriminator;
fn decode<T: bytemuck::Pod + Discriminator>(data: &[u8]) -> Result<T> {
    ensure!(
        data.len() == 8 + std::mem::size_of::<T>(),
        "Account size does not match pinned program layout"
    );
    ensure!(
        &data[..8] == T::DISCRIMINATOR,
        "Account discriminator mismatch"
    );
    bytemuck::try_pod_read_unaligned(&data[8..])
        .map_err(|_| anyhow::anyhow!("Account decoding failed"))
}
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::io::{Read, Write};
fn bytes(v: &Value, key: &str) -> Result<Vec<u8>> {
    Ok(STANDARD.decode(v[key].as_str().context("Missing encoded account")?)?)
}
fn number(v: &Value, key: &str) -> Result<u64> {
    v[key]
        .as_str()
        .context("Missing atomic amount")?
        .parse()
        .context("Invalid atomic amount")
}
fn quote(input: &Value) -> Result<Value> {
    match input["operation"].as_str() {
        Some("factory_position") => return factory::position(input),
        Some("factory_publication") => return factory::publication(input),
        Some("factory_graduation") => return factory::graduation(input),
        Some("factory_plan") => return factory::plan(input),
        Some("factory_platform") => return factory::platform(input),
        Some("contract_event") => return contracts::event(input),
        Some("contract_quote_accounts") => return contracts::quote_accounts(input),
        Some("contract_redemption_quote") => return contracts::redemption_quote(input),
        Some("contract_build") => return contracts::build(input),
        Some("contract_state") => return contracts::state(input),
        Some("contract_model") => return contracts::model(input),
        Some("fee_vault") => return fees::describe(input),
        Some("fee_claim") => return fees::claim(input),
        Some("fee_create") => return fees::create(input),
        Some("fee_sweep") => return fees::sweep(input),
        Some("fee_fund") => return fees::fund(input),
        Some("fee_event") => return fees::decode_event(input),
        Some("swap_prepare") => return swap::prepare(input),
        Some("message") => return message::build(input),
        Some("dbc_config") => return launch::config(input),
        Some("dbc_pool") => return launch::pool(input),
        Some("dbc_migrate") => return launch::migrate(input),
        Some("verify_launch") => return launch::verify(input),
        _ => {}
    }
    let protocol = input["protocol"].as_str().context("Protocol is required")?;
    let pool_bytes = bytes(input, "pool_data")?;
    if input["operation"] == "describe" {
        return match protocol {
            "dbc" => {
                let pool = decode::<dynamic_bonding_curve::state::VirtualPool>(&pool_bytes)?;
                Ok(
                    json!({"config":pool.pool_state.config.to_string(),"base_mint":pool.pool_state.base_mint.to_string(),"sqrt_price":pool.pool_state.sqrt_price.to_string(),"quote_reserve":pool.pool_state.quote_reserve.to_string(),"base_reserve":pool.pool_state.base_reserve.to_string(),"is_migrated":pool.pool_state.is_migrated}),
                )
            }
            "damm_v2" => {
                let pool = decode::<cp_amm::state::Pool>(&pool_bytes)?;
                Ok(json!({"sqrt_price":pool.sqrt_price.to_string()}))
            }
            _ => bail!("Unsupported protocol"),
        };
    }
    let amount = number(input, "amount")?;
    let slot = number(input, "slot")?;
    let timestamp = number(input, "timestamp")?;
    let direction = input["base_for_quote"]
        .as_bool()
        .context("Direction is required")?;
    let mode = input["mode"].as_str().context("Mode is required")?;
    match protocol {
        "dbc" => {
            let pool = decode::<dynamic_bonding_curve::state::VirtualPool>(&pool_bytes)?;
            let config_bytes = bytes(input, "config_data")?;
            let config = decode::<dynamic_bonding_curve::state::PoolConfig>(&config_bytes)?;
            ensure!(
                pool.pool_state.pool_type == 0,
                "Token-2022 base quotes require a certified transfer adapter"
            );
            ensure!(
                pool.pool_state.config.to_string()
                    == input["config_address"].as_str().unwrap_or(""),
                "Pool config address mismatch"
            );
            let r = match mode {
                "exact_in" => dynamic_bonding_curve_sdk::quote_exact_in::quote_exact_in(
                    &pool.pool_state,
                    &config,
                    direction,
                    timestamp,
                    slot,
                    amount,
                    false,
                    false,
                )?,
                "exact_out" => dynamic_bonding_curve_sdk::quote_exact_out::quote_exact_out(
                    &pool.pool_state,
                    &config,
                    direction,
                    timestamp,
                    slot,
                    amount,
                    false,
                )?,
                "partial_fill" => {
                    dynamic_bonding_curve_sdk::quote_partial_fill::quote_partial_fill(
                        &pool.pool_state,
                        &config,
                        direction,
                        timestamp,
                        slot,
                        amount,
                        false,
                        false,
                    )?
                }
                _ => bail!("Unsupported quote mode"),
            };
            Ok(
                json!({"input":r.included_fee_input_amount.to_string(),"excluded_fee_input":r.excluded_fee_input_amount.to_string(),"unused_input":r.amount_left.to_string(),"output":r.output_amount.to_string(),"sqrt_price":r.next_sqrt_price.to_string(),"trading_fee":r.trading_fee.to_string(),"protocol_fee":r.protocol_fee.to_string(),"referral_fee":r.referral_fee.to_string(),"quote_mint":config.quote_mint.to_string()}),
            )
        }
        "damm_v2" => {
            let pool = decode::<cp_amm::state::Pool>(&pool_bytes)?;
            ensure!(
                pool.token_a_flag == 0 && pool.token_b_flag == 0,
                "Token-2022 pool quotes require a certified transfer adapter"
            );
            let r = match mode {
                "exact_in" => damm_sdk::quote_exact_in::get_quote(
                    &pool, timestamp, slot, amount, direction, false,
                )?,
                "exact_out" => damm_sdk::quote_exact_out::get_quote(
                    &pool, timestamp, slot, amount, direction, false,
                )?,
                "partial_fill" => damm_sdk::quote_partial_fill_in::get_quote(
                    &pool, timestamp, slot, amount, direction, false,
                )?,
                _ => bail!("Unsupported quote mode"),
            };
            Ok(
                json!({"input":r.included_fee_input_amount.to_string(),"excluded_fee_input":r.excluded_fee_input_amount.to_string(),"unused_input":r.amount_left.to_string(),"output":r.output_amount.to_string(),"sqrt_price":r.next_sqrt_price.to_string(),"claimable_fee":r.claiming_fee.to_string(),"protocol_fee":r.protocol_fee.to_string(),"compounding_fee":r.compounding_fee.to_string(),"referral_fee":r.referral_fee.to_string(),"quote_mint":pool.token_b_mint.to_string()}),
            )
        }
        _ => bail!("Unsupported protocol"),
    }
}
fn main() -> Result<()> {
    let mut data = Vec::new();
    std::io::stdin().take(1_048_577).read_to_end(&mut data)?;
    ensure!(data.len() <= 1_048_576, "Input exceeds limit");
    let input: Value = serde_json::from_slice(&data)?;
    let result = match quote(&input) {
        Ok(value) => json!({"ok":true,"result":value}),
        Err(error) => json!({"ok":false,"error":error.to_string()}),
    };
    std::io::stdout().write_all(&serde_json::to_vec(&result)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recorded_quotes_match_native_and_official_program_outputs() {
        let fixtures: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/native-quotes.json")).unwrap();
        for case in fixtures["snapshots"].as_array().unwrap() {
            let result = quote(&case["input"]).unwrap();
            assert_eq!(result["output"], case["expected_output"]);
            for (field, expected) in case["native_result"].as_object().unwrap() {
                assert_eq!(&result[field], expected, "{field}");
            }
            let mut exact_out = case["input"].clone();
            exact_out["mode"] = json!("exact_out");
            exact_out["amount"] = result["output"].clone();
            let reverse = quote(&exact_out).unwrap();
            assert_eq!(reverse["output"], result["output"]);
            let needed = number(&reverse, "input").unwrap();
            assert!(needed <= number(&result, "input").unwrap() + 1);
        }
    }
}
