// Anchor 1.0 dispatch expansion uses a diverging expression for invalid instructions.
#![allow(clippy::diverging_sub_expression)]
use anchor_lang::{
    prelude::*, solana_program::program::invoke_signed, InstructionData, ToAccountMetas,
};
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};
use economy_core::*;
mod factory;
pub use factory::*;
declare_id!("5sUGNQ5pymevqfVmg99rgQ2jM4aVSo6RqhJtSK7VrPYz");
#[program]
pub mod depthguard_registry {
    use super::*;
    pub fn initialize_platform(
        ctx: Context<InitializePlatform>,
        recipient: Pubkey,
        damm_config: Pubkey,
    ) -> Result<()> {
        require!(
            recipient != Pubkey::default() && damm_config != Pubkey::default(),
            EconomyError::InvalidTerms
        );
        require!(
            ctx.accounts.program_data.upgrade_authority_address
                == Some(ctx.accounts.authority.key()),
            EconomyError::Unauthorized
        );
        let p = &mut ctx.accounts.platform;
        p.authority = ctx.accounts.authority.key();
        p.recipient = recipient;
        p.damm_config = damm_config;
        p.paused = false;
        Ok(())
    }
    pub fn pause_new_launches(ctx: Context<Pause>, paused: bool) -> Result<()> {
        ctx.accounts.platform.paused = paused;
        Ok(())
    }
    pub fn begin_model(
        ctx: Context<BeginModel>,
        digest: [u8; 32],
        json_hash: [u8; 32],
        size: u32,
    ) -> Result<()> {
        require!(
            !ctx.accounts.platform.paused && size > 0 && size as usize <= MAX_MODEL_BYTES,
            EconomyError::InvalidTerms
        );
        let m = &mut ctx.accounts.model;
        m.publisher = ctx.accounts.publisher.key();
        m.author = m.publisher;
        m.parent = Pubkey::default();
        m.digest = digest;
        m.json_hash = json_hash;
        m.size = size;
        m.sealed = false;
        m.data = Vec::new();
        m.inherited_shares = [0; 3];
        if let Some(parent) = &ctx.accounts.parent {
            require!(parent.sealed, EconomyError::InvalidState);
            let spec = ModelSpec::try_from_slice(&parent.data)?;
            m.author = parent.author;
            m.parent = parent.key();
            m.inherited_shares = [spec.launcher_bps, spec.author_bps, spec.platform_bps];
        }
        Ok(())
    }
    pub fn write_model(ctx: Context<WriteModel>, offset: u32, bytes: Vec<u8>) -> Result<()> {
        let m = &mut ctx.accounts.model;
        require!(
            !m.sealed
                && offset as usize == m.data.len()
                && !bytes.is_empty()
                && bytes.len() <= 600
                && m.data.len() + bytes.len() <= m.size as usize,
            EconomyError::InvalidTerms
        );
        m.data.extend_from_slice(&bytes);
        Ok(())
    }
    pub fn seal_model(ctx: Context<WriteModel>) -> Result<()> {
        let m = &mut ctx.accounts.model;
        require!(
            !m.sealed && m.data.len() == m.size as usize,
            EconomyError::InvalidState
        );
        require!(
            executable_digest(m.publisher, m.parent, m.author, &m.data) == m.digest,
            EconomyError::InvalidTerms
        );
        let spec = ModelSpec::try_from_slice(&m.data)?;
        spec.validate()?;
        validate_profile(&spec)?;
        if m.parent != Pubkey::default() {
            require!(
                m.inherited_shares == [spec.launcher_bps, spec.author_bps, spec.platform_bps],
                EconomyError::InvalidTerms
            );
        }
        m.sealed = true;
        emit!(ModelPublished {
            version: 1,
            model: m.key(),
            publisher: m.publisher,
            author: m.author,
            parent: m.parent,
            digest: m.digest,
            json_hash: m.json_hash
        });
        Ok(())
    }
    pub fn initialize_launch(
        ctx: Context<InitializeLaunch>,
        nonce: u64,
        config: Pubkey,
        base_mint: Pubkey,
        fee_vault: Pubkey,
        first_position_mint: Pubkey,
        reviewers: Vec<Pubkey>,
    ) -> Result<()> {
        require!(
            !ctx.accounts.platform.paused && ctx.accounts.model.sealed,
            EconomyError::InvalidState
        );
        let spec = ModelSpec::try_from_slice(&ctx.accounts.model.data)?;
        require!(
            [config, base_mint, fee_vault, first_position_mint]
                .iter()
                .all(|p| *p != Pubkey::default()),
            EconomyError::InvalidTerms
        );
        if spec.mechanism == FUNDING {
            ModuleState::initialize(
                ctx.accounts.launch.key(),
                base_mint,
                Pubkey::default(),
                ctx.accounts.launcher.key(),
                reviewers.clone(),
                spec.reviewer_threshold,
                spec.milestones.clone(),
                0,
                true,
            )?;
        } else {
            require!(reviewers.is_empty(), EconomyError::InvalidReviewers);
        }
        let l = &mut ctx.accounts.launch;
        l.model = ctx.accounts.model.key();
        l.launcher = ctx.accounts.launcher.key();
        l.nonce = nonce;
        l.bump = ctx.bumps.launch;
        l.config = config;
        l.base_mint = base_mint;
        l.fee_vault = fee_vault;
        l.first_position_mint = first_position_mint;
        l.damm_config = ctx.accounts.platform.damm_config;
        l.reviewers = reviewers;
        l.phase = 0;
        l.module_initialized = false;
        l.mechanism = spec.mechanism;
        l.quote_mint = Pubkey::default();
        l.damm_pool = Pubkey::default();
        Ok(())
    }
    pub fn create_config(ctx: Context<CreateConfig>) -> Result<()> {
        factory::create_config_impl(ctx)
    }
    pub fn create_pool<'info>(
        ctx: Context<'info, CreatePool<'info>>,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        factory::create_pool_impl(ctx, name, symbol, uri)
    }
    pub fn initialize_module(ctx: Context<InitializeModule>) -> Result<()> {
        factory::initialize_module_impl(ctx)
    }
    pub fn verify_migration(ctx: Context<VerifyMigration>) -> Result<()> {
        factory::verify_migration_impl(ctx)
    }
    pub fn fund_and_activate(ctx: Context<FundAndActivate>) -> Result<()> {
        factory::fund_and_activate_impl(ctx)
    }
}
#[account]
pub struct Platform {
    pub authority: Pubkey,
    pub recipient: Pubkey,
    pub damm_config: Pubkey,
    pub paused: bool,
}
#[account]
pub struct ModelVersion {
    pub publisher: Pubkey,
    pub author: Pubkey,
    pub parent: Pubkey,
    pub digest: [u8; 32],
    pub json_hash: [u8; 32],
    pub size: u32,
    pub sealed: bool,
    pub inherited_shares: [u16; 3],
    pub data: Vec<u8>,
}
#[account]
pub struct LaunchInstance {
    pub model: Pubkey,
    pub launcher: Pubkey,
    pub nonce: u64,
    pub bump: u8,
    pub config: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub fee_vault: Pubkey,
    pub first_position_mint: Pubkey,
    pub damm_config: Pubkey,
    pub damm_pool: Pubkey,
    pub reviewers: Vec<Pubkey>,
    pub phase: u8,
    pub module_initialized: bool,
    pub mechanism: u8,
}
#[derive(Accounts)]
pub struct InitializePlatform<'info> {
    #[account(init,payer=authority,space=8+128,seeds=[b"platform"],bump)]
    pub platform: Account<'info, Platform>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds=[crate::ID.as_ref()],bump,seeds::program=anchor_lang::solana_program::bpf_loader_upgradeable::ID)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct Pause<'info> {
    #[account(mut,seeds=[b"platform"],bump,has_one=authority)]
    pub platform: Account<'info, Platform>,
    pub authority: Signer<'info>,
}
#[derive(Accounts)]
#[instruction(digest:[u8;32])]
pub struct BeginModel<'info> {
    #[account(seeds=[b"platform"],bump)]
    pub platform: Account<'info, Platform>,
    #[account(init,payer=publisher,space=8+256+MAX_MODEL_BYTES,seeds=[b"model",publisher.key().as_ref(),&digest],bump)]
    pub model: Account<'info, ModelVersion>,
    pub parent: Option<Account<'info, ModelVersion>>,
    #[account(mut)]
    pub publisher: Signer<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct WriteModel<'info> {
    #[account(mut,has_one=publisher)]
    pub model: Account<'info, ModelVersion>,
    pub publisher: Signer<'info>,
}
#[derive(Accounts)]
#[instruction(nonce:u64)]
pub struct InitializeLaunch<'info> {
    #[account(seeds=[b"platform"],bump)]
    pub platform: Account<'info, Platform>,
    pub model: Account<'info, ModelVersion>,
    #[account(init,payer=launcher,space=8+768,seeds=[b"launch",model.key().as_ref(),launcher.key().as_ref(),&nonce.to_le_bytes()],bump)]
    pub launch: Account<'info, LaunchInstance>,
    #[account(mut)]
    pub launcher: Signer<'info>,
    pub system_program: Program<'info, System>,
}
#[event]
pub struct ModelPublished {
    pub version: u8,
    pub model: Pubkey,
    pub publisher: Pubkey,
    pub author: Pubkey,
    pub parent: Pubkey,
    pub digest: [u8; 32],
    pub json_hash: [u8; 32],
}
#[event]
pub struct LaunchTransition {
    pub version: u8,
    pub launch: Pubkey,
    pub model: Pubkey,
    pub previous: u8,
    pub next: u8,
    pub amount: u64,
}
