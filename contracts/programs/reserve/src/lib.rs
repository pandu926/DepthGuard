// Anchor 1.0 dispatch expansion uses a diverging expression for invalid instructions.
#![allow(clippy::diverging_sub_expression)]
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount},
};
use economy_core::*;
declare_id!("7kaGXYpxPuCoh5o2AhxRoU8F13UUkHjfxVZUTYsKG88Y");
#[program]
pub mod depthguard_reserve {
    use super::*;
    pub fn initialize(
        ctx: Context<Initialize>,
        beneficiary: Pubkey,
        reviewers: Vec<Pubkey>,
        threshold: u8,
        milestones: Vec<Milestone>,
    ) -> Result<()> {
        require!(
            ctx.accounts.base_mint.mint_authority.is_none()
                && ctx.accounts.base_mint.freeze_authority.is_none(),
            EconomyError::InvalidTerms
        );
        require!(
            ctx.accounts.quote_mint.key() == anchor_spl::token::spl_token::native_mint::ID,
            EconomyError::InvalidTerms
        );
        ctx.accounts.vault.state = ModuleState::initialize(
            ctx.accounts.launch.key(),
            ctx.accounts.base_mint.key(),
            ctx.accounts.quote_mint.key(),
            beneficiary,
            reviewers,
            threshold,
            milestones,
            ctx.bumps.vault,
            false,
        )?;
        Ok(())
    }
    pub fn activate(ctx: Context<Activate>) -> Result<()> {
        let s = &mut ctx.accounts.vault.state;
        s.activate(
            ctx.accounts.token_vault.amount,
            Clock::get()?.unix_timestamp,
        )?;
        emit!(ModuleTransition {
            version: 1,
            launch: s.launch,
            previous: PENDING,
            next: ACTIVE,
            amount: s.initial_funding
        });
        Ok(())
    }
    pub fn redeem(ctx: Context<Redeem>, burn_amount: u64, min_payout: u64) -> Result<()> {
        require!(
            ctx.accounts.vault.state.state == ACTIVE,
            EconomyError::InvalidState
        );
        require!(
            ctx.accounts.base_mint.mint_authority.is_none()
                && ctx.accounts.base_mint.freeze_authority.is_none(),
            EconomyError::InvalidTerms
        );
        let amount = payout(
            burn_amount,
            ctx.accounts.token_vault.amount,
            ctx.accounts.base_mint.supply,
            min_payout,
        )?;
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                token::Burn {
                    mint: ctx.accounts.base_mint.to_account_info(),
                    from: ctx.accounts.holder_tokens.to_account_info(),
                    authority: ctx.accounts.holder.to_account_info(),
                },
            ),
            burn_amount,
        )?;
        pay(
            &ctx.accounts.vault,
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.token_vault.to_account_info(),
            ctx.accounts.receiver.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            amount,
        )?;
        emit!(Redeemed {
            version: 1,
            launch: ctx.accounts.vault.state.launch,
            holder: ctx.accounts.holder.key(),
            burned: burn_amount,
            paid: amount,
            supply_before: ctx.accounts.base_mint.supply,
            reserve_before: ctx.accounts.token_vault.amount
        });
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(
            amount > 0 && ctx.accounts.base_mint.supply > 0,
            EconomyError::InvalidAmount
        );
        require!(
            ctx.accounts.vault.state.state == PENDING || ctx.accounts.vault.state.state == ACTIVE,
            EconomyError::InvalidState
        );
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                token::Transfer {
                    from: ctx.accounts.source.to_account_info(),
                    to: ctx.accounts.token_vault.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            amount,
        )?;
        emit!(ReserveDeposit {
            version: 1,
            launch: ctx.accounts.vault.state.launch,
            depositor: ctx.accounts.depositor.key(),
            amount
        });
        Ok(())
    }
}
fn pay<'info>(
    vault: &Vault,
    authority: AccountInfo<'info>,
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    program: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let bump = [vault.state.bump];
    let seeds: &[&[u8]] = &[b"vault", vault.state.launch.as_ref(), &bump];
    token::transfer(
        CpiContext::new_with_signer(
            *program.key,
            token::Transfer {
                from,
                to,
                authority,
            },
            &[seeds],
        ),
        amount,
    )
}
#[account]
pub struct Vault {
    pub state: ModuleState,
}
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init,payer=payer,space=8+2048,seeds=[b"vault",launch.key().as_ref()],bump)]
    pub vault: Account<'info, Vault>,
    #[account(owner=REGISTRY_ID)]
    pub launch: Signer<'info>,
    pub base_mint: Account<'info, Mint>,
    pub quote_mint: Account<'info, Mint>,
    #[account(init,payer=payer,associated_token::mint=quote_mint,associated_token::authority=vault)]
    pub token_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct Activate<'info> {
    #[account(mut,seeds=[b"vault",launch.key().as_ref()],bump=vault.state.bump,constraint=vault.state.launch==launch.key())]
    pub vault: Account<'info, Vault>,
    #[account(owner=REGISTRY_ID)]
    pub launch: Signer<'info>,
    #[account(address=vault_token_address(vault.key(),vault.state.quote_mint),token::mint=vault.state.quote_mint,token::authority=vault)]
    pub token_vault: Account<'info, TokenAccount>,
}
#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(seeds=[b"vault",vault.state.launch.as_ref()],bump=vault.state.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut,address=vault.state.base_mint)]
    pub base_mint: Account<'info, Mint>,
    pub holder: Signer<'info>,
    #[account(mut,token::mint=base_mint,token::authority=holder)]
    pub holder_tokens: Account<'info, TokenAccount>,
    #[account(mut,address=vault_token_address(vault.key(),vault.state.quote_mint),token::mint=vault.state.quote_mint,token::authority=vault)]
    pub token_vault: Account<'info, TokenAccount>,
    #[account(mut,token::mint=vault.state.quote_mint,token::authority=holder)]
    pub receiver: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(seeds=[b"vault",vault.state.launch.as_ref()],bump=vault.state.bump)]
    pub vault: Account<'info, Vault>,
    #[account(address=vault.state.base_mint)]
    pub base_mint: Account<'info, Mint>,
    pub depositor: Signer<'info>,
    #[account(mut,token::mint=vault.state.quote_mint,token::authority=depositor)]
    pub source: Account<'info, TokenAccount>,
    #[account(mut,address=vault_token_address(vault.key(),vault.state.quote_mint),token::mint=vault.state.quote_mint,token::authority=vault)]
    pub token_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
#[event]
pub struct ReserveDeposit {
    pub version: u8,
    pub launch: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ModuleTransition {
    pub version: u8,
    pub launch: Pubkey,
    pub previous: u8,
    pub next: u8,
    pub amount: u64,
}
#[event]
pub struct Redeemed {
    pub version: u8,
    pub launch: Pubkey,
    pub holder: Pubkey,
    pub burned: u64,
    pub paid: u64,
    pub supply_before: u64,
    pub reserve_before: u64,
}

fn vault_token_address(vault: Pubkey, quote: Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[
            vault.as_ref(),
            anchor_spl::token::ID.as_ref(),
            quote.as_ref(),
        ],
        &anchor_spl::associated_token::ID,
    )
    .0
}
