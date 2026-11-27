use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    memo::Memo,
    token::{
        self, Burn, Mint, MintTo, Token, TokenAccount, Transfer,
    },
    token_2022::Token2022,
};
use raydium_clmm_cpi::{
    self,
    cpi::{
        self as raydium_cpi,
        accounts::SwapSingleV2,
    },
    states::{
        AmmConfig,
        ObservationState,
        PoolState,
    },
};

pub mod week13;
pub use week13::*;

pub mod week13_close;
pub use week13_close::*;

declare_id!("DTFgRcxF6KWyrsTqWM9Lpzdtcc6FF7NqePkEMawQ7xBA");

pub const TOKEN_A: Pubkey =
    pubkey!("BbGbr6kU99qrS5oiNpPTBwC4mpw84wuN6ugVRQpA9Mii");

pub const TOKEN_B: Pubkey =
    pubkey!("ENbngk26rEp1PJ2yoSo6ufvUXiwWjEte3ZqNPVTAdMqb");

pub const CLMM_POOL: Pubkey =
    pubkey!("BLpJrvf6CYTAkMXg4S3xQrtSssh9b3uhMrUNk94KHD8R");

pub const CLMM_CONFIG: Pubkey =
    pubkey!("CD4aJtX11cqTCAc83nxSPkkh5JW2yjD6uwHeovjqQ1qu");

pub const POOL_VAULT_A: Pubkey =
    pubkey!("GhZ2VTpzXXmGAbxWKNZ4wFtYyC42WhvcYpsEwU1w3yqL");

pub const POOL_VAULT_B: Pubkey =
    pubkey!("AEhnX24oC7fuUeQe3sH8ByXAupEw2ryxW4jjWV3Sh6qZ");

    #[program]
    pub mod liquidity_vault {
        use super::*;

    pub fn decrease_clmm_liquidity<'info>(
        ctx: Context<'info, DecreaseClmmLiquidity<'info>>,
        liquidity: u128,
        amount_a_min: u64,
        amount_b_min: u64,
    ) -> Result<()> {
        week13_close::execute_decrease_clmm_liquidity(
            ctx,
            liquidity,
            amount_a_min,
            amount_b_min,
        )
    }

    pub fn collect_clmm_fees<'info>(
        ctx: Context<'info, DecreaseClmmLiquidity<'info>>,
    ) -> Result<()> {
        week13_close::execute_decrease_clmm_liquidity(
            ctx,
            0,
            0,
            0,
        )
    }

    pub fn close_clmm_position<'info>(
        ctx: Context<'info, CloseClmmPosition<'info>>,
    ) -> Result<()> {
        week13_close::execute_close_clmm_position(ctx)
    }

        
        pub fn open_clmm_position<'info>(
            ctx: Context<'info, OpenClmmPosition<'info>>,
            tick_lower: i32,
            tick_upper: i32,
            lower_start: i32,
            upper_start: i32,
            amount_a_max: u64,
            amount_b_max: u64,
        ) -> Result<()> {
            week13::execute_open_clmm_position(
                ctx,
                tick_lower,
                tick_upper,
                lower_start,
                upper_start,
                amount_a_max,
                amount_b_max,
            )
        }
        

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
            from: ctx
                .accounts
                .user_token_account
                .to_account_info(),
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
            to: ctx
                .accounts
                .user_share_account
                .to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        };

        let mint_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            mint_accounts,
            signer,
        );

        token::mint_to(mint_ctx, shares)?;

        let vault = &mut ctx.accounts.vault;

        vault.total_deposited = vault
            .total_deposited
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;

        let position = &mut ctx.accounts.position;

        position.deposited_amount = position
            .deposited_amount
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
            from: ctx
                .accounts
                .user_share_account
                .to_account_info(),
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
            to: ctx
                .accounts
                .user_token_account
                .to_account_info(),
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



    pub fn initialize_strategy(
        ctx: Context<InitializeStrategy>,
    ) -> Result<()> {
        msg!("Week 12: strategy initialized");
        msg!(
            "Strategy TOKEN A: {}",
            ctx.accounts.strategy_token_a.key()
        );
        msg!(
            "Strategy TOKEN B: {}",
            ctx.accounts.strategy_token_b.key()
        );
        msg!(
            "Authority PDA: {}",
            ctx.accounts.vault.key()
        );

        Ok(())
    }


    pub fn swap_clmm<'info>(
        ctx: Context<'info, SwapClmm<'info>>,
        amount_in: u64,
        minimum_amount_out: u64,
    ) -> Result<()> {
        require!(
            amount_in > 0,
            VaultError::ZeroSwapAmount
        );

        require!(
            minimum_amount_out > 0,
            VaultError::InvalidMinimumOutput
        );

        require!(
            ctx.accounts.strategy_token_a.amount >= amount_in,
            VaultError::InsufficientStrategyAssets
        );

        require!(
            ctx.remaining_accounts.len() > 0,
            VaultError::MissingTickArrays
        );

     
        for account in ctx.remaining_accounts.iter() {
            require_keys_eq!(
                *account.owner,
                raydium_clmm_cpi::ID,
                VaultError::InvalidRemainingAccount
            );

            require!(
                account.is_writable,
                VaultError::InvalidRemainingAccount
            );

            require!(
                !account.is_signer,
                VaultError::InvalidRemainingAccount
            );
        }

        let signer_seeds: &[&[u8]] = &[
            b"vault",
            &[ctx.accounts.vault.bump],
        ];
        let signer = &[signer_seeds];

        let cpi_accounts = SwapSingleV2 {
            payer: ctx.accounts.vault.to_account_info(),
            amm_config: ctx.accounts.amm_config.to_account_info(),
            pool_state: ctx.accounts.pool_state.to_account_info(),
            input_token_account: ctx
                .accounts
                .strategy_token_a
                .to_account_info(),
            output_token_account: ctx
                .accounts
                .strategy_token_b
                .to_account_info(),
            input_vault: ctx
                .accounts
                .pool_vault_a
                .to_account_info(),
            output_vault: ctx
                .accounts
                .pool_vault_b
                .to_account_info(),
            observation_state: ctx
                .accounts
                .observation_state
                .to_account_info(),
            token_program: ctx
                .accounts
                .token_program
                .to_account_info(),
            token_program_2022: ctx
                .accounts
                .token_program_2022
                .to_account_info(),
            memo_program: ctx
                .accounts
                .memo_program
                .to_account_info(),
            input_vault_mint: ctx
                .accounts
                .token_a_mint
                .to_account_info(),
            output_vault_mint: ctx
                .accounts
                .token_b_mint
                .to_account_info(),
        };

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.raydium_program.key(),
            cpi_accounts,
            signer,
        )
        .with_remaining_accounts(
            ctx.remaining_accounts.to_vec()
        );

        msg!("Week 12: invoking Raydium SwapV2");
        msg!("Input TOKEN A: {}", amount_in);
        msg!("Minimum TOKEN B: {}", minimum_amount_out);

        raydium_cpi::swap_v2(
            cpi_ctx,
            amount_in,
            minimum_amount_out,
            0,
            true,
        )?;

        msg!("Week 12: Raydium CPI swap succeeded");

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

#[derive(Accounts)]
pub struct InitializeStrategy<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"vault"],
        bump = vault.bump,
        constraint = vault.admin == admin.key()
            @ VaultError::UnauthorizedAdmin
    )]
    pub vault: Box<Account<'info, VaultState>>,

    #[account(address = TOKEN_A)]
    pub token_a_mint: Box<Account<'info, Mint>>,

    #[account(address = TOKEN_B)]
    pub token_b_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = admin,
        associated_token::mint = token_a_mint,
        associated_token::authority = vault
    )]
    pub strategy_token_a: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = admin,
        associated_token::mint = token_b_mint,
        associated_token::authority = vault
    )]
    pub strategy_token_b: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SwapClmm<'info> {
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"vault"],
        bump = vault.bump,
        constraint = vault.admin == admin.key()
            @ VaultError::UnauthorizedAdmin
    )]
    pub vault: Box<Account<'info, VaultState>>,

    #[account(address = TOKEN_A)]
    pub token_a_mint: Box<Account<'info, Mint>>,

    #[account(address = TOKEN_B)]
    pub token_b_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = token_a_mint,
        associated_token::authority = vault
    )]
    pub strategy_token_a: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = token_b_mint,
        associated_token::authority = vault
    )]
    pub strategy_token_b: Box<Account<'info, TokenAccount>>,

    #[account(address = CLMM_CONFIG)]
    pub amm_config: Box<Account<'info, AmmConfig>>,

    #[account(
        mut,
        address = CLMM_POOL
    )]
    pub pool_state: AccountLoader<'info, PoolState>,

    #[account(
        mut,
        address = POOL_VAULT_A,
        token::mint = token_a_mint,
        token::authority = pool_state
    )]
    pub pool_vault_a: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        address = POOL_VAULT_B,
        token::mint = token_b_mint,
        token::authority = pool_state
    )]
    pub pool_vault_b: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        address = pool_state.load()?.observation_key
    )]
    pub observation_state:
        AccountLoader<'info, ObservationState>,

    pub token_program: Program<'info, Token>,
    pub token_program_2022: Program<'info, Token2022>,
    pub memo_program: Program<'info, Memo>,

    #[account(address = raydium_clmm_cpi::ID)]
    pub raydium_program: Program<
        'info,
        raydium_clmm_cpi::program::RaydiumClmm
    >,
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

    #[msg("Only Vault administrator can perform this action")]
    UnauthorizedAdmin,

    #[msg("Swap amount must be greater than zero")]
    ZeroSwapAmount,

    #[msg("Minimum swap output must be greater than zero")]
    InvalidMinimumOutput,

    #[msg("Insufficient strategy token balance")]
    InsufficientStrategyAssets,

    #[msg("Swap requires tick array accounts")]
    MissingTickArrays,

    #[msg("Invalid additional Raydium account")]
    InvalidRemainingAccount,
}
