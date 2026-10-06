use anchor_lang::{InstructionData, ToAccountMetas, prelude::Pubkey};
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::str::FromStr;
fn key(v: &Value, name: &str) -> Result<Pubkey> {
    Pubkey::from_str(v[name].as_str().context("Missing swap public key")?)
        .context("Invalid swap key")
}
fn ix(
    program: Pubkey,
    accounts: Vec<anchor_lang::solana_program::instruction::AccountMeta>,
    data: Vec<u8>,
) -> Value {
    json!({"program_id":program.to_string(),"accounts":accounts.iter().map(|a|json!({"address":a.pubkey.to_string(),"signer":a.is_signer,"writable":a.is_writable})).collect::<Vec<_>>(),"data":STANDARD.encode(data)})
}
fn ata(owner: Pubkey, mint: Pubkey, token: Pubkey, ata_program: Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), token.as_ref(), mint.as_ref()],
        &ata_program,
    )
    .0
}
pub fn prepare(v: &Value) -> Result<Value> {
    // Decode and quote first: this binds the pool/config and enforces supported token layouts.
    let mut request = v.clone();
    request["operation"] = json!("quote");
    let quote = crate::quote(&request)?;
    let wallet = key(v, "wallet")?;
    let pool_address = key(v, "pool")?;
    let token = Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")?;
    let ata_program = Pubkey::from_str("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")?;
    let protocol = v["protocol"].as_str().context("Protocol required")?;
    let sell = v["base_for_quote"]
        .as_bool()
        .context("Direction required")?;
    let mode = match v["mode"].as_str() {
        Some("exact_in") => 0,
        Some("partial_fill") => 1,
        Some("exact_out") => 2,
        _ => anyhow::bail!("Unsupported swap mode"),
    };
    let slippage = v["slippage_bps"].as_u64().context("Slippage required")?;
    ensure!((1..=1000).contains(&slippage), "Invalid slippage");
    let output = crate::number(&quote, "output")?;
    let input = crate::number(&quote, "input")?;
    let bound = if mode == 2 {
        (u128::from(input) * (10000 + u128::from(slippage))).div_ceil(10000)
    } else {
        u128::from(output) * (10000 - u128::from(slippage)) / 10000
    };
    let bound = u64::try_from(bound)?;
    ensure!(bound > 0, "Slippage bound rounds to zero");
    let amount = crate::number(v, "amount")?;
    let (a, b, swap) = if protocol == "dbc" {
        let pool = crate::decode::<dynamic_bonding_curve::state::VirtualPool>(&crate::bytes(
            v,
            "pool_data",
        )?)?;
        let cfg = crate::decode::<dynamic_bonding_curve::state::PoolConfig>(&crate::bytes(
            v,
            "config_data",
        )?)?;
        let a = pool.pool_state.base_mint;
        let b = cfg.quote_mint;
        let (input_mint, output_mint) = if sell { (a, b) } else { (b, a) };
        let event_authority =
            Pubkey::find_program_address(&[b"__event_authority"], &dynamic_bonding_curve::ID).0;
        let accounts = dynamic_bonding_curve::accounts::SwapCtx {
            pool_authority: dynamic_bonding_curve::const_pda::pool_authority::ID,
            config: pool.pool_state.config,
            pool: pool_address,
            input_token_account: ata(wallet, input_mint, token, ata_program),
            output_token_account: ata(wallet, output_mint, token, ata_program),
            base_vault: pool.pool_state.base_vault,
            quote_vault: pool.pool_state.quote_vault,
            base_mint: a,
            quote_mint: b,
            payer: wallet,
            token_base_program: token,
            token_quote_program: token,
            referral_token_account: None,
            event_authority,
            program: dynamic_bonding_curve::ID,
        }
        .to_account_metas(None);
        let data = dynamic_bonding_curve::instruction::Swap2 {
            params: dynamic_bonding_curve::SwapParameters2 {
                amount_0: amount,
                amount_1: bound,
                swap_mode: mode,
            },
        }
        .data();
        (a, b, ix(dynamic_bonding_curve::ID, accounts, data))
    } else {
        ensure!(protocol == "damm_v2", "Unsupported protocol");
        let pool = crate::decode::<cp_amm::state::Pool>(&crate::bytes(v, "pool_data")?)?;
        let a = pool.token_a_mint;
        let b = pool.token_b_mint;
        let (input_mint, output_mint) = if sell { (a, b) } else { (b, a) };
        let event_authority = Pubkey::find_program_address(&[b"__event_authority"], &cp_amm::ID).0;
        let accounts = cp_amm::accounts::SwapCtx {
            pool_authority: cp_amm::const_pda::pool_authority::ID,
            pool: pool_address,
            input_token_account: ata(wallet, input_mint, token, ata_program),
            output_token_account: ata(wallet, output_mint, token, ata_program),
            token_a_vault: pool.token_a_vault,
            token_b_vault: pool.token_b_vault,
            token_a_mint: a,
            token_b_mint: b,
            payer: wallet,
            token_a_program: token,
            token_b_program: token,
            referral_token_account: None,
            event_authority,
            program: cp_amm::ID,
        }
        .to_account_metas(None);
        let data = cp_amm::instruction::Swap2 {
            _params: cp_amm::SwapParameters2 {
                amount_0: amount,
                amount_1: bound,
                swap_mode: mode,
            },
        }
        .data();
        (a, b, ix(cp_amm::ID, accounts, data))
    };
    let mut instructions = vec![];
    for mint in [a, b] {
        instructions.push(json!({"program_id":ata_program.to_string(),"accounts":[{"address":wallet.to_string(),"signer":true,"writable":true},{"address":ata(wallet,mint,token,ata_program).to_string(),"signer":false,"writable":true},{"address":wallet.to_string(),"signer":false,"writable":false},{"address":mint.to_string(),"signer":false,"writable":false},{"address":Pubkey::default().to_string(),"signer":false,"writable":false},{"address":token.to_string(),"signer":false,"writable":false}],"data":STANDARD.encode([1u8])}));
    }
    // Existing token balances are used; output WSOL remains in the user's ATA.
    instructions.push(swap);
    Ok(
        json!({"instructions":instructions,"quote":quote,"base_mint":a.to_string(),"quote_mint":b.to_string(),"slippage_bound":bound.to_string(),"native_sol_wrapping":false}),
    )
}
