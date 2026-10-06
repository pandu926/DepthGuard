use crate::decode;
use anchor_lang::{
    AnchorDeserialize, Discriminator, InstructionData, ToAccountMetas, prelude::Pubkey,
};
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::str::FromStr;
fn key(v: &Value, name: &str) -> Result<Pubkey> {
    Pubkey::from_str(v[name].as_str().context("Missing public key")?).context("Invalid public key")
}
fn data(v: &Value) -> Result<Vec<u8>> {
    Ok(STANDARD.decode(v["vault_data"].as_str().context("Vault data required")?)?)
}
pub fn describe(v: &Value) -> Result<Value> {
    let vault = decode::<dynamic_fee_sharing::state::FeeVault>(&data(v)?)?;
    let mut users = Vec::new();
    for (i, user) in vault.users.iter().enumerate() {
        if user.share == 0 {
            continue;
        }
        let mut trial = vault;
        let pending = trial.validate_and_claim_fee(i as u8, &user.address)?;
        users.push(json!({"wallet":user.address.to_string(),"share":user.share,"index":i,"claimed":user.fee_claimed.to_string(),"pending":pending.to_string()}));
    }
    Ok(
        json!({"owner":vault.owner.to_string(),"quote_mint":vault.token_mint.to_string(),"token_vault":vault.token_vault.to_string(),"base":vault.base.to_string(),"total_funded":vault.total_funded_fee.to_string(),"total_share":vault.total_share,"recipients":users}),
    )
}
pub fn claim(v: &Value) -> Result<Value> {
    let mut vault = decode::<dynamic_fee_sharing::state::FeeVault>(&data(v)?)?;
    ensure!(vault.token_flag == 0, "Only SPL quote claims are supported");
    let user = key(v, "wallet")?;
    let index = vault
        .users
        .iter()
        .position(|u| u.address == user && u.share > 0)
        .context("Wallet is not a recipient")?;
    let pending = vault.validate_and_claim_fee(index as u8, &user)?;
    ensure!(pending > 0, "No claimable fee");
    let address = key(v, "vault")?;
    let token_program = Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")?;
    let ata_program = Pubkey::from_str("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")?;
    let (receiver, _) = Pubkey::find_program_address(
        &[
            user.as_ref(),
            token_program.as_ref(),
            vault.token_mint.as_ref(),
        ],
        &ata_program,
    );
    let (authority, _) =
        Pubkey::find_program_address(&[b"fee_vault_authority"], &dynamic_fee_sharing::ID);
    let (event_authority, _) =
        Pubkey::find_program_address(&[b"__event_authority"], &dynamic_fee_sharing::ID);
    let accounts = dynamic_fee_sharing::accounts::ClaimFeeCtx {
        fee_vault: address,
        fee_vault_authority: authority,
        token_vault: vault.token_vault,
        token_mint: vault.token_mint,
        user_token_vault: receiver,
        user,
        token_program,
        event_authority,
        program: dynamic_fee_sharing::ID,
    }
    .to_account_metas(None);
    let bytes = dynamic_fee_sharing::instruction::ClaimFee { index: index as u8 }.data();
    Ok(
        json!({"program_id":dynamic_fee_sharing::ID.to_string(),"accounts":accounts.iter().map(|a|json!({"address":a.pubkey.to_string(),"signer":a.is_signer,"writable":a.is_writable})).collect::<Vec<_>>(),"data":STANDARD.encode(bytes),"pending":pending.to_string(),"receiver":receiver.to_string(),"quote_mint":vault.token_mint.to_string(),"vault":address.to_string()}),
    )
}
pub fn decode_event(v: &Value) -> Result<Value> {
    let bytes = STANDARD.decode(v["data"].as_str().context("Event data required")?)?;
    ensure!(bytes.len() >= 16, "Incomplete event");
    ensure!(
        &bytes[..8] == anchor_lang::event::EVENT_IX_TAG_LE,
        "Not an Anchor CPI event"
    );
    let discriminator = &bytes[8..16];
    if discriminator == dynamic_fee_sharing::event::EvtClaimFee::DISCRIMINATOR {
        let event = dynamic_fee_sharing::event::EvtClaimFee::try_from_slice(&bytes[16..])?;
        return Ok(
            json!({"kind":"claim","vault":event.fee_vault.to_string(),"recipient":event.user.to_string(),"amount":event.claimed_fee.to_string(),"index":event.index}),
        );
    }
    if discriminator == dynamic_fee_sharing::event::EvtFundFee::DISCRIMINATOR {
        let event = dynamic_fee_sharing::event::EvtFundFee::try_from_slice(&bytes[16..])?;
        let trading_fee_source = (event.source_program == dynamic_bonding_curve::ID
            && (event
                .payload
                .starts_with(dynamic_bonding_curve::instruction::ClaimTradingFee::DISCRIMINATOR)
                || event.payload.starts_with(
                    dynamic_bonding_curve::instruction::ClaimTradingFee2::DISCRIMINATOR,
                )))
            || (event.source_program == cp_amm::ID
                && event
                    .payload
                    .starts_with(cp_amm::instruction::ClaimPositionFee::DISCRIMINATOR));
        return Ok(
            json!({"kind":"funding","vault":event.fee_vault.to_string(),"amount":event.funded_amount.to_string(),"source_program":event.source_program.to_string(),"trading_fee_source":trading_fee_source}),
        );
    }
    Ok(json!({"kind":"untracked","discriminator":STANDARD.encode(discriminator)}))
}

pub fn create(v: &Value) -> Result<Value> {
    let base = key(v, "base")?;
    let payer = key(v, "wallet")?;
    let mint = key(v, "quote_mint")?;
    let recipients = v["recipients"].as_array().context("Recipients required")?;
    ensure!(
        (2..=5).contains(&recipients.len()),
        "DFS requires two to five unique recipients"
    );
    let mut seen = std::collections::BTreeSet::new();
    let mut total = 0u64;
    let mut users = Vec::new();
    for recipient in recipients {
        let address = key(recipient, "wallet")?;
        let share = u32::try_from(
            recipient["share"]
                .as_u64()
                .context("Positive share required")?,
        )?;
        ensure!(
            share > 0 && address != Pubkey::default() && seen.insert(address.to_bytes()),
            "Invalid or duplicate recipient"
        );
        total = total.checked_add(share.into()).context("Share overflow")?;
        users.push(dynamic_fee_sharing::UserShare { address, share });
    }
    ensure!(
        total == 10_000,
        "Platform fee shares must total 10000 basis points"
    );
    let token_program = Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")?;
    let (vault, _) = Pubkey::find_program_address(
        &[b"fee_vault", base.as_ref(), mint.as_ref()],
        &dynamic_fee_sharing::ID,
    );
    let (token_vault, _) =
        Pubkey::find_program_address(&[b"token_vault", vault.as_ref()], &dynamic_fee_sharing::ID);
    let (authority, _) =
        Pubkey::find_program_address(&[b"fee_vault_authority"], &dynamic_fee_sharing::ID);
    let (event_authority, _) =
        Pubkey::find_program_address(&[b"__event_authority"], &dynamic_fee_sharing::ID);
    let accounts = dynamic_fee_sharing::accounts::InitializeFeeVaultPdaCtx {
        fee_vault: vault,
        fee_vault_authority: authority,
        token_vault,
        token_mint: mint,
        owner: payer,
        base,
        payer,
        token_program,
        system_program: Pubkey::default(),
        event_authority,
        program: dynamic_fee_sharing::ID,
    }
    .to_account_metas(None);
    let bytes = dynamic_fee_sharing::instruction::InitializeFeeVaultPda {
        params: dynamic_fee_sharing::InitializeFeeVaultParameters {
            padding: [0; 8],
            users,
        },
    }
    .data();
    Ok(
        json!({"program_id":dynamic_fee_sharing::ID.to_string(),"accounts":accounts.iter().map(|a|json!({"address":a.pubkey.to_string(),"signer":a.is_signer,"writable":a.is_writable})).collect::<Vec<_>>(),"data":STANDARD.encode(bytes),"vault":vault.to_string(),"token_vault":token_vault.to_string()}),
    )
}
pub fn fund(v: &Value) -> Result<Value> {
    let vault = decode::<dynamic_fee_sharing::state::FeeVault>(&data(v)?)?;
    let vault_address = key(v, "vault")?;
    let signer = key(v, "wallet")?;
    ensure!(
        vault.is_share_holder(&signer),
        "Funder must be a registered shareholder"
    );
    let source = &v["source_instruction"];
    let program = key(source, "program_id")?;
    let payload = STANDARD.decode(
        source["data"]
            .as_str()
            .context("Source instruction data required")?,
    )?;
    ensure!(payload.len() >= 8, "Incomplete fee claim instruction");
    // Migration withdrawals and surplus are deliberately excluded from trading-fee royalties.
    let dbc_claim = program == dynamic_bonding_curve::ID
        && [
            dynamic_bonding_curve::instruction::ClaimTradingFee::DISCRIMINATOR,
            dynamic_bonding_curve::instruction::ClaimTradingFee2::DISCRIMINATOR,
        ]
        .contains(&&payload[..8]);
    let damm_claim = program == cp_amm::ID
        && &payload[..8] == cp_amm::instruction::ClaimPositionFee::DISCRIMINATOR;
    ensure!(
        dbc_claim || damm_claim,
        "Only native trading-fee claims can fund platform royalties"
    );
    let remaining = source["accounts"]
        .as_array()
        .context("Source accounts required")?;
    ensure!(
        remaining.get(4).and_then(|a| a["address"].as_str())
            == Some(vault.token_vault.to_string().as_str()),
        "Quote fee receiver must be the native token vault"
    );
    let (event_authority, _) =
        Pubkey::find_program_address(&[b"__event_authority"], &dynamic_fee_sharing::ID);
    let mut accounts = dynamic_fee_sharing::accounts::FundByClaimingFeeCtx {
        fee_vault: vault_address,
        token_vault: vault.token_vault,
        signer,
        source_program: program,
        event_authority,
        program: dynamic_fee_sharing::ID,
    }
    .to_account_metas(None);
    for a in remaining {
        let pubkey = key(a, "address")?;
        ensure!(
            !a["signer"].as_bool().unwrap_or(false) || pubkey == vault_address,
            "Source signer must be the native fee vault"
        );
        accounts.push(anchor_lang::solana_program::instruction::AccountMeta {
            pubkey,
            is_signer: false,
            is_writable: a["writable"].as_bool().unwrap_or(false),
        });
    }
    let bytes = dynamic_fee_sharing::instruction::FundByClaimingFee { payload }.data();
    Ok(
        json!({"program_id":dynamic_fee_sharing::ID.to_string(),"accounts":accounts.iter().map(|a|json!({"address":a.pubkey.to_string(),"signer":a.is_signer,"writable":a.is_writable})).collect::<Vec<_>>(),"data":STANDARD.encode(bytes)}),
    )
}

/// Sweep only trading fees into DFS; migration allocations and liquidity principal have no builder.
pub fn sweep(v: &Value) -> Result<Value> {
    let vault_address = key(v, "vault")?;
    let wallet = key(v, "wallet")?;
    let description = describe(v)?;
    let quote = key(&description, "quote_mint")?;
    let token_vault = key(&description, "token_vault")?;
    let token = Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")?;
    let ata_program = Pubkey::from_str("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")?;
    let pool_address = key(v, "pool")?;
    let (base, program, accounts, data) = if v["protocol"] == "dbc" {
        let pool = decode::<dynamic_bonding_curve::state::VirtualPool>(
            &STANDARD.decode(v["pool_data"].as_str().context("Pool data required")?)?,
        )?;
        let config = decode::<dynamic_bonding_curve::state::PoolConfig>(
            &STANDARD.decode(v["config_data"].as_str().context("Config data required")?)?,
        )?;
        ensure!(
            config.fee_claimer == vault_address
                && config.quote_mint == quote
                && config.collect_fee_mode == 0,
            "Unsupported DBC fee authority or mode"
        );
        let base = pool.pool_state.base_mint;
        let base_account = Pubkey::find_program_address(
            &[vault_address.as_ref(), token.as_ref(), base.as_ref()],
            &ata_program,
        )
        .0;
        let event_authority =
            Pubkey::find_program_address(&[b"__event_authority"], &dynamic_bonding_curve::ID).0;
        let accounts = dynamic_bonding_curve::accounts::ClaimTradingFeesCtx {
            pool_authority: dynamic_bonding_curve::const_pda::pool_authority::ID,
            config: pool.pool_state.config,
            pool: pool_address,
            token_a_account: base_account,
            token_b_account: token_vault,
            base_vault: pool.pool_state.base_vault,
            quote_vault: pool.pool_state.quote_vault,
            base_mint: base,
            quote_mint: quote,
            fee_claimer: vault_address,
            token_base_program: token,
            token_quote_program: token,
            event_authority,
            program: dynamic_bonding_curve::ID,
        }
        .to_account_metas(None);
        (
            base,
            dynamic_bonding_curve::ID,
            accounts,
            dynamic_bonding_curve::instruction::ClaimTradingFee {
                max_amount_a: 0,
                max_amount_b: u64::MAX,
            }
            .data(),
        )
    } else {
        ensure!(v["protocol"] == "damm_v2", "Unsupported sweep protocol");
        let pool = decode::<cp_amm::state::Pool>(
            &STANDARD.decode(v["pool_data"].as_str().context("Pool data required")?)?,
        )?;
        ensure!(
            pool.token_b_mint == quote
                && pool.token_a_flag == 0
                && pool.token_b_flag == 0
                && pool.collect_fee_mode != 0,
            "Only quote-fee DAMM pools are supported"
        );
        let base = pool.token_a_mint;
        let base_account = Pubkey::find_program_address(
            &[vault_address.as_ref(), token.as_ref(), base.as_ref()],
            &ata_program,
        )
        .0;
        let event_authority = Pubkey::find_program_address(&[b"__event_authority"], &cp_amm::ID).0;
        let accounts = cp_amm::accounts::ClaimPositionFeeCtx {
            pool_authority: cp_amm::const_pda::pool_authority::ID,
            pool: pool_address,
            position: key(v, "position")?,
            token_a_account: base_account,
            token_b_account: token_vault,
            token_a_vault: pool.token_a_vault,
            token_b_vault: pool.token_b_vault,
            token_a_mint: base,
            token_b_mint: quote,
            position_nft_account: key(v, "position_nft_account")?,
            signer: vault_address,
            token_a_program: token,
            token_b_program: token,
            event_authority,
            program: cp_amm::ID,
        }
        .to_account_metas(None);
        (
            base,
            cp_amm::ID,
            accounts,
            cp_amm::instruction::ClaimPositionFee {}.data(),
        )
    };
    let source = json!({"program_id":program.to_string(),"accounts":accounts.iter().map(|a|json!({"address":a.pubkey.to_string(),"signer":a.is_signer,"writable":a.is_writable})).collect::<Vec<_>>(),"data":STANDARD.encode(data)});
    let mut fund_input = v.clone();
    fund_input["source_instruction"] = source;
    let funded = fund(&fund_input)?;
    let base_ata = Pubkey::find_program_address(
        &[vault_address.as_ref(), token.as_ref(), base.as_ref()],
        &ata_program,
    )
    .0;
    let create = json!({"program_id":ata_program.to_string(),"accounts":[{"address":wallet.to_string(),"signer":true,"writable":true},{"address":base_ata.to_string(),"signer":false,"writable":true},{"address":vault_address.to_string(),"signer":false,"writable":false},{"address":base.to_string(),"signer":false,"writable":false},{"address":Pubkey::default().to_string(),"signer":false,"writable":false},{"address":token.to_string(),"signer":false,"writable":false}],"data":STANDARD.encode([1u8])});
    Ok(
        json!({"instructions":[create,funded],"basis":"native_claimed_trading_fees_only","quote_mint":quote.to_string()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn funding_event_distinguishes_trading_fees_from_donations() {
        use anchor_lang::AnchorSerialize;
        for (source_program, payload, expected) in [
            (
                dynamic_bonding_curve::ID,
                dynamic_bonding_curve::instruction::ClaimTradingFee {
                    max_amount_a: 0,
                    max_amount_b: 1,
                }
                .data(),
                true,
            ),
            (
                cp_amm::ID,
                cp_amm::instruction::ClaimPositionFee {}.data(),
                true,
            ),
            (Pubkey::default(), Vec::new(), false),
            (dynamic_bonding_curve::ID, Vec::new(), false),
        ] {
            let event = dynamic_fee_sharing::event::EvtFundFee {
                source_program,
                fee_vault: Pubkey::new_unique(),
                funded_amount: 10,
                fee_per_share: 0,
                payload,
            };
            let mut bytes = anchor_lang::event::EVENT_IX_TAG_LE.to_vec();
            bytes.extend_from_slice(dynamic_fee_sharing::event::EvtFundFee::DISCRIMINATOR);
            event.serialize(&mut bytes).unwrap();
            let decoded = decode_event(&json!({"data":STANDARD.encode(bytes)})).unwrap();
            assert_eq!(decoded["trading_fee_source"], expected);
        }
    }
    #[test]
    fn native_dfs_accrual_and_claim_replay() {
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        let c = Pubkey::new_unique();
        let mut vault = dynamic_fee_sharing::state::FeeVault::default();
        vault
            .initialize(
                &a,
                0,
                &Pubkey::new_unique(),
                &Pubkey::new_unique(),
                &Pubkey::new_unique(),
                0,
                1,
                &[
                    dynamic_fee_sharing::UserShare {
                        address: a,
                        share: 8000,
                    },
                    dynamic_fee_sharing::UserShare {
                        address: b,
                        share: 1000,
                    },
                    dynamic_fee_sharing::UserShare {
                        address: c,
                        share: 1000,
                    },
                ],
            )
            .unwrap();
        vault.fund_fee(80000000).unwrap();
        assert_eq!(vault.validate_and_claim_fee(1, &b).unwrap(), 8000000);
        assert_eq!(vault.validate_and_claim_fee(1, &b).unwrap(), 0);
        assert!(vault.validate_and_claim_fee(0, &b).is_err());
        assert_eq!(vault.validate_and_claim_fee(0, &a).unwrap(), 64000000);
        assert_eq!(vault.validate_and_claim_fee(2, &c).unwrap(), 8000000);
    }
}
