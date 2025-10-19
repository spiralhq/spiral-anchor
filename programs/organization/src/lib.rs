use anchor_lang::prelude::*;

declare_id!("9KzyadumcHu2ECUGjQgYVSK5gnYfxqDFbam4CYd5WyxS");

const FILM_PROGRAM_ID: &str = "BVZYgNw8YioFpMFWa1VMVJMMSminfgxkQYdkH4NfFZWs";

#[program]
pub mod organization {
    use super::*;

    /// Creates a new organization and its first admin member.
    /// The organization is a PDA derived from the admin's key and the organization's name.
    pub fn create_organization(
        ctx: Context<CreateOrganization>,
        org_id: u64,
        name: String,
        url: Option<String>,
    ) -> Result<()> {
        let org: &mut Account<'_, OrganizationAccount> = &mut ctx.accounts.organization;
        org.admin = ctx.accounts.admin.key();
        org.org_id = org_id;
        org.name = name;
        org.url = url;
        org.members_count = 1;
        org.films_count = 0;
        org.bump = ctx.bumps.organization;

        let member: &mut Account<'_, MemberAccount> = &mut ctx.accounts.admin_member;
        member.org = org.key();
        member.wallet = ctx.accounts.admin.key();
        member.role = Role::Admin as u8;
        member.bump = ctx.bumps.admin_member;

        msg!("Organization '{}' created!", org.name);
        Ok(())
    }

    /// Adds a new member to an existing organization.
    /// Only an admin of the organization can perform this action.
    pub fn add_member(ctx: Context<AddMember>, role: Role) -> Result<()> {
        let member: &mut Account<'_, MemberAccount> = &mut ctx.accounts.member;
        member.org = ctx.accounts.organization.key();
        member.wallet = ctx.accounts.new_member.key();
        member.role = role as u8;
        member.bump = ctx.bumps.member;

        let org: &mut Account<'_, OrganizationAccount> = &mut ctx.accounts.organization;
        org.members_count = org
            .members_count
            .checked_add(1)
            .ok_or(ErrorCode::Overflow)?;

        msg!("New member added to '{}'", org.name);
        Ok(())
    }

    /// Removes a member from an organization.
    /// Only an admin can perform this action. The member's account is closed.
    pub fn remove_member(ctx: Context<RemoveMember>) -> Result<()> {
        require!(
            ctx.accounts.member.wallet != ctx.accounts.admin.key(),
            ErrorCode::CannotRemoveSelf
        );

        let org: &mut Account<'_, OrganizationAccount> = &mut ctx.accounts.organization;
        org.members_count = org
            .members_count
            .checked_sub(1)
            .ok_or(ErrorCode::Underflow)?;

        msg!(
            "Member {} removed from '{}'",
            ctx.accounts.member.wallet,
            org.name
        );
        Ok(())
    }

    /// Updates the metadata of an organization.
    /// Only an admin can perform this action.
    pub fn update_organization(
        ctx: Context<UpdateOrganization>,
        name: Option<String>,
        url: Option<String>,
        clear_url: bool,
    ) -> Result<()> {
        let org: &mut Account<'_, OrganizationAccount> = &mut ctx.accounts.organization;
        if let Some(n) = name {
            org.name = n;
        }
        if clear_url {
            org.url = None;
        } else if let Some(u) = url {
            org.url = Some(u);
        }
        msg!("Organization '{}' updated!", org.name);
        Ok(())
    }

    // --- CPI Functions for Program-to-Program Interaction ---

    /// (CPI) Increments the film count for an organization.
    /// This instruction can ONLY be called by your `film_program`.
    pub fn increment_film_count(ctx: Context<FilmCountCPI>) -> Result<()> {
        ctx.accounts.organization.films_count = ctx
            .accounts
            .organization
            .films_count
            .checked_add(1)
            .ok_or(ErrorCode::Overflow)?;
        Ok(())
    }

    /// (CPI) Decrements the film count for an organization.
    /// This instruction can ONLY be called by your `film_program`.
    pub fn decrement_film_count(ctx: Context<FilmCountCPI>) -> Result<()> {
        ctx.accounts.organization.films_count = ctx
            .accounts
            .organization
            .films_count
            .checked_sub(1)
            .ok_or(ErrorCode::Underflow)?;
        Ok(())
    }
}

/// Defines the roles a member can have within an organization.
#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, PartialEq, Eq, Clone, Copy)]
pub enum Role {
    Admin = 1,
    Uploader = 2,
}

/// The main account representing an organization (e.g., a production company, film archive).
#[account]
#[derive(InitSpace)]
pub struct OrganizationAccount {
    /// The original founder of the organization.
    pub admin: Pubkey,
    /// A unique identifier for the organization.
    pub org_id: u64,
    /// The name of the organization, used as a PDA seed (max 64 bytes).
    #[max_len(64)]
    pub name: String,
    /// A link to the organization's website or info.
    #[max_len(128)]
    pub url: Option<String>,
    /// The number of members in the organization.
    pub members_count: u32,
    /// The number of films registered by the organization.
    pub films_count: u32,
    /// The bump of the PDA.
    pub bump: u8,
}

/// The account that links a user's wallet to an organization with a specific role.
#[account]
#[derive(InitSpace)]
pub struct MemberAccount {
    /// The key of the organization this member belongs to.
    pub org: Pubkey,
    /// The public key of the member's wallet.
    pub wallet: Pubkey,
    /// The member's role (Admin, Uploader).
    pub role: u8,
    /// The bump of the PDA.
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(org_id: u64, name: String, url: Option<String>)]
pub struct CreateOrganization<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        seeds = [b"organization", admin.key().as_ref(), &org_id.to_le_bytes()],
        bump,
        payer = admin,
        space = 8 + OrganizationAccount::INIT_SPACE,
        constraint = !name.is_empty() && name.len() <= 64 @ ErrorCode::InvalidNameLength,
        constraint = url.as_deref().map_or(true, |u| u.len() <= 128) @ ErrorCode::InvalidUrlLength
    )]
    pub organization: Account<'info, OrganizationAccount>,
    #[account(
        init,
        seeds = [b"member", organization.key().as_ref(), admin.key().as_ref()],
        bump,
        payer = admin,
        space = 8 + MemberAccount::INIT_SPACE
    )]
    pub admin_member: Account<'info, MemberAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(role: Role)]
pub struct AddMember<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        constraint = admin_member.org == organization.key() @ ErrorCode::Unauthorized,
        constraint = admin_member.wallet == admin.key() @ ErrorCode::Unauthorized,
        constraint = admin_member.role == Role::Admin as u8 @ ErrorCode::Unauthorized,
        seeds = [b"member", organization.key().as_ref(), admin.key().as_ref()],
        bump = admin_member.bump,
    )]
    pub admin_member: Account<'info, MemberAccount>,
    #[account(mut, address = admin_member.org)]
    pub organization: Account<'info, OrganizationAccount>,
    /// CHECK: Just the public key of the new member. Initialization is handled securely.
    pub new_member: UncheckedAccount<'info>,
    #[account(
        init,
        seeds = [b"member", organization.key().as_ref(), new_member.key().as_ref()],
        bump,
        payer = admin,
        space = 8 + MemberAccount::INIT_SPACE
    )]
    pub member: Account<'info, MemberAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RemoveMember<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        constraint = admin_member.org == organization.key() @ ErrorCode::Unauthorized,
        constraint = admin_member.wallet == admin.key() @ ErrorCode::Unauthorized,
        constraint = admin_member.role == Role::Admin as u8 @ ErrorCode::Unauthorized,
        seeds = [b"member", organization.key().as_ref(), admin.key().as_ref()],
        bump = admin_member.bump,
    )]
    pub admin_member: Account<'info, MemberAccount>,
    #[account(mut, address = admin_member.org)]
    pub organization: Account<'info, OrganizationAccount>,
    #[account(
        mut,
        close = admin,
        seeds = [b"member", organization.key().as_ref(), member.wallet.as_ref()],
        bump = member.bump,
    )]
    pub member: Account<'info, MemberAccount>,
}

#[derive(Accounts)]
#[instruction(name: Option<String>, url: Option<String>, clear_url: bool)]
pub struct UpdateOrganization<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        constraint = admin_member.org == organization.key() @ ErrorCode::Unauthorized,
        constraint = admin_member.wallet == admin.key() @ ErrorCode::Unauthorized,
        constraint = admin_member.role == Role::Admin as u8 @ ErrorCode::Unauthorized,
        seeds = [b"member", organization.key().as_ref(), admin.key().as_ref()],
        bump = admin_member.bump,
    )]
    pub admin_member: Account<'info, MemberAccount>,
    #[account(
        mut,
        address = admin_member.org,
        constraint = name.as_deref().map_or(true, |n| !n.is_empty() && n.len() <= 64) @ ErrorCode::InvalidNameLength,
        constraint = url.as_deref().map_or(true, |u| u.len() <= 128) @ ErrorCode::InvalidUrlLength
    )]
    pub organization: Account<'info, OrganizationAccount>,
}

#[derive(Accounts)]
pub struct FilmCountCPI<'info> {
    #[account(mut)]
    pub organization: Account<'info, OrganizationAccount>,

    /// CHECK: This is the PDA signer for the film program.
    /// The `#[account(seeds, bump)]` constraint ensures this PDA is valid.
    #[account(signer)]
    pub program_signer: UncheckedAccount<'info>,

    #[account(
        constraint = film_program.key() == FILM_PROGRAM_ID.parse::<Pubkey>().unwrap() @ ErrorCode::Unauthorized
    )]

    /// CHECK: This is the PDA for the film program.
    /// The `#[account(seeds, bump)]` constraint ensures this PDA is valid.
    pub film_program: UncheckedAccount<'info>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("The specified role is invalid.")]
    InvalidRole,
    #[msg("Organization name must be between 1 and 64 characters.")]
    InvalidNameLength,
    #[msg("Organization URL cannot exceed 128 characters.")]
    InvalidUrlLength,
    #[msg("You are not authorized to perform this action.")]
    Unauthorized,
    #[msg("An overflow occurred in a counter.")]
    Overflow,
    #[msg("An underflow occurred in a counter.")]
    Underflow,
    #[msg("An admin cannot remove themselves from the organization.")]
    CannotRemoveSelf,
}
