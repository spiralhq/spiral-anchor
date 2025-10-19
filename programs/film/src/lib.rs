use anchor_lang::prelude::*;

// Imports from the `organization` program crate, allowing this program to use its accounts and instructions.
use organization::cpi::accounts::FilmCountCPI;
use organization::program::Organization as OrganizationProgram;
use organization::{self, MemberAccount, OrganizationAccount, Role};

// The unique on-chain address of this program.
declare_id!("BVZYgNw8YioFpMFWa1VMVJMMSminfgxkQYdkH4NfFZWs");

#[program]
pub mod film {
    use super::*;

    /// Registers a "film" by invoking a CPI to increment the organization's film counter.
    /// This instruction serves as a foundational example of authorization and cross-program
    /// communication between the `film` and `organization` programs.
    pub fn register_film(ctx: Context<RegisterFilm>) -> Result<()> {
        msg!("Calling the organization program to increment film count...");

        // Prepare the accounts for the Cross-Program Invocation (CPI).
        let cpi_program: AccountInfo<'_> = ctx.accounts.organization_program.to_account_info();
        let cpi_accounts: FilmCountCPI<'_> = FilmCountCPI {
            organization: ctx.accounts.organization.to_account_info(),
            program_signer: ctx.accounts.program_signer.to_account_info(),
            film_program: ctx.accounts.film_account.to_account_info(),
        };

        // Prepare the PDA signer seeds for the CPI call.
        // The `film` program uses its PDA signer to authorize the call.
        let seeds: &[&[u8]; 2] = &[&b"signer"[..], &[ctx.bumps.program_signer]];
        let signer_seeds: &[&[&[u8]]; 1] = &[&seeds[..]];

        // Create the CpiContext with the signer.
        let cpi_context: CpiContext<'_, '_, '_, '_, FilmCountCPI<'_>> =
            CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

        // Execute the `increment_film_count` instruction on the `organization` program.
        organization::cpi::increment_film_count(cpi_context)?;

        msg!("Film count incremented successfully!");
        Ok(())
    }
}

/// Defines the accounts required for the `register_film` instruction.
#[derive(Accounts)]
pub struct RegisterFilm<'info> {
    /// The user (typically an uploader or admin) initiating the transaction.
    /// They must sign and pay for the transaction fees.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The organization account to which the film belongs. Its `films_count` will be incremented.
    #[account(mut)]
    pub organization: Account<'info, OrganizationAccount>,

    /// The member account that proves the `payer` has the authority (Admin or Uploader role)
    /// to register a film on behalf of the `organization`.
    #[account(
        constraint = member.org == organization.key() @ organization::ErrorCode::Unauthorized,
        constraint = member.wallet == payer.key() @ organization::ErrorCode::Unauthorized,
        constraint = member.role == (Role::Admin as u8) || member.role == (Role::Uploader as u8) @ organization::ErrorCode::Unauthorized
    )]
    pub member: Account<'info, MemberAccount>,

    /// A reference to the on-chain `organization` program, which will be called via CPI.
    pub organization_program: Program<'info, OrganizationProgram>,

    /// A Program Derived Address (PDA) that acts as the `film` program's official signer
    /// for CPI calls. Its authority is derived from this program's ID, ensuring other
    /// programs can trust calls signed by it.
    #[account(mut, seeds = [b"signer"], bump)]
    /// CHECK: This is a PDA signer for the film program. Its validity is checked by the seeds and bump.
    pub program_signer: UncheckedAccount<'info>,

    /// A reference to this program itself (`film` program), required by the `organization_program`
    /// to verify the identity of the caller via constraints.
    #[account(address = crate::ID)]
    pub film_account: Program<'info, crate::program::Film>,
}
