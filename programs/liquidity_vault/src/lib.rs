use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

declare_id!("DTFgRcxF6KWyrsTqWM9Lpzdtcc6FF7NqePkEMawQ7xBA");

#[program]
pub mod liquidity_vault {
    use super::*;

    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;

        vault.admin = ctx.accounts.admin.key();
        vault.deposit_mint = ctx.accounts.deposit_mint.key();
        vault.share_mint = ctx.accounts.share_mint.key();
        vault.token_vault = ctx.accounts.token_vault.key();
        vault.total_deposited = 0;
        vault.bump = ctx.bumps.vault;

        msg!("Liquidity Vault initialized successfully");

        Ok(())
    }

    pub fn open_position(
        ctx: Context<OpenPosition>,
    ) -> Result<()> {
        let position = &mut ctx.accounts.position;

        position.owner = ctx.accounts.user.key();
        position.vault = ctx.accounts.vault.key();
        position.deposited_amount = 0;
        position.bump = ctx.bumps.position;

        msg!("User position created successfully");

        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + VaultState::INIT_SPACE,
        seeds = [b"vault"],
        bump
    )]
    pub vault: Account<'info, VaultState>,

    pub deposit_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        mint::decimals = 6,
        mint::authority = vault,
        mint::freeze_authority = vault,
        seeds = [
            b"share_mint",
            vault.key().as_ref()
        ],
        bump
    )]
    pub share_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        token::mint = deposit_mint,
        token::authority = vault,
        seeds = [
            b"token_vault",
            vault.key().as_ref()
        ],
        bump
    )]
    pub token_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"vault"],
        bump = vault.bump
    )]
    pub vault: Account<'info, VaultState>,

    #[account(
        init,
        payer = user,
        space = 8 + UserPosition::INIT_SPACE,
        seeds = [
            b"position",
            vault.key().as_ref(),
            user.key().as_ref()
        ],
        bump
    )]
    pub position: Account<'info, UserPosition>,

    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct VaultState {
    pub admin: Pubkey,
    pub deposit_mint: Pubkey,
    pub share_mint: Pubkey,
    pub token_vault: Pubkey,
    pub total_deposited: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserPosition {
    pub owner: Pubkey,
    pub vault: Pubkey,
    pub deposited_amount: u64,
    pub bump: u8,
}
