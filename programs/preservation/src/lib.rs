use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

declare_id!("DmJ2i449s713AD6R9MM2fVzxyV3GsmmzoxKgtUNimJfL");

#[program]
pub mod preservation {
    use super::*;

    /// Registers a new Storage Provider.
    /// Initializes the provider's stats and deposits the initial stake into the vault.
    pub fn register_provider(ctx: Context<RegisterProvider>, stake_amount: u64) -> Result<()> {
        let provider = &mut ctx.accounts.provider;
        provider.owner = ctx.accounts.owner.key();
        provider.stake_amount = stake_amount;
        provider.locked_stake = 0;
        provider.total_stored = 0;
        provider.successful_deals = 0;
        provider.failed_deals = 0;
        provider.bump = ctx.bumps.provider;

        // Transfer initial stake to the program vault if amount > 0
        if stake_amount > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.owner_token_account.to_account_info(),
                        to: ctx.accounts.stake_vault.to_account_info(),
                        authority: ctx.accounts.owner.to_account_info(),
                    },
                ),
                stake_amount,
            )?;
        }

        emit!(ProviderRegistered {
            owner: provider.owner,
            stake_amount
        });

        Ok(())
    }

    /// Allows a provider to deposit additional tokens to their stake (Top-up).
    /// Increases the `stake_amount` available for collateral.
    pub fn deposit_stake(ctx: Context<DepositStake>, amount: u64) -> Result<()> {
        let provider = &mut ctx.accounts.provider;

        // Transfer tokens from user wallet to stake vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.owner_token_account.to_account_info(),
                    to: ctx.accounts.stake_vault.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;

        // Update state
        provider.stake_amount = provider.stake_amount.checked_add(amount).unwrap();

        emit!(StakeDeposited {
            provider: provider.owner,
            amount,
            new_total: provider.stake_amount
        });

        Ok(())
    }

    /// Allows a provider to withdraw available (unlocked) stake.
    /// Ensures that locked collateral for active deals cannot be withdrawn.
    pub fn withdraw_stake(ctx: Context<WithdrawStake>, amount: u64) -> Result<()> {
        let provider = &mut ctx.accounts.provider;

        // Calculate free balance (Total - Locked)
        let free_balance = provider
            .stake_amount
            .checked_sub(provider.locked_stake)
            .unwrap();

        require!(free_balance >= amount, ErrorCode::InsufficientFunds);

        // Update state
        provider.stake_amount = provider.stake_amount.checked_sub(amount).unwrap();

        // Sign with PDA to transfer from vault back to user
        let provider_seeds = &[b"provider", provider.owner.as_ref(), &[provider.bump]];
        let signer = &[&provider_seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.stake_vault.to_account_info(),
                    to: ctx.accounts.owner_token_account.to_account_info(),
                    authority: provider.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;

        emit!(StakeWithdrawn {
            provider: provider.owner,
            amount,
            remaining: provider.stake_amount
        });

        Ok(())
    }

    // --- Deal Lifecycle ---

    /// Proposes a new storage deal.
    /// The Organization deposits the reward amount into a temporary reward vault.
    pub fn propose_deal(
        ctx: Context<ProposeDeal>,
        film_nft_mint: Pubkey,
        reward_amount: u64,
        duration: i64,
    ) -> Result<()> {
        require!(duration > 0, ErrorCode::InvalidDuration);

        let deal = &mut ctx.accounts.deal;
        deal.organization = ctx.accounts.organization_admin.key();
        deal.film_mint = film_nft_mint;
        deal.reward_amount = reward_amount;
        deal.duration = duration;
        deal.status = DealStatus::Pending;
        deal.creation_time = Clock::get()?.unix_timestamp;
        deal.bump = ctx.bumps.deal;

        // Transfer reward from Org to Deal Vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.org_token_account.to_account_info(),
                    to: ctx.accounts.reward_vault.to_account_info(),
                    authority: ctx.accounts.organization_admin.to_account_info(),
                },
            ),
            reward_amount,
        )?;

        emit!(DealProposed {
            deal: deal.key(),
            organization: deal.organization,
            film_mint: film_nft_mint,
            reward: reward_amount
        });

        Ok(())
    }

    /// Cancels a Pending deal and refunds the Organization.
    /// Also closes the reward vault to reclaim rent (SOL).
    pub fn cancel_deal(ctx: Context<CancelDeal>) -> Result<()> {
        let deal = &mut ctx.accounts.deal;
        require!(
            deal.status == DealStatus::Pending,
            ErrorCode::DealNotPending
        );

        let deal_seeds = &[
            b"deal",
            deal.film_mint.as_ref(),
            deal.organization.as_ref(),
            &[deal.bump],
        ];
        let signer = &[&deal_seeds[..]];

        // 1. Refund Tokens to Organization
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.reward_vault.to_account_info(),
                    to: ctx.accounts.org_token_account.to_account_info(),
                    authority: deal.to_account_info(),
                },
                signer,
            ),
            deal.reward_amount,
        )?;

        // 2. Close the Token Vault Account (Recover Rent to Admin)
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.reward_vault.to_account_info(),
                destination: ctx.accounts.organization_admin.to_account_info(),
                authority: deal.to_account_info(),
            },
            signer,
        ))?;

        emit!(DealCancelled { deal: deal.key() });

        Ok(())
    }

    /// A Provider accepts a Pending deal.
    /// Validates sufficient free stake and locks the required collateral.
    pub fn accept_deal(ctx: Context<AcceptDeal>) -> Result<()> {
        let deal = &mut ctx.accounts.deal;
        let provider = &mut ctx.accounts.provider;

        require!(
            deal.status == DealStatus::Pending,
            ErrorCode::DealNotPending
        );

        // Calculate if provider has enough free stake (Collateral = Reward Amount)
        let collateral_required = deal.reward_amount;
        let free_balance = provider
            .stake_amount
            .checked_sub(provider.locked_stake)
            .unwrap();

        require!(
            free_balance >= collateral_required,
            ErrorCode::InsufficientStake
        );

        // Lock the stake
        provider.locked_stake = provider
            .locked_stake
            .checked_add(collateral_required)
            .unwrap();

        // Update Deal State
        deal.provider = Some(ctx.accounts.provider_owner.key());
        deal.start_time = Clock::get()?.unix_timestamp;
        deal.status = DealStatus::Active;

        emit!(DealAccepted {
            deal: deal.key(),
            provider: provider.owner,
            start_time: deal.start_time
        });

        Ok(())
    }

    /// Verifies the deal completion (via Oracle/Authority) and releases payment.
    /// Unlocks the provider's stake, pays the provider, and closes the reward vault.
    pub fn verify_and_release_payment(ctx: Context<VerifyAndRelease>) -> Result<()> {
        let deal = &mut ctx.accounts.deal;
        let provider = &mut ctx.accounts.provider;

        require!(deal.status == DealStatus::Active, ErrorCode::DealNotActive);
        require!(
            deal.provider == Some(provider.owner),
            ErrorCode::WrongProvider
        );

        // Time Check: Ensure duration has passed
        let current_time = Clock::get()?.unix_timestamp;
        let end_time = deal.start_time.checked_add(deal.duration).unwrap();
        require!(current_time >= end_time, ErrorCode::DealNotExpired);

        // Unlock Stake (Release Collateral)
        let collateral_locked = deal.reward_amount;
        provider.locked_stake = provider
            .locked_stake
            .checked_sub(collateral_locked)
            .unwrap();

        // Update Stats
        provider.total_stored += 1;
        provider.successful_deals += 1;

        let deal_seeds = &[
            b"deal",
            deal.film_mint.as_ref(),
            deal.organization.as_ref(),
            &[deal.bump],
        ];
        let signer = &[&deal_seeds[..]];

        // 1. Pay Reward to Provider
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.reward_vault.to_account_info(),
                    to: ctx.accounts.provider_token_account.to_account_info(),
                    authority: deal.to_account_info(),
                },
                signer,
            ),
            deal.reward_amount,
        )?;

        // 2. Close Token Vault (Recover Rent to Authority)
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.reward_vault.to_account_info(),
                destination: ctx.accounts.authority.to_account_info(),
                authority: deal.to_account_info(),
            },
            signer,
        ))?;

        emit!(DealCompleted {
            deal: deal.key(),
            provider: provider.owner
        });

        Ok(())
    }

    /// Slashes a provider for failing a deal.
    /// Forfeits the stake to the DAO Treasury and refunds the original reward to the Organization.
    pub fn slash_provider(ctx: Context<SlashProvider>) -> Result<()> {
        let deal = &mut ctx.accounts.deal;
        let provider = &mut ctx.accounts.provider;

        require!(deal.status == DealStatus::Active, ErrorCode::DealNotActive);
        require!(
            deal.provider == Some(provider.owner),
            ErrorCode::WrongProvider
        );

        let penalty_amount = deal.reward_amount;

        // Reduce total stake and locked stake (burning the collateral)
        provider.locked_stake = provider.locked_stake.checked_sub(penalty_amount).unwrap();
        provider.stake_amount = provider.stake_amount.checked_sub(penalty_amount).unwrap();
        provider.failed_deals += 1;

        let provider_seeds = &[b"provider", provider.owner.as_ref(), &[provider.bump]];
        let provider_signer = &[&provider_seeds[..]];

        // 1. Send Penalty (Stake) to DAO Treasury
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.stake_vault.to_account_info(),
                    to: ctx.accounts.dao_treasury.to_account_info(),
                    authority: provider.to_account_info(),
                },
                provider_signer,
            ),
            penalty_amount,
        )?;

        let deal_seeds = &[
            b"deal",
            deal.film_mint.as_ref(),
            deal.organization.as_ref(),
            &[deal.bump],
        ];
        let deal_signer = &[&deal_seeds[..]];

        // 2. Refund Reward to Organization
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.reward_vault.to_account_info(),
                    to: ctx.accounts.org_refund_account.to_account_info(),
                    authority: deal.to_account_info(),
                },
                deal_signer,
            ),
            deal.reward_amount,
        )?;

        // 3. Close Token Vault (Recover Rent to Authority)
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.reward_vault.to_account_info(),
                destination: ctx.accounts.authority.to_account_info(),
                authority: deal.to_account_info(),
            },
            deal_signer,
        ))?;

        emit!(DealSlashed {
            deal: deal.key(),
            provider: provider.owner,
            slashed_amount: penalty_amount
        });

        Ok(())
    }
}

// --- Events ---

#[event]
pub struct ProviderRegistered {
    pub owner: Pubkey,
    pub stake_amount: u64,
}

#[event]
pub struct StakeDeposited {
    pub provider: Pubkey,
    pub amount: u64,
    pub new_total: u64,
}

#[event]
pub struct StakeWithdrawn {
    pub provider: Pubkey,
    pub amount: u64,
    pub remaining: u64,
}

#[event]
pub struct DealProposed {
    pub deal: Pubkey,
    pub organization: Pubkey,
    pub film_mint: Pubkey,
    pub reward: u64,
}

#[event]
pub struct DealAccepted {
    pub deal: Pubkey,
    pub provider: Pubkey,
    pub start_time: i64,
}

#[event]
pub struct DealCompleted {
    pub deal: Pubkey,
    pub provider: Pubkey,
}

#[event]
pub struct DealCancelled {
    pub deal: Pubkey,
}

#[event]
pub struct DealSlashed {
    pub deal: Pubkey,
    pub provider: Pubkey,
    pub slashed_amount: u64,
}

// --- Contexts ---

#[derive(Accounts)]
pub struct RegisterProvider<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        seeds = [b"provider", owner.key().as_ref()],
        bump,
        payer = owner,
        space = 8 + StorageProviderAccount::INIT_SPACE
    )]
    pub provider: Account<'info, StorageProviderAccount>,

    #[account(mut)]
    pub owner_token_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = owner,
        seeds = [b"stake_vault", provider.key().as_ref()],
        bump,
        token::mint = spiral_coin_mint,
        token::authority = provider,
    )]
    pub stake_vault: Account<'info, TokenAccount>,

    pub spiral_coin_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositStake<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"provider", owner.key().as_ref()],
        bump = provider.bump,
        constraint = provider.owner == owner.key() @ ErrorCode::Unauthorized
    )]
    pub provider: Account<'info, StorageProviderAccount>,

    #[account(
        mut,
        seeds = [b"stake_vault", provider.key().as_ref()],
        bump,
    )]
    pub stake_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub owner_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawStake<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"provider", owner.key().as_ref()],
        bump = provider.bump,
        constraint = provider.owner == owner.key() @ ErrorCode::Unauthorized
    )]
    pub provider: Account<'info, StorageProviderAccount>,

    #[account(
        mut,
        seeds = [b"stake_vault", provider.key().as_ref()],
        bump,
    )]
    pub stake_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub owner_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(film_nft_mint: Pubkey)]
pub struct ProposeDeal<'info> {
    #[account(mut)]
    pub organization_admin: Signer<'info>,

    #[account(
        init,
        seeds = [b"deal", film_nft_mint.as_ref(), organization_admin.key().as_ref()],
        bump,
        payer = organization_admin,
        space = 8 + StorageDealAccount::INIT_SPACE
    )]
    pub deal: Account<'info, StorageDealAccount>,

    #[account(mut)]
    pub org_token_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = organization_admin,
        seeds = [b"reward_vault", deal.key().as_ref()],
        bump,
        token::mint = spiral_coin_mint,
        token::authority = deal,
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    pub spiral_coin_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct CancelDeal<'info> {
    #[account(mut)]
    pub organization_admin: Signer<'info>,

    #[account(
        mut,
        constraint = deal.organization == organization_admin.key() @ ErrorCode::Unauthorized,
        close = organization_admin // Recover rent to org admin
    )]
    pub deal: Account<'info, StorageDealAccount>,

    #[account(mut)]
    pub org_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"reward_vault", deal.key().as_ref()],
        bump
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AcceptDeal<'info> {
    #[account(mut)]
    pub provider_owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"provider", provider_owner.key().as_ref()],
        bump = provider.bump,
        constraint = provider.owner == provider_owner.key() @ ErrorCode::Unauthorized
    )]
    pub provider: Account<'info, StorageProviderAccount>,

    #[account(mut)]
    pub deal: Account<'info, StorageDealAccount>,
}

#[derive(Accounts)]
pub struct VerifyAndRelease<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        constraint = deal.organization == authority.key() @ ErrorCode::Unauthorized,
        close = authority // Recover rent to authority
    )]
    pub deal: Account<'info, StorageDealAccount>,

    #[account(mut)]
    pub provider: Account<'info, StorageProviderAccount>,

    #[account(
        mut,
        seeds = [b"reward_vault", deal.key().as_ref()],
        bump
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub provider_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SlashProvider<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        constraint = deal.organization == authority.key() @ ErrorCode::Unauthorized,
        close = authority // Recover rent to authority
    )]
    pub deal: Account<'info, StorageDealAccount>,

    #[account(mut)]
    pub provider: Account<'info, StorageProviderAccount>,

    #[account(
        mut,
        seeds = [b"stake_vault", provider.key().as_ref()],
        bump
    )]
    pub stake_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"reward_vault", deal.key().as_ref()],
        bump
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub dao_treasury: Account<'info, TokenAccount>,

    #[account(mut)]
    pub org_refund_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct StorageProviderAccount {
    pub owner: Pubkey,
    pub stake_amount: u64,
    pub locked_stake: u64,
    pub total_stored: u64,
    pub successful_deals: u64,
    pub failed_deals: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct StorageDealAccount {
    pub organization: Pubkey,
    pub film_mint: Pubkey,
    pub provider: Option<Pubkey>,
    pub reward_amount: u64,
    pub duration: i64,
    pub start_time: i64,
    pub creation_time: i64,
    pub status: DealStatus,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum DealStatus {
    Pending,
    Active,
}

#[error_code]
pub enum ErrorCode {
    #[msg("You are not authorized to perform this action.")]
    Unauthorized,
    #[msg("The deal is not in Pending status.")]
    DealNotPending,
    #[msg("The deal is not in Active status.")]
    DealNotActive,
    #[msg("Provider does not have enough FREE stake to collateralize this deal.")]
    InsufficientStake,
    #[msg("The provider in the deal does not match the account provided.")]
    WrongProvider,
    #[msg("Insufficient funds in the stake vault (Locked + Free).")]
    InsufficientFunds,
    #[msg("The duration of the deal has not expired yet.")]
    DealNotExpired,
    #[msg("Duration must be greater than zero.")]
    InvalidDuration,
}
