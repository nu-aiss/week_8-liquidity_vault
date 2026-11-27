use anchor_lang::prelude::*;

use anchor_spl::{
    associated_token::{
        get_associated_token_address,
        AssociatedToken,
    },
    metadata::Metadata,
    token::{
        self, Approve, Mint, Revoke, Token, TokenAccount,
    },
    token_2022::Token2022,
};

use raydium_clmm_cpi::{
    self,
    cpi::{
        self as raydium_cpi,
        accounts::OpenPositionV2,
    },
    states::PoolState,
};

use crate::{
    VaultError,
    VaultState,
    TOKEN_A,
    TOKEN_B,
    CLMM_POOL,
    POOL_VAULT_A,
    POOL_VAULT_B,
};

#[account]
#[derive(InitSpace)]
pub struct ClmmPositionState {
    pub vault: Pubkey,
    pub pool: Pubkey,
    pub nft_mint: Pubkey,
    pub tick_lower: i32,
    pub tick_upper: i32,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct OpenClmmPosition<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"vault"],
        bump = vault.bump,
        constraint = vault.admin == admin.key()
            @ VaultError::UnauthorizedAdmin
    )]
    pub vault: Box<Account<'info, VaultState>>,

    #[account(
        init,
        payer = admin,
        space = 8 + ClmmPositionState::INIT_SPACE,
        seeds = [
            b"clmm-position",
            vault.key().as_ref()
        ],
        bump
    )]
    pub clmm_position:
        Box<Account<'info, ClmmPositionState>>,

    #[account(address = TOKEN_A)]
    pub token_a_mint: Box<Account<'info, Mint>>,

    #[account(address = TOKEN_B)]
    pub token_b_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = token_a_mint,
        associated_token::authority = vault
    )]
    pub strategy_token_a:
        Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = token_b_mint,
        associated_token::authority = vault
    )]
    pub strategy_token_b:
        Box<Account<'info, TokenAccount>>,

    #[account(mut, address = CLMM_POOL)]
    pub pool_state: AccountLoader<'info, PoolState>,

    #[account(mut, address = POOL_VAULT_A)]
    pub pool_vault_a:
        Box<Account<'info, TokenAccount>>,

    #[account(mut, address = POOL_VAULT_B)]
    pub pool_vault_b:
        Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub position_nft_mint: Signer<'info>,

    #[account(mut)]
    /// CHECK: Checked against the NFT ATA of Vault PDA.
    pub position_nft_account:
        UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Checked against Raydium personal position PDA.
    pub personal_position:
        UncheckedAccount<'info>,

    /// CHECK: Legacy protocol position, validated by Raydium.
    pub protocol_position:
        UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Address and owner are checked before CPI.
    pub tick_array_lower:
        UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Address and owner are checked before CPI.
    pub tick_array_upper:
        UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Optional metadata account, validated by Raydium.
    pub metadata_account:
        UncheckedAccount<'info>,

    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,

    pub token_program_2022:
        Program<'info, Token2022>,

    pub associated_token_program:
        Program<'info, AssociatedToken>,

    pub metadata_program:
        Program<'info, Metadata>,

    #[account(address = raydium_clmm_cpi::ID)]
    pub raydium_program:
        Program<
            'info,
            raydium_clmm_cpi::program::RaydiumClmm
        >,
}

pub fn execute_open_clmm_position<'info>(
    ctx: Context<'info, OpenClmmPosition<'info>>,
    tick_lower: i32,
    tick_upper: i32,
    lower_start: i32,
    upper_start: i32,
    amount_a_max: u64,
    amount_b_max: u64,
) -> Result<()> {

    require!(
        tick_lower < tick_upper,
        VaultError::InvalidVaultState
    );

    require!(
        amount_a_max > 0 && amount_b_max > 0,
        VaultError::ZeroSwapAmount
    );

    require!(
        ctx.accounts.strategy_token_a.amount >= amount_a_max
            && ctx.accounts.strategy_token_b.amount >= amount_b_max,
        VaultError::InsufficientStrategyAssets
    );

    let pool = ctx.accounts.pool_state.load()?;

    let spacing = i32::from(pool.tick_spacing);
    let current_tick = pool.tick_current;

    require!(
        spacing > 0,
        VaultError::InvalidVaultState
    );

    require!(
        pool.token_mint_0 == TOKEN_A
            && pool.token_mint_1 == TOKEN_B
            && pool.token_vault_0 == POOL_VAULT_A
            && pool.token_vault_1 == POOL_VAULT_B,
        VaultError::InvalidVaultState
    );

    require!(
        tick_lower % spacing == 0
            && tick_upper % spacing == 0,
        VaultError::InvalidVaultState
    );

    require!(
        tick_lower < current_tick
            && current_tick < tick_upper,
        VaultError::InvalidVaultState
    );

    let array_span = spacing
        .checked_mul(60)
        .ok_or(VaultError::MathOverflow)?;

    let expected_lower_start =
        tick_lower.div_euclid(array_span) * array_span;

    let expected_upper_start =
        tick_upper.div_euclid(array_span) * array_span;

    require!(
        lower_start == expected_lower_start
            && upper_start == expected_upper_start,
        VaultError::InvalidVaultState
    );

    drop(pool);

    let pool_key = ctx.accounts.pool_state.key();

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
        VaultError::InvalidRemainingAccount
    );

    require_keys_eq!(
        ctx.accounts.tick_array_upper.key(),
        expected_upper,
        VaultError::InvalidRemainingAccount
    );

    require_keys_eq!(
        *ctx.accounts.tick_array_lower.owner,
        raydium_clmm_cpi::ID,
        VaultError::InvalidRemainingAccount
    );

    require_keys_eq!(
        *ctx.accounts.tick_array_upper.owner,
        raydium_clmm_cpi::ID,
        VaultError::InvalidRemainingAccount
    );

    let vault_key = ctx.accounts.vault.key();
    let nft_mint_key =
        ctx.accounts.position_nft_mint.key();

    let expected_nft_ata =
        get_associated_token_address(
            &vault_key,
            &nft_mint_key,
        );

    require_keys_eq!(
        ctx.accounts.position_nft_account.key(),
        expected_nft_ata,
        VaultError::InvalidVaultState
    );

    let (expected_personal_position, _) =
        Pubkey::find_program_address(
            &[
                b"position",
                nft_mint_key.as_ref(),
            ],
            &raydium_clmm_cpi::ID,
        );

    require_keys_eq!(
        ctx.accounts.personal_position.key(),
        expected_personal_position,
        VaultError::InvalidVaultState
    );

    let vault_bump = [ctx.accounts.vault.bump];

    let vault_seeds: &[&[u8]] = &[
        b"vault",
        &vault_bump,
    ];

    let signer_seeds = &[vault_seeds];


    let approve_a = Approve {
        to: ctx.accounts.strategy_token_a.to_account_info(),
        delegate: ctx.accounts.admin.to_account_info(),
        authority: ctx.accounts.vault.to_account_info(),
    };

    token::approve(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            approve_a,
            signer_seeds,
        ),
        amount_a_max,
    )?;


    let approve_b = Approve {
        to: ctx.accounts.strategy_token_b.to_account_info(),
        delegate: ctx.accounts.admin.to_account_info(),
        authority: ctx.accounts.vault.to_account_info(),
    };

    token::approve(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            approve_b,
            signer_seeds,
        ),
        amount_b_max,
    )?;


    let cpi_accounts = OpenPositionV2 {
        payer:
            ctx.accounts.admin.to_account_info(),

        position_nft_owner:
            ctx.accounts.vault.to_account_info(),

        position_nft_mint:
            ctx.accounts.position_nft_mint.to_account_info(),

        position_nft_account:
            ctx.accounts.position_nft_account.to_account_info(),

        metadata_account:
            ctx.accounts.metadata_account.to_account_info(),

        pool_state:
            ctx.accounts.pool_state.to_account_info(),

        protocol_position:
            ctx.accounts.protocol_position.to_account_info(),

        tick_array_lower:
            ctx.accounts.tick_array_lower.to_account_info(),

        tick_array_upper:
            ctx.accounts.tick_array_upper.to_account_info(),

        personal_position:
            ctx.accounts.personal_position.to_account_info(),

        token_account_0:
            ctx.accounts.strategy_token_a.to_account_info(),

        token_account_1:
            ctx.accounts.strategy_token_b.to_account_info(),

        token_vault_0:
            ctx.accounts.pool_vault_a.to_account_info(),

        token_vault_1:
            ctx.accounts.pool_vault_b.to_account_info(),

        rent:
            ctx.accounts.rent.to_account_info(),

        system_program:
            ctx.accounts.system_program.to_account_info(),

        token_program:
            ctx.accounts.token_program.to_account_info(),

        associated_token_program:
            ctx.accounts.associated_token_program.to_account_info(),

        metadata_program:
            ctx.accounts.metadata_program.to_account_info(),

        token_program_2022:
            ctx.accounts.token_program_2022.to_account_info(),

        vault_0_mint:
            ctx.accounts.token_a_mint.to_account_info(),

        vault_1_mint:
            ctx.accounts.token_b_mint.to_account_info(),
    };

    let cpi_ctx = CpiContext::new(
        ctx.accounts.raydium_program.key(),
        cpi_accounts,
    );

    msg!("Opening Vault-controlled CLMM position");


    raydium_cpi::open_position_v2(
        cpi_ctx,
        tick_lower,
        tick_upper,
        lower_start,
        upper_start,
        0,
        amount_a_max,
        amount_b_max,
        false,
        Some(true),
    )?;


    let revoke_a = Revoke {
        source: ctx.accounts.strategy_token_a.to_account_info(),
        authority: ctx.accounts.vault.to_account_info(),
    };

    token::revoke(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            revoke_a,
            signer_seeds,
        ),
    )?;


    let revoke_b = Revoke {
        source: ctx.accounts.strategy_token_b.to_account_info(),
        authority: ctx.accounts.vault.to_account_info(),
    };

    token::revoke(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            revoke_b,
            signer_seeds,
        ),
    )?;


    let state = &mut ctx.accounts.clmm_position;

    state.vault = vault_key;
    state.pool = pool_key;
    state.nft_mint = nft_mint_key;
    state.tick_lower = tick_lower;
    state.tick_upper = tick_upper;
    state.bump = ctx.bumps.clmm_position;

    msg!("CLMM position created");
    msg!("NFT mint: {}", nft_mint_key);
    msg!("NFT owner: {}", vault_key);
    msg!("Temporary token delegations revoked");

    Ok(())
}
