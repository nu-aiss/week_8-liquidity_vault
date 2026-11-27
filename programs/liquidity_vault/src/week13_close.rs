use anchor_lang::prelude::*;

use anchor_spl::{
    memo::Memo,
    token::{Mint, Token, TokenAccount},
    token_2022::Token2022,
};

use raydium_clmm_cpi::{
    self,
    cpi::{
        self as raydium_cpi,
        accounts::{
            ClosePosition,
            DecreaseLiquidityV2,
        },
    },
    states::{
        PersonalPositionState,
        PoolState,
        TickArrayState,
    },
};

use crate::{
    week13::ClmmPositionState,
    VaultError,
    VaultState,
    CLMM_POOL,
    POOL_VAULT_A,
    POOL_VAULT_B,
    TOKEN_A,
    TOKEN_B,
};

#[derive(Accounts)]
pub struct DecreaseClmmLiquidity<'info> {
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"vault"],
        bump = vault.bump,
        constraint = vault.admin == admin.key()
            @ VaultError::UnauthorizedAdmin
    )]
    pub vault: Box<Account<'info, VaultState>>,

    #[account(
        seeds = [
            b"clmm-position",
            vault.key().as_ref()
        ],
        bump = clmm_position.bump,
        constraint = clmm_position.vault == vault.key()
            @ VaultError::InvalidVaultState,
        constraint = clmm_position.pool == CLMM_POOL
            @ VaultError::InvalidVaultState
    )]
    pub clmm_position:
        Box<Account<'info, ClmmPositionState>>,

    #[account(
        constraint = nft_account.owner == vault.key()
            @ VaultError::InvalidVaultState,
        constraint = nft_account.mint == clmm_position.nft_mint
            @ VaultError::InvalidVaultState,
        constraint = nft_account.amount == 1
            @ VaultError::InvalidVaultState
    )]
    pub nft_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = personal_position.nft_mint
            == clmm_position.nft_mint
            @ VaultError::InvalidVaultState,
        constraint = personal_position.pool_id == CLMM_POOL
            @ VaultError::InvalidVaultState,
        constraint = personal_position.tick_lower_index
            == clmm_position.tick_lower
            @ VaultError::InvalidVaultState,
        constraint = personal_position.tick_upper_index
            == clmm_position.tick_upper
            @ VaultError::InvalidVaultState
    )]
    pub personal_position:
        Box<Account<'info, PersonalPositionState>>,

    #[account(mut, address = CLMM_POOL)]
    pub pool_state: AccountLoader<'info, PoolState>,

    /// CHECK: Deprecated protocol-position account.
    /// Passed to Raydium for compatibility.
    pub protocol_position: UncheckedAccount<'info>,

    #[account(mut, address = POOL_VAULT_A)]
    pub pool_vault_a:
        Box<Account<'info, TokenAccount>>,

    #[account(mut, address = POOL_VAULT_B)]
    pub pool_vault_b:
        Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = tick_array_lower.load()?.pool_id == CLMM_POOL
            @ VaultError::InvalidVaultState
    )]
    pub tick_array_lower:
        AccountLoader<'info, TickArrayState>,

    #[account(
        mut,
        constraint = tick_array_upper.load()?.pool_id == CLMM_POOL
            @ VaultError::InvalidVaultState
    )]
    pub tick_array_upper:
        AccountLoader<'info, TickArrayState>,

    #[account(address = TOKEN_A)]
    pub token_a_mint: Box<Account<'info, Mint>>,

    #[account(address = TOKEN_B)]
    pub token_b_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        constraint = strategy_token_a.owner == vault.key()
            @ VaultError::InvalidVaultState,
        constraint = strategy_token_a.mint == TOKEN_A
            @ VaultError::InvalidVaultState
    )]
    pub strategy_token_a:
        Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = strategy_token_b.owner == vault.key()
            @ VaultError::InvalidVaultState,
        constraint = strategy_token_b.mint == TOKEN_B
            @ VaultError::InvalidVaultState
    )]
    pub strategy_token_b:
        Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,

    pub token_program_2022:
        Program<'info, Token2022>,

    pub memo_program: Program<'info, Memo>,

    #[account(address = raydium_clmm_cpi::ID)]
    pub raydium_program:
        Program<
            'info,
            raydium_clmm_cpi::program::RaydiumClmm
        >,
}

pub fn execute_decrease_clmm_liquidity<'info>(
    ctx: Context<'info, DecreaseClmmLiquidity<'info>>,
    liquidity: u128,
    amount_a_min: u64,
    amount_b_min: u64,
) -> Result<()> {

    require!(
        liquidity <= ctx.accounts.personal_position.liquidity,
        VaultError::InvalidVaultState
    );

    let position_key = ctx.accounts.personal_position.key();
    let mint_key = ctx.accounts.clmm_position.nft_mint;

    let (expected_position, _) =
        Pubkey::find_program_address(
            &[b"position", mint_key.as_ref()],
            &raydium_clmm_cpi::ID,
        );

    require_keys_eq!(
        position_key,
        expected_position,
        VaultError::InvalidVaultState
    );

    let pool_key = ctx.accounts.pool_state.key();

    let spacing = {
        let pool = ctx.accounts.pool_state.load()?;
        i32::from(pool.tick_spacing)
    };

    require!(
        spacing > 0,
        VaultError::InvalidVaultState
    );

    let span = spacing
        .checked_mul(60)
        .ok_or(VaultError::MathOverflow)?;

    let lower_start =
        ctx.accounts.clmm_position.tick_lower
            .div_euclid(span) * span;

    let upper_start =
        ctx.accounts.clmm_position.tick_upper
            .div_euclid(span) * span;

    let (expected_lower, _) =
        Pubkey::find_program_address(
            &[
                b"tick_array",
                pool_key.as_ref(),
                &lower_start.to_be_bytes(),
            ],
            &raydium_clmm_cpi::ID,
        );

    let (expected_upper, _) =
        Pubkey::find_program_address(
            &[
                b"tick_array",
                pool_key.as_ref(),
                &upper_start.to_be_bytes(),
            ],
            &raydium_clmm_cpi::ID,
        );

    require_keys_eq!(
        ctx.accounts.tick_array_lower.key(),
        expected_lower,
        VaultError::InvalidVaultState
    );

    require_keys_eq!(
        ctx.accounts.tick_array_upper.key(),
        expected_upper,
        VaultError::InvalidVaultState
    );

    let bump = [ctx.accounts.vault.bump];

    let vault_seeds: &[&[u8]] = &[
        b"vault",
        &bump,
    ];

    let signer = &[vault_seeds];

    let cpi_accounts = DecreaseLiquidityV2 {
        nft_owner:
            ctx.accounts.vault.to_account_info(),

        nft_account:
            ctx.accounts.nft_account.to_account_info(),

        personal_position:
            ctx.accounts.personal_position.to_account_info(),

        pool_state:
            ctx.accounts.pool_state.to_account_info(),

        protocol_position:
            ctx.accounts.protocol_position.to_account_info(),

        token_vault_0:
            ctx.accounts.pool_vault_a.to_account_info(),

        token_vault_1:
            ctx.accounts.pool_vault_b.to_account_info(),

        tick_array_lower:
            ctx.accounts.tick_array_lower.to_account_info(),

        tick_array_upper:
            ctx.accounts.tick_array_upper.to_account_info(),

        recipient_token_account_0:
            ctx.accounts.strategy_token_a.to_account_info(),

        recipient_token_account_1:
            ctx.accounts.strategy_token_b.to_account_info(),

        token_program:
            ctx.accounts.token_program.to_account_info(),

        token_program_2022:
            ctx.accounts.token_program_2022.to_account_info(),

        memo_program:
            ctx.accounts.memo_program.to_account_info(),

        vault_0_mint:
            ctx.accounts.token_a_mint.to_account_info(),

        vault_1_mint:
            ctx.accounts.token_b_mint.to_account_info(),
    };

    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.raydium_program.key(),
        cpi_accounts,
        signer,
    );

    msg!("Week 13: decreasing CLMM liquidity");

    raydium_cpi::decrease_liquidity_v2(
        cpi_ctx,
        liquidity,
        amount_a_min,
        amount_b_min,
    )?;

    msg!("Raydium decrease liquidity CPI completed");

    Ok(())
}

#[derive(Accounts)]
pub struct CloseClmmPosition<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault"],
        bump = vault.bump,
        constraint = vault.admin == admin.key()
            @ VaultError::UnauthorizedAdmin
    )]
    pub vault: Box<Account<'info, VaultState>>,

    #[account(
        mut,
        close = admin,
        seeds = [
            b"clmm-position",
            vault.key().as_ref()
        ],
        bump = clmm_position.bump,
        constraint = clmm_position.vault == vault.key()
            @ VaultError::InvalidVaultState,
        constraint = clmm_position.pool == CLMM_POOL
            @ VaultError::InvalidVaultState
    )]
    pub clmm_position:
        Box<Account<'info, ClmmPositionState>>,

    #[account(
        mut,
        address = clmm_position.nft_mint
    )]
    pub position_nft_mint:
        Box<Account<'info, Mint>>,

    #[account(
        mut,
        constraint = position_nft_account.owner == vault.key()
            @ VaultError::InvalidVaultState,
        constraint = position_nft_account.mint
            == clmm_position.nft_mint
            @ VaultError::InvalidVaultState,
        constraint = position_nft_account.amount == 1
            @ VaultError::InvalidVaultState
    )]
    pub position_nft_account:
        Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = personal_position.pool_id == CLMM_POOL
            @ VaultError::InvalidVaultState,
        constraint = personal_position.nft_mint
            == clmm_position.nft_mint
            @ VaultError::InvalidVaultState,
        constraint = personal_position.liquidity == 0
            @ VaultError::InvalidVaultState,
        constraint = personal_position.token_fees_owed_0 == 0
            @ VaultError::InvalidVaultState,
        constraint = personal_position.token_fees_owed_1 == 0
            @ VaultError::InvalidVaultState
    )]
    pub personal_position:
        Box<Account<'info, PersonalPositionState>>,

    pub system_program: Program<'info, System>,

    pub token_program: Program<'info, Token>,

    #[account(address = raydium_clmm_cpi::ID)]
    pub raydium_program:
        Program<
            'info,
            raydium_clmm_cpi::program::RaydiumClmm
        >,
}

pub fn execute_close_clmm_position<'info>(
    ctx: Context<'info, CloseClmmPosition<'info>>,
) -> Result<()> {

    let mint_key = ctx.accounts.position_nft_mint.key();

    let (expected_position, _) =
        Pubkey::find_program_address(
            &[b"position", mint_key.as_ref()],
            &raydium_clmm_cpi::ID,
        );

    require_keys_eq!(
        ctx.accounts.personal_position.key(),
        expected_position,
        VaultError::InvalidVaultState
    );

    let bump = [ctx.accounts.vault.bump];

    let vault_seeds: &[&[u8]] = &[
        b"vault",
        &bump,
    ];

    let signer = &[vault_seeds];

    let cpi_accounts = ClosePosition {
        nft_owner:
            ctx.accounts.vault.to_account_info(),

        position_nft_mint:
            ctx.accounts.position_nft_mint.to_account_info(),

        position_nft_account:
            ctx.accounts.position_nft_account.to_account_info(),

        personal_position:
            ctx.accounts.personal_position.to_account_info(),

        system_program:
            ctx.accounts.system_program.to_account_info(),

        token_program:
            ctx.accounts.token_program.to_account_info(),
    };

    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.raydium_program.key(),
        cpi_accounts,
        signer,
    );

    msg!("Week 13: closing CLMM position");

    raydium_cpi::close_position(cpi_ctx)?;

    msg!("Raydium position close CPI completed");

    Ok(())
}
