use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::spl_associated_token_account::solana_program::program::invoke_signed;
use anchor_spl::token_2022::spl_token_2022::extension::ExtensionType;
use anchor_spl::token_2022::spl_token_2022::instruction::AuthorityType;
use anchor_spl::token_2022::spl_token_2022::{self};
use anchor_spl::{
    associated_token::{self, spl_associated_token_account::solana_program::program::invoke},
    token_2022::{self, Token2022},
};
use organization::cpi::accounts::FilmCountCPI;
use organization::program::Organization as OrganizationProgram;
use organization::{self, MemberAccount, OrganizationAccount, Role};

declare_id!("2YBAqZiFW4ctjvdDGY9NNa954Cf5KJ1oSCmgs2Nt6Mjy");

#[program]
pub mod film {
    use super::*;

    /// Mints a new NFT representing a film.
    pub fn mint_film(
        ctx: Context<MintFilm>,
        name: String,
        symbol: String,
        uri: String,
        file_hash: String,
    ) -> Result<()> {
        // Create Mint Account with Extensions
        create_mint_account(
            &ctx.accounts.signer,
            &ctx.accounts.mint,
            &ctx.accounts.token_program,
        )?;

        // Initialize Mint Close Authority (to reclaim rent later)
        let init_close_auth_ix: anchor_lang::prelude::instruction::Instruction =
            spl_token_2022::instruction::initialize_mint_close_authority(
                &Token2022::id(),
                &ctx.accounts.mint.key(),
                Some(&ctx.accounts.nft_authority.key()),
            )?;

        invoke(
            &init_close_auth_ix,
            &[
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.nft_authority.to_account_info(),
            ],
        )?;

        // Initialize Metadata Pointer
        let init_meta_data_pointer_ix: anchor_lang::prelude::instruction::Instruction =
            spl_token_2022::extension::metadata_pointer::instruction::initialize(
                &Token2022::id(),
                &ctx.accounts.mint.key(),
                Some(ctx.accounts.nft_authority.key()),
                Some(ctx.accounts.mint.key()),
            )
            .unwrap();

        invoke(
            &init_meta_data_pointer_ix,
            &[
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.nft_authority.to_account_info(),
            ],
        )?;

        // Initialize the Mint (Standard Token2022)
        token_2022::initialize_mint2(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token_2022::InitializeMint2 {
                    mint: ctx.accounts.mint.to_account_info(),
                },
            ),
            0,
            &ctx.accounts.nft_authority.key(),
            None,
        )?;

        // Initialize Metadata via Interface
        let org_key: Pubkey = ctx.accounts.organization.key();

        let bump_auth: u8 = ctx.bumps.nft_authority;
        let nft_seeds_inner: &[&[u8]] = &[b"nft_authority", org_key.as_ref(), &[bump_auth]];
        let nft_seeds: &[&[&[u8]]; 1] = &[nft_seeds_inner];

        let init_token_meta_data_ix: &anchor_lang::prelude::instruction::Instruction =
            &spl_token_metadata_interface::instruction::initialize(
                &spl_token_2022::id(),
                ctx.accounts.mint.key,
                ctx.accounts.nft_authority.key,
                ctx.accounts.mint.key,
                ctx.accounts.nft_authority.key,
                name.clone(),
                symbol.clone(),
                uri.clone(),
            );

        invoke_signed(
            init_token_meta_data_ix,
            &[
                ctx.accounts.mint.to_account_info().clone(),
                ctx.accounts.nft_authority.to_account_info().clone(),
            ],
            nft_seeds,
        )?;

        // Add Custom Fields (Organization ID & File Hash)
        invoke_signed(
            &spl_token_metadata_interface::instruction::update_field(
                &spl_token_2022::id(),
                ctx.accounts.mint.key,
                ctx.accounts.nft_authority.key,
                spl_token_metadata_interface::state::Field::Key("organization_key".to_string()),
                ctx.accounts.organization.key().to_string(),
            ),
            &[
                ctx.accounts.mint.to_account_info().clone(),
                ctx.accounts.nft_authority.to_account_info().clone(),
            ],
            nft_seeds,
        )?;

        invoke_signed(
            &spl_token_metadata_interface::instruction::update_field(
                &spl_token_2022::id(),
                ctx.accounts.mint.key,
                ctx.accounts.nft_authority.key,
                spl_token_metadata_interface::state::Field::Key("file_hash".to_string()),
                file_hash.clone(),
            ),
            &[
                ctx.accounts.mint.to_account_info().clone(),
                ctx.accounts.nft_authority.to_account_info().clone(),
            ],
            nft_seeds,
        )?;

        let current_time: String = Clock::get()?.unix_timestamp.to_string();

        invoke_signed(
            &spl_token_metadata_interface::instruction::update_field(
                &spl_token_2022::id(),
                ctx.accounts.mint.key,
                ctx.accounts.nft_authority.key,
                spl_token_metadata_interface::state::Field::Key("inclusion_date".to_string()),
                current_time,
            ),
            &[
                ctx.accounts.mint.to_account_info().clone(),
                ctx.accounts.nft_authority.to_account_info().clone(),
            ],
            nft_seeds,
        )?;

        // Mint the Token
        associated_token::create(CpiContext::new(
            ctx.accounts.associated_token_program.to_account_info(),
            associated_token::Create {
                payer: ctx.accounts.signer.to_account_info(),
                associated_token: ctx.accounts.token_account.to_account_info(),
                authority: ctx.accounts.signer.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ))?;

        token_2022::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token_2022::MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.token_account.to_account_info(),
                    authority: ctx.accounts.nft_authority.to_account_info(),
                },
                nft_seeds,
            ),
            1,
        )?;

        // Remove Mint Authority (Make Supply Fixed)
        token_2022::set_authority(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token_2022::SetAuthority {
                    current_authority: ctx.accounts.nft_authority.to_account_info(),
                    account_or_mint: ctx.accounts.mint.to_account_info(),
                },
                nft_seeds,
            ),
            AuthorityType::MintTokens,
            None,
        )?;

        // Increment Organization Counter (CPI)
        let bump_signer: u8 = ctx.bumps.program_signer;
        let signer_seeds_inner: &[&[u8]] = &[b"signer", &[bump_signer]];
        let cpi_signer_seeds: &[&[&[u8]]] = &[signer_seeds_inner];

        organization::cpi::increment_film_count(ctx.accounts.into_cpi_context(cpi_signer_seeds))?;

        // Emit Event for Backend
        emit!(FilmMinted {
            org_id: ctx.accounts.organization.org_id,
            mint: ctx.accounts.mint.key(),
            name: name,
            file_hash: file_hash,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Updates the metadata URI of an existing film NFT.
    pub fn update_film_metadata(ctx: Context<UpdateFilmMetadata>, new_uri: String) -> Result<()> {
        require!(
            !new_uri.is_empty() && new_uri.len() <= 200,
            ErrorCode::InvalidUriLength
        );

        let org_key: Pubkey = ctx.accounts.organization.key();

        let bump_auth: u8 = ctx.bumps.nft_authority;
        let nft_seeds_inner: &[&[u8]] = &[b"nft_authority", org_key.as_ref(), &[bump_auth]];
        let nft_seeds: &[&[&[u8]]; 1] = &[nft_seeds_inner];

        invoke_signed(
            &spl_token_metadata_interface::instruction::update_field(
                &spl_token_2022::id(),
                &ctx.accounts.mint.key(),
                ctx.accounts.nft_authority.key,
                spl_token_metadata_interface::state::Field::Uri,
                new_uri.clone(),
            ),
            &[
                ctx.accounts.mint.to_account_info().clone(),
                ctx.accounts.nft_authority.to_account_info().clone(),
            ],
            nft_seeds,
        )?;

        emit!(FilmMetadataUpdated {
            mint: ctx.accounts.mint.key(),
            new_uri: new_uri,
        });

        Ok(())
    }

    /// Burns an existing film NFT.
    pub fn burn_film(ctx: Context<BurnFilm>) -> Result<()> {
        // Burn Token
        token_2022::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token_2022::Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.token_account.to_account_info(),
                    authority: ctx.accounts.signer.to_account_info(),
                },
            ),
            1,
        )?;

        // Close Token Account (Reclaim Rent)
        token_2022::close_account(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token_2022::CloseAccount {
                account: ctx.accounts.token_account.to_account_info(),
                destination: ctx.accounts.signer.to_account_info(),
                authority: ctx.accounts.signer.to_account_info(),
            },
        ))?;

        // Close Mint Account (Reclaim Rent)
        let org_key: Pubkey = ctx.accounts.organization.key();

        let bump_auth: u8 = ctx.bumps.nft_authority;
        let nft_seeds_inner: &[&[u8]] = &[b"nft_authority", org_key.as_ref(), &[bump_auth]];
        let nft_seeds: &[&[&[u8]]; 1] = &[nft_seeds_inner];

        token_2022::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token_2022::CloseAccount {
                account: ctx.accounts.mint.to_account_info(),
                destination: ctx.accounts.signer.to_account_info(),
                authority: ctx.accounts.nft_authority.to_account_info(),
            },
            nft_seeds,
        ))?;

        // Decrement Organization Counter (CPI)
        let bump_signer: u8 = ctx.bumps.program_signer;
        let signer_seeds_inner: &[&[u8]] = &[b"signer", &[bump_signer]];
        let cpi_signer_seeds: &[&[&[u8]]; 1] = &[signer_seeds_inner];

        organization::cpi::decrement_film_count(ctx.accounts.into_cpi_context(cpi_signer_seeds))?;

        emit!(FilmBurned {
            mint: ctx.accounts.mint.key(),
            org_id: ctx.accounts.organization.org_id,
        });

        Ok(())
    }
}

// --- Helpers ---

fn create_mint_account<'info>(
    signer: &Signer<'info>,
    mint: &Signer<'info>,
    token_program: &Program<'info, Token2022>,
) -> Result<()> {
    const NAME_SIZE: usize = 32;
    const SYMBOL_SIZE: usize = 10;
    const URI_SIZE: usize = 200;
    const ORG_KEY_SIZE: usize = 32;
    const HASH_SIZE: usize = 64;
    const TIMESTAMP_SIZE: usize = 16;

    let extensions: &[ExtensionType; 2] = &[
        ExtensionType::MetadataPointer,
        ExtensionType::MintCloseAuthority,
    ];

    let base_mint_len: usize = ExtensionType::try_calculate_account_len::<
        anchor_spl::token_2022::spl_token_2022::state::Mint,
    >(extensions)?;

    let metadata_extra_len: usize = 4
        + NAME_SIZE
        + 4
        + SYMBOL_SIZE
        + 4
        + URI_SIZE
        + 4
        + ORG_KEY_SIZE
        + 4
        + HASH_SIZE
        + 4
        + TIMESTAMP_SIZE
        + 100;

    let total_space: usize = base_mint_len + metadata_extra_len;
    let lamports_required: u64 = Rent::get()?.minimum_balance(total_space);

    system_program::create_account(
        CpiContext::new(
            token_program.to_account_info(),
            system_program::CreateAccount {
                from: signer.to_account_info(),
                to: mint.to_account_info(),
            },
        ),
        lamports_required,
        base_mint_len as u64,
        &token_program.key(),
    )?;

    system_program::assign(
        CpiContext::new(
            token_program.to_account_info(),
            system_program::Assign {
                account_to_assign: mint.to_account_info(),
            },
        ),
        &token_2022::ID,
    )?;

    Ok(())
}

impl<'info> MintFilm<'info> {
    fn into_cpi_context<'a>(
        &self,
        signer_seeds: &'a [&'a [&'a [u8]]],
    ) -> CpiContext<'a, 'a, 'a, 'info, FilmCountCPI<'info>> {
        let cpi_program: AccountInfo<'_> = self.organization_program.to_account_info();
        let cpi_accounts: FilmCountCPI<'_> = FilmCountCPI {
            organization: self.organization.to_account_info(),
            program_signer: self.program_signer.to_account_info(),
            film_program: self.film_account.to_account_info(),
        };
        CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds)
    }
}

impl<'info> BurnFilm<'info> {
    fn into_cpi_context<'a>(
        &self,
        signer_seeds: &'a [&'a [&'a [u8]]],
    ) -> CpiContext<'a, 'a, 'a, 'info, FilmCountCPI<'info>> {
        let cpi_program: AccountInfo<'_> = self.organization_program.to_account_info();
        let cpi_accounts: FilmCountCPI<'_> = FilmCountCPI {
            organization: self.organization.to_account_info(),
            program_signer: self.program_signer.to_account_info(),
            film_program: self.film_account.to_account_info(),
        };
        CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds)
    }
}

// --- Events ---

#[event]
pub struct FilmMinted {
    pub org_id: u64,
    pub mint: Pubkey,
    pub name: String,
    pub file_hash: String,
    pub timestamp: i64,
}

#[event]
pub struct FilmMetadataUpdated {
    pub mint: Pubkey,
    pub new_uri: String,
}

#[event]
pub struct FilmBurned {
    pub mint: Pubkey,
    pub org_id: u64,
}

// --- Contexts ---

#[derive(Accounts)]
pub struct MintFilm<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(mut)]
    pub organization: Account<'info, OrganizationAccount>,

    #[account(
        constraint = member.org == organization.key() @ organization::ErrorCode::Unauthorized,
        constraint = member.wallet == signer.key() @ organization::ErrorCode::Unauthorized,
        constraint = member.role == (Role::Admin as u8) || member.role == (Role::Uploader as u8)
            @ organization::ErrorCode::Unauthorized
    )]
    pub member: Account<'info, MemberAccount>,

    pub organization_program: Program<'info, OrganizationProgram>,

    /// CHECK: PDA signer controlled by the program (used for CPI).
    #[account(mut, seeds = [b"signer"], bump)]
    pub program_signer: UncheckedAccount<'info>,

    /// CHECK: The program ID of the Film program.
    #[account(address = crate::ID)]
    pub film_account: UncheckedAccount<'info>,

    /// CHECK: PDA for the NFT authority.
    #[account(seeds = [b"nft_authority", organization.key().as_ref()], bump)]
    pub nft_authority: UncheckedAccount<'info>,

    /// Mint account (Keypair)
    #[account(mut, signer)]
    pub mint: Signer<'info>,

    /// CHECK: Associated Token Account
    #[account(mut)]
    pub token_account: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(new_uri: String)]
pub struct UpdateFilmMetadata<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(mut)]
    pub organization: Account<'info, OrganizationAccount>,

    #[account(
        constraint = member.org == organization.key() @ organization::ErrorCode::Unauthorized,
        constraint = member.wallet == signer.key() @ organization::ErrorCode::Unauthorized,
        constraint = member.role == (Role::Admin as u8) || member.role == (Role::Uploader as u8)
            @ organization::ErrorCode::Unauthorized
    )]
    pub member: Account<'info, MemberAccount>,

    /// CHECK: PDA for the NFT authority.
    #[account(seeds = [b"nft_authority", organization.key().as_ref()], bump)]
    pub nft_authority: UncheckedAccount<'info>,

    /// CHECK: Mint account of the NFT.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct BurnFilm<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(mut)]
    pub organization: Account<'info, OrganizationAccount>,

    #[account(
        constraint = member.org == organization.key() @ organization::ErrorCode::Unauthorized,
        constraint = member.wallet == signer.key() @ organization::ErrorCode::Unauthorized,
        constraint = member.role == (Role::Admin as u8)
            @ organization::ErrorCode::Unauthorized
    )]
    pub member: Account<'info, MemberAccount>,

    pub organization_program: Program<'info, OrganizationProgram>,

    /// CHECK: PDA used as a signer for the decrement CPI.
    #[account(mut, seeds = [b"signer"], bump)]
    pub program_signer: UncheckedAccount<'info>,

    /// CHECK: The program ID of the Film program.
    #[account(address = crate::ID)]
    pub film_account: UncheckedAccount<'info>,

    /// CHECK: PDA for the NFT authority.
    #[account(seeds = [b"nft_authority", organization.key().as_ref()], bump)]
    pub nft_authority: UncheckedAccount<'info>,

    /// CHECK: User's Associated Token Account.
    #[account(mut)]
    pub token_account: UncheckedAccount<'info>,

    /// CHECK: The Mint account of the NFT.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token2022>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("URI must be between 1 and 200 characters.")]
    InvalidUriLength,
    #[msg("This NFT does not belong to your organization.")]
    OrganizationMismatch,
    #[msg("Could not find the organization_key in the NFT metadata.")]
    MetadataFieldNotFound,
    #[msg("The organization_key in the NFT metadata is corrupted.")]
    InvalidOrganizationKey,
}
