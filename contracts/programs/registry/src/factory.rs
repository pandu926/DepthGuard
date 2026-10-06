use super::*;
use dynamic_bonding_curve as dbc;
use dynamic_fee_sharing as dfs;
fn native<T: bytemuck::Pod + anchor_lang::Discriminator>(
    a: &AccountInfo,
    owner: Pubkey,
) -> Result<T> {
    require_keys_eq!(*a.owner, owner, EconomyError::InvalidTerms);
    let data = a.try_borrow_data()?;
    require!(
        data.len() == 8 + core::mem::size_of::<T>() && &data[..8] == T::DISCRIMINATOR,
        EconomyError::InvalidTerms
    );
    bytemuck::try_pod_read_unaligned(&data[8..]).map_err(|_| error!(EconomyError::InvalidTerms))
}
pub fn validate_profile(spec: &ModelSpec) -> Result<dbc::ConfigParameters> {
    let p = dbc::ConfigParameters::try_from_slice(&spec.native_config)?;
    require!(
        p.token_type == 0
            && p.token_update_authority == 1
            && p.token_supply.is_some()
            && p.collect_fee_mode == 0
            && p.migration_option == 1
            && p.migration_fee_option == 6
            && p.activation_type == 1
            && p.partner_liquidity_percentage == 0
            && p.partner_permanent_locked_liquidity_percentage == 100
            && p.creator_liquidity_percentage == 0
            && p.creator_permanent_locked_liquidity_percentage == 0
            && p.creator_trading_fee_percentage == 0
            && p.pool_creation_fee == 0
            && p.pool_fees.dynamic_fee.is_none()
            && p.pool_fees.base_fee.first_factor == 0
            && p.pool_fees.base_fee.second_factor == 0
            && p.pool_fees.base_fee.third_factor == 0
            && p.pool_fees.base_fee.base_fee_mode == 0
            && !p.enable_first_swap_with_min_fee
            && p.compounding_fee_bps <= 10000
            && !p.curve.is_empty()
            && p.curve.len() <= 16,
        EconomyError::InvalidTerms
    );
    require!(
        (6..=9).contains(&p.token_decimal)
            && p.migration_quote_threshold > 0
            && (25..=1000).contains(&p.migrated_pool_fee.pool_fee_bps)
            && p.migrated_pool_fee.dynamic_fee == 0
            && p.migrated_pool_fee.collect_fee_mode
                == if p.compounding_fee_bps > 0 { 2 } else { 0 }
            && p.migrated_pool_base_fee_mode == 0,
        EconomyError::InvalidTerms
    );
    let supply = p.token_supply.as_ref().ok_or(EconomyError::InvalidTerms)?;
    require!(
        supply.pre_migration_token_supply > 0
            && supply.pre_migration_token_supply == supply.post_migration_token_supply,
        EconomyError::InvalidTerms
    );
    let mut previous = p.sqrt_start_price;
    require!(previous > 0, EconomyError::InvalidTerms);
    for point in &p.curve {
        require!(
            point.sqrt_price > previous && point.liquidity > 0,
            EconomyError::InvalidTerms
        );
        previous = point.sqrt_price;
    }
    // Vesting structures must be entirely zero; no hidden capital or rights path.
    require!(
        zero(&p.locked_vesting)?
            && zero(&p.partner_liquidity_vesting_info)?
            && zero(&p.creator_liquidity_vesting_info)?
            && zero(&p.migrated_pool_market_cap_fee_scheduler_params)?
            && p.padding == [0; 2],
        EconomyError::InvalidTerms
    );
    require!(
        p.pool_fees.base_fee.cliff_fee_numerator
            == u64::from(p.migrated_pool_fee.pool_fee_bps) * 100_000,
        EconomyError::InvalidTerms
    );
    let extended = spec.mechanism == FUNDING || spec.mechanism == BACKED;
    require!(
        if extended {
            p.migration_fee.fee_percentage > 0
                && p.migration_fee.fee_percentage <= 99
                && p.migration_fee.creator_fee_percentage == 100
        } else {
            p.migration_fee.fee_percentage == 0 && p.migration_fee.creator_fee_percentage == 0
        },
        EconomyError::InvalidTerms
    );
    Ok(p)
}
fn shares(
    model: &ModelVersion,
    l: &LaunchInstance,
    platform: &Platform,
) -> Result<Vec<(Pubkey, u16)>> {
    let s = ModelSpec::try_from_slice(&model.data)?;
    let mut out: Vec<(Pubkey, u16)> = Vec::new();
    for (key, bps) in [
        (l.launcher, s.launcher_bps),
        (model.author, s.author_bps),
        (platform.recipient, s.platform_bps),
    ] {
        if let Some(old) = out.iter_mut().find(|x| x.0 == key) {
            old.1 = old.1.checked_add(bps).ok_or(EconomyError::Overflow)?;
        } else {
            out.push((key, bps));
        }
    }
    require!(out.len() >= 2, EconomyError::InvalidTerms);
    Ok(out)
}
pub fn create_config_impl(ctx: Context<CreateConfig>) -> Result<()> {
    let l = &ctx.accounts.launch;
    require!(
        l.phase == 0 && ctx.accounts.model.sealed,
        EconomyError::InvalidState
    );
    let s = ModelSpec::try_from_slice(&ctx.accounts.model.data)?;
    let params = validate_profile(&s)?;
    require!(
        ctx.accounts.quote_mint.key() == anchor_spl::token::spl_token::native_mint::ID
            && ctx.accounts.quote_mint.decimals == s.quote_decimals,
        EconomyError::InvalidTerms
    );
    let vault = native::<dfs::state::FeeVault>(&ctx.accounts.fee_vault, dfs::ID)?;
    require!(
        vault.token_mint == ctx.accounts.quote_mint.key(),
        EconomyError::InvalidTerms
    );
    let expected = shares(&ctx.accounts.model, l, &ctx.accounts.platform)?;
    // Native DFS describes recipients in a fixed-size array; compare the active prefix.
    validate_dfs_recipients(&vault, &expected)?;
    dbc::cpi::create_config(
        CpiContext::new(
            ctx.accounts.dbc_program.key(),
            dbc::cpi::accounts::CreateConfigCtx {
                config: ctx.accounts.config.to_account_info(),
                fee_claimer: ctx.accounts.fee_vault.to_account_info(),
                leftover_receiver: ctx.accounts.launcher.to_account_info(),
                quote_mint: ctx.accounts.quote_mint.to_account_info(),
                payer: ctx.accounts.launcher.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                event_authority: ctx.accounts.event_authority.to_account_info(),
                program: ctx.accounts.dbc_program.to_account_info(),
            },
        ),
        params,
    )?;
    ctx.accounts.launch.quote_mint = ctx.accounts.quote_mint.key();
    ctx.accounts.launch.phase = 1;
    emit!(LaunchTransition {
        version: 1,
        launch: ctx.accounts.launch.key(),
        model: ctx.accounts.launch.model,
        previous: 0,
        next: 1,
        amount: 0
    });
    Ok(())
}
fn validate_dfs_recipients(v: &dfs::state::FeeVault, expected: &[(Pubkey, u16)]) -> Result<()> {
    require!(
        v.total_share == 10000 && v.token_flag == 0,
        EconomyError::InvalidTerms
    );
    for (i, (key, share)) in expected.iter().enumerate() {
        require!(
            v.users[i].address == *key && v.users[i].share == u32::from(*share),
            EconomyError::InvalidTerms
        );
    }
    for u in &v.users[expected.len()..] {
        require!(
            u.address == Pubkey::default() && u.share == 0,
            EconomyError::InvalidTerms
        );
    }
    Ok(())
}
pub fn create_pool_impl<'info>(
    ctx: Context<'info, CreatePool<'info>>,
    name: String,
    symbol: String,
    uri: String,
) -> Result<()> {
    let l = &ctx.accounts.launch;
    require!(
        l.phase == 1
            && !name.is_empty()
            && name.len() <= 32
            && !symbol.is_empty()
            && symbol.len() <= 10
            && uri.len() <= 200,
        EconomyError::InvalidTerms
    );
    let nonce = l.nonce.to_le_bytes();
    let bump = [l.bump];
    let seeds: &[&[u8]] = &[
        b"launch",
        l.model.as_ref(),
        l.launcher.as_ref(),
        &nonce,
        &bump,
    ];
    let a = dbc::cpi::accounts::InitializeVirtualPoolWithSplTokenCtx {
        config: ctx.accounts.config.to_account_info(),
        pool_authority: ctx.accounts.pool_authority.to_account_info(),
        creator: ctx.accounts.launch.to_account_info(),
        base_mint: ctx.accounts.base_mint.to_account_info(),
        quote_mint: ctx.accounts.quote_mint.to_account_info(),
        pool: ctx.accounts.pool.to_account_info(),
        base_vault: ctx.accounts.base_vault.to_account_info(),
        quote_vault: ctx.accounts.quote_vault.to_account_info(),
        mint_metadata: ctx.accounts.mint_metadata.to_account_info(),
        metadata_program: ctx.accounts.metadata_program.to_account_info(),
        payer: ctx.accounts.launcher.to_account_info(),
        token_quote_program: ctx.accounts.token_program.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
        event_authority: ctx.accounts.event_authority.to_account_info(),
        program: ctx.accounts.dbc_program.to_account_info(),
    };
    dbc::cpi::initialize_virtual_pool_with_spl_token(
        CpiContext::new_with_signer(ctx.accounts.dbc_program.key(), a, &[seeds]),
        dbc::InitializePoolParameters { name, symbol, uri },
    )?;
    ctx.accounts.launch.phase = 2;
    emit!(LaunchTransition {
        version: 1,
        launch: ctx.accounts.launch.key(),
        model: ctx.accounts.launch.model,
        previous: 1,
        next: 2,
        amount: 0
    });
    Ok(())
}
pub fn initialize_module_impl(ctx: Context<InitializeModule>) -> Result<()> {
    let l = &ctx.accounts.launch;
    require!(
        (l.phase == 2 || l.phase == 3)
            && !l.module_initialized
            && (l.mechanism == FUNDING || l.mechanism == BACKED),
        EconomyError::InvalidState
    );
    let spec = ModelSpec::try_from_slice(&ctx.accounts.model.data)?;
    let nonce = l.nonce.to_le_bytes();
    let bump = [l.bump];
    let seeds: &[&[u8]] = &[
        b"launch",
        l.model.as_ref(),
        l.launcher.as_ref(),
        &nonce,
        &bump,
    ];
    let infos = vec![
        ctx.accounts.module_vault.to_account_info(),
        ctx.accounts.launch.to_account_info(),
        ctx.accounts.base_mint.to_account_info(),
        ctx.accounts.quote_mint.to_account_info(),
        ctx.accounts.token_vault.to_account_info(),
        ctx.accounts.launcher.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.associated_token_program.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
    ];
    let (id, data, metas) = if l.mechanism == FUNDING {
        (
            depthguard_escrow::ID,
            depthguard_escrow::instruction::Initialize {
                beneficiary: l.launcher,
                reviewers: l.reviewers.clone(),
                threshold: spec.reviewer_threshold,
                milestones: spec.milestones,
            }
            .data(),
            depthguard_escrow::accounts::Initialize {
                vault: infos[0].key(),
                launch: infos[1].key(),
                base_mint: infos[2].key(),
                quote_mint: infos[3].key(),
                token_vault: infos[4].key(),
                payer: infos[5].key(),
                token_program: infos[6].key(),
                associated_token_program: infos[7].key(),
                system_program: infos[8].key(),
            }
            .to_account_metas(None),
        )
    } else {
        (
            depthguard_reserve::ID,
            depthguard_reserve::instruction::Initialize {
                beneficiary: l.launcher,
                reviewers: Vec::new(),
                threshold: 0,
                milestones: Vec::new(),
            }
            .data(),
            depthguard_reserve::accounts::Initialize {
                vault: infos[0].key(),
                launch: infos[1].key(),
                base_mint: infos[2].key(),
                quote_mint: infos[3].key(),
                token_vault: infos[4].key(),
                payer: infos[5].key(),
                token_program: infos[6].key(),
                associated_token_program: infos[7].key(),
                system_program: infos[8].key(),
            }
            .to_account_metas(None),
        )
    };
    require_keys_eq!(
        ctx.accounts.module_program.key(),
        id,
        EconomyError::InvalidTerms
    );
    let mut infos = infos;
    infos.push(ctx.accounts.module_program.to_account_info());
    invoke_signed(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: id,
            accounts: metas,
            data,
        },
        &infos,
        &[seeds],
    )?;
    ctx.accounts.launch.module_initialized = true;
    Ok(())
}
pub fn verify_migration_impl(ctx: Context<VerifyMigration>) -> Result<()> {
    let l = &ctx.accounts.launch;
    require!(l.phase == 2, EconomyError::InvalidState);
    let p = native::<dbc::state::VirtualPool>(&ctx.accounts.pool, dbc::ID)?;
    let c = native::<dbc::state::PoolConfig>(&ctx.accounts.config, dbc::ID)?;
    require!(
        p.pool_state.config == l.config
            && p.pool_state.base_mint == l.base_mint
            && p.pool_state.creator == l.key()
            && p.pool_state.is_migrated == 1
            && c.fee_claimer == l.fee_vault
            && c.quote_mint == l.quote_mint,
        EconomyError::InvalidTerms
    );
    let a = if l.base_mint.to_bytes() > l.quote_mint.to_bytes() {
        l.base_mint
    } else {
        l.quote_mint
    };
    let b = if a == l.base_mint {
        l.quote_mint
    } else {
        l.base_mint
    };
    let expected = Pubkey::find_program_address(
        &[b"pool", l.damm_config.as_ref(), a.as_ref(), b.as_ref()],
        &cp_amm::ID,
    )
    .0;
    require_keys_eq!(
        ctx.accounts.damm_pool.key(),
        expected,
        EconomyError::InvalidTerms
    );
    let damm = native::<cp_amm::state::Pool>(&ctx.accounts.damm_pool, cp_amm::ID)?;
    let position = native::<cp_amm::state::Position>(&ctx.accounts.position, cp_amm::ID)?;
    require!(
        damm.token_a_mint == l.base_mint
            && damm.token_b_mint == l.quote_mint
            && position.pool == expected
            && position.permanent_locked_liquidity > 0
            && position.unlocked_liquidity == 0
            && position.vested_liquidity == 0,
        EconomyError::InvalidTerms
    );
    // Upstream migration is permissionless: the submitting wallet selects the fresh NFT mint.
    // Bind the real, permanently locked DFS-owned position, rather than an anticipated signer.
    require_keys_eq!(
        ctx.accounts.position.key(),
        Pubkey::find_program_address(&[b"position", position.nft_mint.as_ref()], &cp_amm::ID).0,
        EconomyError::InvalidTerms
    );
    require_keys_eq!(
        ctx.accounts.position_nft.key(),
        Pubkey::find_program_address(
            &[b"position_nft_account", position.nft_mint.as_ref()],
            &cp_amm::ID
        )
        .0,
        EconomyError::InvalidTerms
    );
    require!(
        ctx.accounts.base_mint.mint_authority.is_none()
            && ctx.accounts.base_mint.freeze_authority.is_none(),
        EconomyError::InvalidTerms
    );
    let nft = ctx.accounts.position_nft.try_borrow_data()?;
    require!(
        *ctx.accounts.position_nft.owner == anchor_spl::token_2022::ID
            && nft.len() >= 165
            && nft[..32] == position.nft_mint.to_bytes()
            && nft[32..64] == l.fee_vault.to_bytes()
            && u64::from_le_bytes(nft[64..72].try_into().unwrap()) == 1
            && nft[72..76] == [0; 4],
        EconomyError::InvalidTerms
    );
    if c.migrated_compounding_fee_bps > 0 {
        require!(
            damm.sqrt_min_price == 0 && damm.sqrt_max_price == u128::MAX,
            EconomyError::InvalidTerms
        );
    } else {
        require!(
            damm.sqrt_min_price == 4295048016
                && damm.sqrt_max_price == 79226673521066979257578248091,
            EconomyError::InvalidTerms
        );
    }
    ctx.accounts.launch.first_position_mint = position.nft_mint;
    ctx.accounts.launch.phase = 3;
    ctx.accounts.launch.damm_pool = expected;
    emit!(LaunchTransition {
        version: 1,
        launch: ctx.accounts.launch.key(),
        model: ctx.accounts.launch.model,
        previous: 2,
        next: 3,
        amount: 0
    });
    Ok(())
}
pub fn fund_and_activate_impl(ctx: Context<FundAndActivate>) -> Result<()> {
    let l = &ctx.accounts.launch;
    require!(
        l.phase == 3 && l.module_initialized && (l.mechanism == FUNDING || l.mechanism == BACKED),
        EconomyError::InvalidState
    );
    let nonce = l.nonce.to_le_bytes();
    let bump = [l.bump];
    let seeds: &[&[u8]] = &[
        b"launch",
        l.model.as_ref(),
        l.launcher.as_ref(),
        &nonce,
        &bump,
    ];
    let id = if l.mechanism == FUNDING {
        depthguard_escrow::ID
    } else {
        depthguard_reserve::ID
    };
    require_keys_eq!(
        ctx.accounts.module_program.key(),
        id,
        EconomyError::InvalidTerms
    );
    require_keys_eq!(
        *ctx.accounts.module_vault.owner,
        id,
        EconomyError::InvalidTerms
    );
    let vault = Pubkey::find_program_address(&[b"vault", l.key().as_ref()], &id).0;
    require_keys_eq!(
        ctx.accounts.module_vault.key(),
        vault,
        EconomyError::InvalidTerms
    );
    let ata = Pubkey::find_program_address(
        &[
            vault.as_ref(),
            anchor_spl::token::ID.as_ref(),
            l.quote_mint.as_ref(),
        ],
        &anchor_spl::associated_token::ID,
    )
    .0;
    require_keys_eq!(
        ctx.accounts.token_vault.key(),
        ata,
        EconomyError::InvalidTerms
    );
    let before = ctx.accounts.token_vault.amount;
    dbc::cpi::withdraw_migration_fee(
        CpiContext::new_with_signer(
            ctx.accounts.dbc_program.key(),
            dbc::cpi::accounts::WithdrawMigrationFeeCtx {
                pool_authority: ctx.accounts.pool_authority.to_account_info(),
                config: ctx.accounts.config.to_account_info(),
                virtual_pool: ctx.accounts.pool.to_account_info(),
                token_quote_account: ctx.accounts.token_vault.to_account_info(),
                quote_vault: ctx.accounts.quote_vault.to_account_info(),
                quote_mint: ctx.accounts.quote_mint.to_account_info(),
                sender: ctx.accounts.launch.to_account_info(),
                token_quote_program: ctx.accounts.token_program.to_account_info(),
                event_authority: ctx.accounts.event_authority.to_account_info(),
                program: ctx.accounts.dbc_program.to_account_info(),
            },
            &[seeds],
        ),
        1,
    )?;
    ctx.accounts.token_vault.reload()?;
    let amount = ctx
        .accounts
        .token_vault
        .amount
        .checked_sub(before)
        .ok_or(EconomyError::Overflow)?;
    require!(amount > 0, EconomyError::InvalidAmount);
    let metas = depthguard_reserve::accounts::Activate {
        vault,
        launch: l.key(),
        token_vault: ctx.accounts.token_vault.key(),
    }
    .to_account_metas(None);
    let data = if l.mechanism == FUNDING {
        depthguard_escrow::instruction::Activate {}.data()
    } else {
        depthguard_reserve::instruction::Activate {}.data()
    };
    invoke_signed(
        &anchor_lang::solana_program::instruction::Instruction {
            program_id: id,
            accounts: metas,
            data,
        },
        &[
            ctx.accounts.module_vault.to_account_info(),
            ctx.accounts.launch.to_account_info(),
            ctx.accounts.token_vault.to_account_info(),
            ctx.accounts.module_program.to_account_info(),
        ],
        &[seeds],
    )?;
    let launch = &mut ctx.accounts.launch;
    launch.phase = 4;
    emit!(LaunchTransition {
        version: 1,
        launch: launch.key(),
        model: launch.model,
        previous: 3,
        next: 4,
        amount
    });
    Ok(())
}
fn dbc_pool(config: Pubkey, base: Pubkey, quote: Pubkey) -> Pubkey {
    let (a, b) = if base.to_bytes() > quote.to_bytes() {
        (base, quote)
    } else {
        (quote, base)
    };
    Pubkey::find_program_address(
        &[b"pool", config.as_ref(), a.as_ref(), b.as_ref()],
        &dbc::ID,
    )
    .0
}
#[derive(Accounts)]
pub struct CreateConfig<'info> {
    #[account(seeds=[b"platform"],bump)]
    pub platform: Account<'info, Platform>,
    #[account(address=launch.model)]
    pub model: Account<'info, ModelVersion>,
    #[account(mut,seeds=[b"launch",launch.model.as_ref(),launch.launcher.as_ref(),&launch.nonce.to_le_bytes()],bump=launch.bump,has_one=launcher,has_one=config,has_one=fee_vault)]
    pub launch: Account<'info, LaunchInstance>,
    #[account(mut,address=launch.config)]
    pub config: Signer<'info>,
    /// CHECK: native DFS owner, exact layout and immutable recipients validated before CPI.
    #[account(address=launch.fee_vault,owner=dfs::ID)]
    pub fee_vault: UncheckedAccount<'info>,
    pub quote_mint: Account<'info, Mint>,
    #[account(mut)]
    pub launcher: Signer<'info>,
    pub dbc_program: Program<'info, dbc::program::DynamicBondingCurve>,
    /// CHECK: Anchor event authority checked by the fixed DBC CPI.
    pub event_authority: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct CreatePool<'info> {
    #[account(mut,seeds=[b"launch",launch.model.as_ref(),launch.launcher.as_ref(),&launch.nonce.to_le_bytes()],bump=launch.bump,has_one=launcher,has_one=base_mint,has_one=quote_mint,has_one=config)]
    pub launch: Account<'info, LaunchInstance>,
    /// CHECK: fixed native configuration previously created by this factory.
    #[account(address=launch.config,owner=dbc::ID)]
    pub config: UncheckedAccount<'info>,
    /// CHECK: exact authority checked by native DBC initialization.
    pub pool_authority: UncheckedAccount<'info>,
    #[account(mut,address=launch.base_mint)]
    pub base_mint: Signer<'info>,
    pub quote_mint: Account<'info, Mint>,
    /// CHECK: native PDA and initialization validated by DBC CPI.
    #[account(mut,address=dbc_pool(launch.config,launch.base_mint,launch.quote_mint))]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: native mint/vault PDA validated by DBC CPI.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: native mint/vault PDA validated by DBC CPI.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: Metaplex metadata PDA validated by native creation.
    #[account(mut)]
    pub mint_metadata: UncheckedAccount<'info>,
    /// CHECK: fixed Metaplex program ID validated by DBC CPI.
    pub metadata_program: UncheckedAccount<'info>,
    #[account(mut)]
    pub launcher: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub dbc_program: Program<'info, dbc::program::DynamicBondingCurve>,
    pub system_program: Program<'info, System>,
    /// CHECK: Anchor event authority validated by DBC CPI.
    pub event_authority: UncheckedAccount<'info>,
}
#[derive(Accounts)]
pub struct InitializeModule<'info> {
    #[account(mut,seeds=[b"launch",launch.model.as_ref(),launch.launcher.as_ref(),&launch.nonce.to_le_bytes()],bump=launch.bump,has_one=model,has_one=launcher,has_one=base_mint,has_one=quote_mint)]
    pub launch: Account<'info, LaunchInstance>,
    pub model: Account<'info, ModelVersion>,
    pub base_mint: Account<'info, Mint>,
    pub quote_mint: Account<'info, Mint>,
    /// CHECK: module vault seeds and initialization enforced by selected fixed module CPI.
    #[account(mut)]
    pub module_vault: UncheckedAccount<'info>,
    /// CHECK: module ATA initialized by the selected fixed module CPI.
    #[account(mut)]
    pub token_vault: UncheckedAccount<'info>,
    /// CHECK: executable module address checked against mechanism-specific constant.
    #[account(executable)]
    pub module_program: UncheckedAccount<'info>,
    #[account(mut)]
    pub launcher: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct VerifyMigration<'info> {
    #[account(mut,seeds=[b"launch",launch.model.as_ref(),launch.launcher.as_ref(),&launch.nonce.to_le_bytes()],bump=launch.bump,has_one=base_mint,has_one=config)]
    pub launch: Account<'info, LaunchInstance>,
    pub base_mint: Account<'info, Mint>,
    /// CHECK: exact native owner/layout checked in migration verification.
    #[account(address=launch.config,owner=dbc::ID)]
    pub config: UncheckedAccount<'info>,
    /// CHECK: exact native pool derived from registered pair/config and decoded before verification.
    #[account(address=dbc_pool(launch.config,launch.base_mint,launch.quote_mint),owner=dbc::ID)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: native owner, derived pair/config and layout verified.
    #[account(owner=cp_amm::ID)]
    pub damm_pool: UncheckedAccount<'info>,
    /// CHECK: native owner/layout and actual NFT PDA checked in verification.
    #[account(owner=cp_amm::ID)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: Token-2022 owner, actual mint, DFS owner and amount verified from native token layout.
    pub position_nft: UncheckedAccount<'info>,
}
#[derive(Accounts)]
pub struct FundAndActivate<'info> {
    #[account(mut,seeds=[b"launch",launch.model.as_ref(),launch.launcher.as_ref(),&launch.nonce.to_le_bytes()],bump=launch.bump,has_one=config,has_one=quote_mint)]
    pub launch: Account<'info, LaunchInstance>,
    /// CHECK: exact native configuration previously verified; native CPI rechecks relationships.
    #[account(address=launch.config,owner=dbc::ID)]
    pub config: UncheckedAccount<'info>,
    /// CHECK: bound native pool; withdrawal CPI verifies creator, migration completion and replay mask.
    #[account(mut,address=dbc_pool(launch.config,launch.base_mint,launch.quote_mint),owner=dbc::ID)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: bound module program/launch PDA validated before CPI.
    #[account(mut)]
    pub module_vault: UncheckedAccount<'info>,
    #[account(mut,token::mint=quote_mint,token::authority=module_vault)]
    pub token_vault: Account<'info, TokenAccount>,
    /// CHECK: fixed module ID and executable checked before activation.
    #[account(executable)]
    pub module_program: UncheckedAccount<'info>,
    pub quote_mint: Account<'info, Mint>,
    /// CHECK: native quote vault checked by withdrawal CPI.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: native pool authority checked by withdrawal CPI.
    pub pool_authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub dbc_program: Program<'info, dbc::program::DynamicBondingCurve>,
    /// CHECK: native Anchor event authority checked by withdrawal CPI.
    pub event_authority: UncheckedAccount<'info>,
}

fn zero<T: AnchorSerialize>(value: &T) -> Result<bool> {
    let mut bytes = Vec::new();
    value.serialize(&mut bytes)?;
    Ok(bytes.iter().all(|b| *b == 0))
}
