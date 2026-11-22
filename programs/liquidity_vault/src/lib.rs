
use anchor_lang::prelude::*;
use anchor_spl::token::{
    self, Burn, Mint, MintTo, Token, TokenAccount, Transfer,
};

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

        msg!("Liquidity Vault initialized");

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

        msg!("User position created");

        Ok(())
    }

    pub fn deposit(
        ctx: Context<Deposit>,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, VaultError::ZeroDeposit);

        let total_assets = ctx.accounts.token_vault.amount;
        let total_shares = ctx.accounts.share_mint.supply;

        let shares: u64 = if total_shares == 0 {
            require!(
                total_assets == 0,
                VaultError::InvalidVaultState
            );
            amount
        } else {
            require!(
                total_assets > 0,
                VaultError::InvalidVaultState
            );

            let calculated = (amount as u128)
                .checked_mul(total_shares as u128)
                .ok_or(VaultError::MathOverflow)?
                .checked_div(total_assets as u128)
                .ok_or(VaultError::MathOverflow)?;

            u64::try_from(calculated)
                .map_err(|_| error!(VaultError::MathOverflow))?
        };

        require!(shares > 0, VaultError::ZeroShares);

        let transfer_accounts = Transfer {
            from: ctx.accounts
                .user_token_account.to_account_info(),
            to: ctx.accounts.token_vault.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };

        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.key(),
            transfer_accounts,
        );

        token::transfer(transfer_ctx, amount)?;

        let signer_seeds: &[&[u8]] = &[
            b"vault",
            &[ctx.accounts.vault.bump],
        ];
        let signer = &[signer_seeds];

        let mint_accounts = MintTo {
            mint: ctx.accounts.share_mint.to_account_info(),
            to: ctx.accounts
                .user_share_account.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        };

        let mint_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            mint_accounts,
            signer,
        );

        token::mint_to(mint_ctx, shares)?;

        let vault = &mut ctx.accounts.vault;
        vault.total_deposited = vault.total_deposited
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;

        let position = &mut ctx.accounts.position;
        position.deposited_amount = position.deposited_amount
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;

        msg!("Deposit: {}", amount);
        msg!("Shares minted: {}", shares);

        Ok(())
    }

    pub fn withdraw(
        ctx: Context<Withdraw>,
        shares: u64,
    ) -> Result<()> {
        require!(shares > 0, VaultError::ZeroWithdrawal);

        let total_shares = ctx.accounts.share_mint.supply;
        let total_assets = ctx.accounts.token_vault.amount;

        require!(
            total_shares > 0,
            VaultError::InvalidVaultState
        );
        require!(
            total_assets > 0,
            VaultError::InsufficientVaultAssets
        );
        require!(
            ctx.accounts.user_share_account.amount >= shares,
            VaultError::InsufficientShares
        );

        // Сумма вывода пропорциональна доле shares
        let calculated = (shares as u128)
            .checked_mul(total_assets as u128)
            .ok_or(VaultError::MathOverflow)?
            .checked_div(total_shares as u128)
            .ok_or(VaultError::MathOverflow)?;

        let amount_out = u64::try_from(calculated)
            .map_err(|_| error!(VaultError::MathOverflow))?;

        require!(
            amount_out > 0,
            VaultError::ZeroWithdrawalAmount
        );

        require!(
            amount_out <= total_assets,
            VaultError::InsufficientVaultAssets
        );

        let burn_accounts = Burn {
            mint: ctx.accounts.share_mint.to_account_info(),
            from: ctx.accounts
                .user_share_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };

        let burn_ctx = CpiContext::new(
            ctx.accounts.token_program.key(),
            burn_accounts,
        );

        token::burn(burn_ctx, shares)?;

        let signer_seeds: &[&[u8]] = &[
            b"vault",
            &[ctx.accounts.vault.bump],
        ];
        let signer = &[signer_seeds];

        let transfer_accounts = Transfer {
            from: ctx.accounts.token_vault.to_account_info(),
            to: ctx.accounts
                .user_token_account.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        };

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            transfer_accounts,
            signer,
        );

        token::transfer(transfer_ctx, amount_out)?;

        msg!("Shares burned: {}", shares);
        msg!("Tokens withdrawn: {}", amount_out);

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


#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault"],
        bump = vault.bump,
        has_one = deposit_mint,
        has_one = share_mint,
        has_one = token_vault
    )]
    pub vault: Box<Account<'info, VaultState>>,

    #[account(
        mut,
        seeds = [
            b"position",
            vault.key().as_ref(),
            user.key().as_ref()
        ],
        bump = position.bump,
        constraint = position.owner == user.key(),
        constraint = position.vault == vault.key()
    )]
    pub position: Box<Account<'info, UserPosition>>,

    pub deposit_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [
            b"share_mint",
            vault.key().as_ref()
        ],
        bump,
        mint::authority = vault,
        constraint = share_mint.decimals == deposit_mint.decimals
    )]
    pub share_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [
            b"token_vault",
            vault.key().as_ref()
        ],
        bump,
        token::mint = deposit_mint,
        token::authority = vault
    )]
    pub token_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = deposit_mint,
        token::authority = user
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = share_mint,
        token::authority = user
    )]
    pub user_share_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}


#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"vault"],
        bump = vault.bump,
        has_one = deposit_mint,
        has_one = share_mint,
        has_one = token_vault
    )]
    pub vault: Box<Account<'info, VaultState>>,

    #[account(
        seeds = [
            b"position",
            vault.key().as_ref(),
            user.key().as_ref()
        ],
        bump = position.bump,
        constraint = position.owner == user.key(),
        constraint = position.vault == vault.key()
    )]
    pub position: Box<Account<'info, UserPosition>>,

    pub deposit_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [
            b"share_mint",
            vault.key().as_ref()
        ],
        bump,
        mint::authority = vault,
        constraint = share_mint.decimals == deposit_mint.decimals
    )]
    pub share_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [
            b"token_vault",
            vault.key().as_ref()
        ],
        bump,
        token::mint = deposit_mint,
        token::authority = vault
    )]
    pub token_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = deposit_mint,
        token::authority = user
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = share_mint,
        token::authority = user
    )]
    pub user_share_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
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


#[error_code]
pub enum VaultError {
    #[msg("Deposit must be greater than zero")]
    ZeroDeposit,

    #[msg("Calculated shares must be greater than zero")]
    ZeroShares,

    #[msg("Arithmetic overflow")]
    MathOverflow,

    #[msg("Invalid vault state")]
    InvalidVaultState,

    #[msg("Withdrawal shares must be greater than zero")]
    ZeroWithdrawal,

    #[msg("User has insufficient share tokens")]
    InsufficientShares,

    #[msg("Vault has insufficient available tokens")]
    InsufficientVaultAssets,

    #[msg("Calculated withdrawal amount is zero")]
    ZeroWithdrawalAmount,
}
