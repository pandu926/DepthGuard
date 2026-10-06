use anchor_lang::{AnchorDeserialize, InstructionData, ToAccountMetas, prelude::Pubkey};
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::str::FromStr;
fn key(v: &Value, name: &str) -> Result<Pubkey> {
    Pubkey::from_str(v[name].as_str().context("Missing launch public key")?)
        .context("Invalid launch public key")
}
fn instruction(
    accounts: Vec<anchor_lang::solana_program::instruction::AccountMeta>,
    data: Vec<u8>,
) -> Value {
    json!({"program_id":dynamic_bonding_curve::ID.to_string(),"accounts":accounts.iter().map(|a|json!({"address":a.pubkey.to_string(),"writable":a.is_writable,"signer":a.is_signer})).collect::<Vec<_>>(),"data":STANDARD.encode(data)})
}
pub fn config(v: &Value) -> Result<Value> {
    let bytes = depthguard_domain::native::encode("dbc", "ConfigParameters", &v["parameters"])
        .map_err(anyhow::Error::msg)?;
    let config_parameters = dynamic_bonding_curve::ConfigParameters::try_from_slice(&bytes)?;
    let (event_authority, _) =
        Pubkey::find_program_address(&[b"__event_authority"], &dynamic_bonding_curve::ID);
    let accounts = dynamic_bonding_curve::accounts::CreateConfigCtx {
        config: key(v, "config")?,
        fee_claimer: key(v, "fee_vault")?,
        leftover_receiver: key(v, "wallet")?,
        quote_mint: key(v, "quote_mint")?,
        payer: key(v, "wallet")?,
        system_program: Pubkey::default(),
        event_authority,
        program: dynamic_bonding_curve::ID,
    }
    .to_account_metas(None);
    Ok(instruction(
        accounts,
        dynamic_bonding_curve::instruction::CreateConfig { config_parameters }.data(),
    ))
}
pub fn pool(v: &Value) -> Result<Value> {
    let config = key(v, "config")?;
    let creator = key(v, "wallet")?;
    let base = key(v, "base_mint")?;
    let quote = key(v, "quote_mint")?;
    let (high, low) = if base.to_bytes() > quote.to_bytes() {
        (base, quote)
    } else {
        (quote, base)
    };
    let (pool, _) = Pubkey::find_program_address(
        &[b"pool", config.as_ref(), high.as_ref(), low.as_ref()],
        &dynamic_bonding_curve::ID,
    );
    let (base_vault, _) = Pubkey::find_program_address(
        &[b"token_vault", base.as_ref(), pool.as_ref()],
        &dynamic_bonding_curve::ID,
    );
    let (quote_vault, _) = Pubkey::find_program_address(
        &[b"token_vault", quote.as_ref(), pool.as_ref()],
        &dynamic_bonding_curve::ID,
    );
    let metadata_program = Pubkey::from_str("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s")?;
    let (mint_metadata, _) = Pubkey::find_program_address(
        &[b"metadata", metadata_program.as_ref(), base.as_ref()],
        &metadata_program,
    );
    let (event_authority, _) =
        Pubkey::find_program_address(&[b"__event_authority"], &dynamic_bonding_curve::ID);
    let token = Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")?;
    let name = v["name"]
        .as_str()
        .context("Token name required")?
        .to_owned();
    let symbol = v["symbol"].as_str().context("Symbol required")?.to_owned();
    let uri = v["uri"].as_str().context("URI required")?.to_owned();
    ensure!(
        !name.is_empty()
            && name.len() <= 32
            && !symbol.is_empty()
            && symbol.len() <= 10
            && uri.len() <= 200,
        "Invalid metadata length"
    );
    let accounts = dynamic_bonding_curve::accounts::InitializeVirtualPoolWithSplTokenCtx {
        config,
        pool_authority: dynamic_bonding_curve::const_pda::pool_authority::ID,
        creator,
        base_mint: base,
        quote_mint: quote,
        pool,
        base_vault,
        quote_vault,
        mint_metadata,
        metadata_program,
        payer: creator,
        token_quote_program: token,
        token_program: token,
        system_program: Pubkey::default(),
        event_authority,
        program: dynamic_bonding_curve::ID,
    }
    .to_account_metas(None);
    let mut ix = instruction(
        accounts,
        dynamic_bonding_curve::instruction::InitializeVirtualPoolWithSplToken {
            params: dynamic_bonding_curve::InitializePoolParameters { name, symbol, uri },
        }
        .data(),
    );
    ix["pool"] = json!(pool.to_string());
    ix["base_vault"] = json!(base_vault.to_string());
    ix["quote_vault"] = json!(quote_vault.to_string());
    Ok(ix)
}

#[allow(deprecated)]
pub fn migrate(v: &Value) -> Result<Value> {
    let config = key(v, "config")?;
    let base = key(v, "base_mint")?;
    let quote = key(v, "quote_mint")?;
    let payer = key(v, "wallet")?;
    let damm_config = key(v, "damm_config")?;
    let first = key(v, "first_position_mint")?;
    let second = key(v, "second_position_mint")?;
    let (high, low) = if base.to_bytes() > quote.to_bytes() {
        (base, quote)
    } else {
        (quote, base)
    };
    let pda = |program: Pubkey, seeds: &[&[u8]]| Pubkey::find_program_address(seeds, &program).0;
    let virtual_pool = pda(
        dynamic_bonding_curve::ID,
        &[b"pool", config.as_ref(), high.as_ref(), low.as_ref()],
    );
    let pool = pda(
        cp_amm::ID,
        &[b"pool", damm_config.as_ref(), high.as_ref(), low.as_ref()],
    );
    let token = Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")?;
    let token2022 = Pubkey::from_str("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")?;
    let mut accounts = dynamic_bonding_curve::accounts::MigrateDammV2Ctx {
        virtual_pool,
        migration_metadata: pda(
            dynamic_bonding_curve::ID,
            &[b"damm_v2", virtual_pool.as_ref()],
        ),
        config,
        pool_authority: dynamic_bonding_curve::const_pda::pool_authority::ID,
        pool,
        first_position_nft_mint: first,
        first_position_nft_account: pda(cp_amm::ID, &[b"position_nft_account", first.as_ref()]),
        first_position: pda(cp_amm::ID, &[b"position", first.as_ref()]),
        second_position_nft_mint: Some(second),
        second_position_nft_account: Some(pda(
            cp_amm::ID,
            &[b"position_nft_account", second.as_ref()],
        )),
        second_position: Some(pda(cp_amm::ID, &[b"position", second.as_ref()])),
        damm_pool_authority: pda(cp_amm::ID, &[b"pool_authority"]),
        amm_program: cp_amm::ID,
        base_mint: base,
        quote_mint: quote,
        token_a_vault: pda(cp_amm::ID, &[b"token_vault", base.as_ref(), pool.as_ref()]),
        token_b_vault: pda(cp_amm::ID, &[b"token_vault", quote.as_ref(), pool.as_ref()]),
        base_vault: pda(
            dynamic_bonding_curve::ID,
            &[b"token_vault", base.as_ref(), virtual_pool.as_ref()],
        ),
        quote_vault: pda(
            dynamic_bonding_curve::ID,
            &[b"token_vault", quote.as_ref(), virtual_pool.as_ref()],
        ),
        payer,
        token_base_program: token,
        token_quote_program: token,
        token_2022_program: token2022,
        damm_event_authority: pda(cp_amm::ID, &[b"__event_authority"]),
        system_program: Pubkey::default(),
    }
    .to_account_metas(None);
    accounts.push(
        anchor_lang::solana_program::instruction::AccountMeta::new_readonly(damm_config, false),
    );
    let mut ix = instruction(
        accounts,
        dynamic_bonding_curve::instruction::MigrationDammV2 {}.data(),
    );
    ix["damm_pool"] = json!(pool.to_string());
    Ok(ix)
}

pub fn verify(v: &Value) -> Result<Value> {
    let phase = v["step"].as_str().context("Workflow step required")?;
    let vault = key(v, "fee_vault")?;
    let quote = key(v, "quote_mint")?;
    let wallet = key(v, "wallet")?;
    if phase == "fee_vault" {
        let description = crate::fees::describe(v)?;
        ensure!(
            description["owner"] == wallet.to_string()
                && description["quote_mint"] == quote.to_string()
                && description["base"] == v["config"],
            "Fee vault ownership or mint mismatch"
        );
        let expected = v["recipients"]
            .as_array()
            .context("Expected recipients missing")?;
        let observed = description["recipients"]
            .as_array()
            .context("Native recipients missing")?;
        ensure!(
            expected.len() == observed.len(),
            "Native royalty recipient count mismatch"
        );
        for recipient in expected {
            ensure!(observed.iter().any(|r|r["wallet"]==recipient["wallet"]&&r["share"]==recipient["share"]),"Native royalty policy mismatch");
        }
        return Ok(
            json!({"verified":true,"step":phase,"native_fee_policy_verified":true,"state":description}),
        );
    }
    let config_bytes =
        STANDARD.decode(v["config_data"].as_str().context("Config state missing")?)?;
    let config = crate::decode::<dynamic_bonding_curve::state::PoolConfig>(&config_bytes)?;
    let expected = &v["parameters"];
    ensure!(
        config.fee_claimer == vault
            && config.quote_mint == quote
            && config.leftover_receiver == wallet,
        "Config fee authority or recipients mismatch"
    );
    ensure!(
        config.collect_fee_mode == 0
            && config.creator_trading_fee_percentage == 0
            && config.partner_permanent_locked_liquidity_percentage == 100
            && config.partner_liquidity_percentage == 0
            && config.creator_liquidity_percentage == 0
            && config.creator_permanent_locked_liquidity_percentage == 0,
        "Config bypasses the controlled native fee stream"
    );
    ensure!(
        config.migration_option == 1
            && config.token_type == 0
            && config.token_update_authority == 1,
        "Unsupported migration or token authority"
    );
    let raw = |key: &str| -> Result<u128> {
        expected[key]
            .as_str()
            .context("Missing expected native amount")?
            .parse()
            .context("Invalid expected native amount")
    };
    ensure!(
        config.sqrt_start_price == raw("sqrt_start_price")?
            && u128::from(config.migration_quote_threshold) == raw("migration_quote_threshold")?,
        "Curve start or graduation threshold mismatch"
    );
    for (i, segment) in expected["curve"]
        .as_array()
        .context("Expected curve missing")?
        .iter()
        .enumerate()
    {
        ensure!(
            config.curve[i].sqrt_price
                == segment["sqrt_price"]
                    .as_str()
                    .context("Curve price missing")?
                    .parse::<u128>()?
                && config.curve[i].liquidity
                    == segment["liquidity"]
                        .as_str()
                        .context("Curve liquidity missing")?
                        .parse::<u128>()?,
            "Native curve differs from the published model"
        );
    }
    ensure!(
        config.migrated_pool_fee_bps
            == expected["migrated_pool_fee"]["pool_fee_bps"]
                .as_u64()
                .context("Migrated fee missing")? as u16
            && config.migrated_compounding_fee_bps
                == expected["compounding_fee_bps"]
                    .as_u64()
                    .context("Compounding share missing")? as u16,
        "Migrated fee policy mismatch"
    );
    if phase == "config" {
        return Ok(
            json!({"verified":true,"step":phase,"native_fee_authority_verified":true,"migration_sqrt_price":config.migration_sqrt_price.to_string()}),
        );
    }
    let pool_bytes = STANDARD.decode(v["pool_data"].as_str().context("Pool state missing")?)?;
    let pool = crate::decode::<dynamic_bonding_curve::state::VirtualPool>(&pool_bytes)?;
    ensure!(
        pool.pool_state.config == key(v, "config")?
            && pool.pool_state.base_mint == key(v, "base_mint")?
            && pool.pool_state.creator == wallet,
        "Pool identity or creator mismatch"
    );
    if phase == "pool" {
        return Ok(
            json!({"verified":true,"step":phase,"pool_config_verified":true,"sqrt_price":pool.pool_state.sqrt_price.to_string()}),
        );
    }
    ensure!(
        phase == "migration" && pool.pool_state.is_migrated == 1,
        "Migration not complete"
    );
    let bytes = STANDARD.decode(v["damm_data"].as_str().context("DAMM state missing")?)?;
    let damm = crate::decode::<cp_amm::state::Pool>(&bytes)?;
    ensure!(
        damm.token_a_mint == key(v, "base_mint")? && damm.token_b_mint == quote,
        "Migrated pool pair mismatch"
    );
    let position_bytes = STANDARD.decode(
        v["position_data"]
            .as_str()
            .context("Position state missing")?,
    )?;
    let position = crate::decode::<cp_amm::state::Position>(&position_bytes)?;
    ensure!(
        position.pool == key(v, "damm_pool")?
            && position.nft_mint == key(v, "first_position_mint")?
            && position.unlocked_liquidity == 0
            && position.vested_liquidity == 0
            && position.permanent_locked_liquidity > 0,
        "LP lock or position identity mismatch"
    );
    let nft = STANDARD.decode(
        v["position_nft_data"]
            .as_str()
            .context("Position NFT account missing")?,
    )?;
    ensure!(
        nft.len() >= 72
            && nft[32..64] == vault.to_bytes()
            && u64::from_le_bytes(nft[64..72].try_into()?) == 1,
        "Migrated position is not controlled by the native fee vault"
    );
    if config.migrated_compounding_fee_bps > 0 {
        ensure!(
            damm.sqrt_min_price == 0 && damm.sqrt_max_price == u128::MAX,
            "Compounding pool range mismatch"
        );
    } else {
        ensure!(
            damm.sqrt_min_price == 4295048016
                && damm.sqrt_max_price == 79226673521066979257578248091,
            "Concentrated pool range mismatch"
        );
    }
    Ok(
        json!({"verified":true,"step":phase,"native_fee_authority_verified":true,"permanent_lock_verified":true,"expected_initial_sqrt_price":config.migration_sqrt_price.to_string(),"observed_current_sqrt_price":damm.sqrt_price.to_string(),"initial_price_reconstructed":false,"position_liquidity":position.permanent_locked_liquidity.to_string()}),
    )
}
