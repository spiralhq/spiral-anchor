use anchor_lang::prelude::*;

declare_id!("G3dimoTwD7jYSTh1pjb528jM5BjD5VUwkjywpWqqMDgp");

#[program]
pub mod organization {
    use super::*;

    /// Creates a new organization and its first admin member.
    pub fn create_organization(
        ctx: Context<CreateOrganization>,
        org_id: u64,
        name: String,
        url: Option<String>,
        film_program_id: Pubkey,
    ) -> Result<()> {
        let org: &mut Account<'_, OrganizationAccount> = &mut ctx.accounts.organization;
        org.admin = ctx.accounts.admin.key();
        org.org_id = org_id;
        org.name = name;
        org.url = url;
        org.authorized_film_program = film_program_id;
        org.members_count = 1;
        org.films_count = 0;
        org.bump = ctx.bumps.organization;

        let member: &mut Account<'_, MemberAccount> = &mut ctx.accounts.admin_member;
        member.org = org.key();
        member.wallet = ctx.accounts.admin.key();
        member.role = Role::Admin as u8;
        member.bump = ctx.bumps.admin_member;

        emit!(OrganizationCreated {
            org_id,
            admin: ctx.accounts.admin.key(),
            name: org.name.clone(),
        });

        Ok(())
    }

    /// Adds a new member to an existing organization.
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

        msg!("New member added: {}", member.wallet);
        Ok(())
    }

    /// Removes a member from an organization.
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

        msg!("Member removed: {}", ctx.accounts.member.wallet);
        Ok(())
    }

    /// Updates the metadata of an organization.
    pub fn update_organization(
        ctx: Context<UpdateOrganization>,
        name: Option<String>,
        url: Option<String>,
        clear_url: bool,
        new_film_program_id: Option<Pubkey>,
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
        if let Some(pid) = new_film_program_id {
            org.authorized_film_program = pid;
        }

        emit!(OrganizationUpdated {
            org_id: org.org_id,
            name: org.name.clone(),
        });

        Ok(())
    }

    /// Updates the role of an existing member.
    pub fn update_member_role(ctx: Context<UpdateMemberRole>, new_role: Role) -> Result<()> {
        require!(
            ctx.accounts.member.wallet != ctx.accounts.admin.key(),
            ErrorCode::CannotUpdateSelfRole
        );

        ctx.accounts.member.role = new_role as u8;
        Ok(())
    }

    /// Transfers admin rights to another member.
    /// The old admin becomes a regular Uploader.
    pub fn transfer_admin_rights(ctx: Context<TransferAdminRights>) -> Result<()> {
        let org: &mut Account<'_, OrganizationAccount> = &mut ctx.accounts.organization;
        let old_admin_member: &mut Account<'_, MemberAccount> = &mut ctx.accounts.old_admin_member;
        let new_admin_member: &mut Account<'_, MemberAccount> = &mut ctx.accounts.new_admin_member;

        org.admin = ctx.accounts.new_admin.key();
        old_admin_member.role = Role::Uploader as u8;

        new_admin_member.role = Role::Admin as u8;

        emit!(AdminTransferred {
            org: org.key(),
            old_admin: ctx.accounts.old_admin.key(),
            new_admin: ctx.accounts.new_admin.key(),
        });

        Ok(())
    }

    // --- CPI Functions ---

    pub fn increment_film_count(ctx: Context<FilmCountCPI>) -> Result<()> {
        ctx.accounts.organization.films_count = ctx
            .accounts
            .organization
            .films_count
            .checked_add(1)
            .ok_or(ErrorCode::Overflow)?;
        Ok(())
    }

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

// --- Data Structures ---

#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, PartialEq, Eq, Clone, Copy, Debug)]
pub enum Role {
    Admin = 1,
    Uploader = 2,
}

#[account]
#[derive(InitSpace)]
pub struct OrganizationAccount {
    pub admin: Pubkey,
    pub org_id: u64,
    #[max_len(64)]
    pub name: String,
    #[max_len(128)]
    pub url: Option<String>,
    pub authorized_film_program: Pubkey,
    pub members_count: u32,
    pub films_count: u32,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct MemberAccount {
    pub org: Pubkey,
    pub wallet: Pubkey,
    pub role: u8,
    pub bump: u8,
}

// --- Events ---

#[event]
pub struct OrganizationCreated {
    pub org_id: u64,
    pub admin: Pubkey,
    pub name: String,
}

#[event]
pub struct OrganizationUpdated {
    pub org_id: u64,
    pub name: String,
}

#[event]
pub struct AdminTransferred {
    pub org: Pubkey,
    pub old_admin: Pubkey,
    pub new_admin: Pubkey,
}

// --- Contexts ---

#[derive(Accounts)]
#[instruction(org_id: u64, name: String, url: Option<String>, film_program_id: Pubkey)]
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
    /// CHECK: Validated via seeds
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
pub struct TransferAdminRights<'info> {
    #[account(mut)]
    pub old_admin: Signer<'info>,

    /// CHECK: Validated in constraints
    pub new_admin: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = organization.admin == old_admin.key() @ ErrorCode::Unauthorized
    )]
    pub organization: Account<'info, OrganizationAccount>,

    #[account(
        mut,
        seeds = [b"member", organization.key().as_ref(), old_admin.key().as_ref()],
        bump = old_admin_member.bump,
        constraint = old_admin_member.role == Role::Admin as u8 @ ErrorCode::Unauthorized
    )]
    pub old_admin_member: Account<'info, MemberAccount>,

    #[account(
        mut,
        seeds = [b"member", organization.key().as_ref(), new_admin.key().as_ref()],
        bump = new_admin_member.bump
    )]
    pub new_admin_member: Account<'info, MemberAccount>,
}

#[derive(Accounts)]
#[instruction(name: Option<String>, url: Option<String>, clear_url: bool, new_film_program_id: Option<Pubkey>)]
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
#[instruction(new_role: Role)]
pub struct UpdateMemberRole<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        constraint = admin_member.org == organization.key() @ ErrorCode::Unauthorized,
        constraint = admin_member.wallet == admin.key() @ ErrorCode::Unauthorized,
        constraint = admin_member.role == Role::Admin as u8 @ ErrorCode::Unauthorized,
        seeds = [b"member", organization.key().as_ref(), admin.key().as_ref()],
        bump = admin_member.bump,
    )]
    pub admin_member: Account<'info, MemberAccount>,
    #[account(address = admin_member.org)]
    pub organization: Account<'info, OrganizationAccount>,
    #[account(
        mut,
        constraint = member.org == organization.key() @ ErrorCode::InvalidMember,
        seeds = [b"member", organization.key().as_ref(), member.wallet.as_ref()],
        bump = member.bump,
    )]
    pub member: Account<'info, MemberAccount>,
}

#[derive(Accounts)]
pub struct FilmCountCPI<'info> {
    #[account(
        mut,
        constraint = organization.authorized_film_program == film_program.key() @ ErrorCode::UnauthorizedProgram
    )]
    pub organization: Account<'info, OrganizationAccount>,
    /// CHECK: PDA signer from film program
    #[account(signer)]
    pub program_signer: UncheckedAccount<'info>,
    /// CHECK: The film program calling the CPI
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
    #[msg("An admin cannot update their own role.")]
    CannotUpdateSelfRole,
    #[msg("The specified member does not belong to this organization.")]
    InvalidMember,
    #[msg("The calling program is not authorized by this organization.")]
    UnauthorizedProgram,
}
