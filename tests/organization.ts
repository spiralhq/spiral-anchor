import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Organization } from "../target/types/organization";
import { PublicKey, Keypair } from "@solana/web3.js";
import { assert } from "chai";

describe("organization", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Organization as Program<Organization>;

  const Role = {
    Admin: 1,
    Uploader: 2,
  };

  async function createAndFundWallet(
    lamports = 10 * anchor.web3.LAMPORTS_PER_SOL
  ): Promise<Keypair> {
    const wallet = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      wallet.publicKey,
      lamports
    );
    const latestBlockhash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction(
      {
        signature: sig,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      "confirmed"
    );
    return wallet;
  }

  function findPDAs(admin: PublicKey, orgName: string) {
    const [orgPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("organization"), admin.toBuffer(), Buffer.from(orgName)],
      program.programId
    );

    const [adminMemberPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("member"), orgPDA.toBuffer(), admin.toBuffer()],
      program.programId
    );

    return { orgPDA, adminMemberPDA };
  }

  function findMemberPDA(orgPDA: PublicKey, memberWallet: PublicKey) {
    const [memberPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("member"), orgPDA.toBuffer(), memberWallet.toBuffer()],
      program.programId
    );
    return memberPDA;
  }

  it("Should create an organization successfully", async () => {
    const admin = await createAndFundWallet();
    const orgName = "CineOrg Test";
    const orgUrl = "https://test.cine.org";

    const { orgPDA, adminMemberPDA } = findPDAs(admin.publicKey, orgName);

    await program.methods
      .createOrganization(orgName, orgUrl)
      .accountsPartial({
        admin: admin.publicKey,
        organization: orgPDA,
        adminMember: adminMemberPDA,
      })
      .signers([admin])
      .rpc();

    const orgAccount = await program.account.organizationAccount.fetch(orgPDA);
    assert.strictEqual(orgAccount.name, orgName, "Name should match");
    assert.strictEqual(orgAccount.url, orgUrl, "URL should match");
    assert.isTrue(
      orgAccount.admin.equals(admin.publicKey),
      "Admin pubkey should match"
    );
    assert.strictEqual(orgAccount.membersCount, 1, "Members count should be 1");

    const memberAccount = await program.account.memberAccount.fetch(
      adminMemberPDA
    );
    assert.isTrue(memberAccount.org.equals(orgPDA), "Member org should match");
    assert.isTrue(
      memberAccount.wallet.equals(admin.publicKey),
      "Member wallet should match"
    );
    assert.strictEqual(
      memberAccount.role,
      Role.Admin,
      "Member role should be Admin"
    );
  });

  it("Should fail to create organization with name too long", async () => {
    const admin = await createAndFundWallet();
    const longName = "a".repeat(33);

    try {
      findPDAs(admin.publicKey, longName);

      assert.fail("PDA derivation should have failed but did not.");
    } catch (err) {
      assert.include(
        err.toString(),
        "Max seed length exceeded",
        "Should fail due to PDA seed length constraint"
      );
    }
  });

  it("Should fail to create organization with empty name", async () => {
    const admin = await createAndFundWallet();
    const emptyName = "";
    const { orgPDA, adminMemberPDA } = findPDAs(admin.publicKey, emptyName);

    try {
      await program.methods
        .createOrganization(emptyName, null)
        .accountsPartial({
          admin: admin.publicKey,
          organization: orgPDA,
          adminMember: adminMemberPDA,
        })
        .signers([admin])
        .rpc();
      assert.fail("Transaction should have failed");
    } catch (err) {
      assert.include(
        err.error.errorMessage,
        "Organization name must be between 1 and 32 characters.",
        "Should fail due to empty name constraint"
      );
    }
  });

  it("Should add a new member (Uploader) successfully", async () => {
    const admin = await createAndFundWallet();
    const orgName = "OrgForAddingMembers";
    const { orgPDA, adminMemberPDA } = findPDAs(admin.publicKey, orgName);
    await program.methods
      .createOrganization(orgName, null)
      .accountsPartial({
        admin: admin.publicKey,
        organization: orgPDA,
        adminMember: adminMemberPDA,
      })
      .signers([admin])
      .rpc();

    const newMemberWallet = Keypair.generate();
    const newMemberPDA = findMemberPDA(orgPDA, newMemberWallet.publicKey);

    await program.methods
      .addMember({ uploader: {} })
      .accountsPartial({
        admin: admin.publicKey,
        adminMember: adminMemberPDA,
        organization: orgPDA,
        newMember: newMemberWallet.publicKey,
        member: newMemberPDA,
      })
      .signers([admin])
      .rpc();

    const orgAccount = await program.account.organizationAccount.fetch(orgPDA);
    assert.strictEqual(orgAccount.membersCount, 2, "Members count should be 2");

    const memberAccount = await program.account.memberAccount.fetch(
      newMemberPDA
    );
    assert.isTrue(
      memberAccount.wallet.equals(newMemberWallet.publicKey),
      "Member wallet should match"
    );
    assert.strictEqual(
      memberAccount.role,
      Role.Uploader,
      "Member role should be Uploader"
    );
  });

  it("Should fail to add member if signer is not an authorized admin", async () => {
    const admin = await createAndFundWallet();
    const orgName = "SecureOrg";
    const { orgPDA, adminMemberPDA } = findPDAs(admin.publicKey, orgName);
    await program.methods
      .createOrganization(orgName, null)
      .accountsPartial({
        admin: admin.publicKey,
        organization: orgPDA,
        adminMember: adminMemberPDA,
      })
      .signers([admin])
      .rpc();

    const attacker = await createAndFundWallet();
    const newMemberWallet = Keypair.generate();
    const newMemberPDA = findMemberPDA(orgPDA, newMemberWallet.publicKey);

    try {
      await program.methods
        .addMember({ admin: {} })
        .accountsPartial({
          admin: attacker.publicKey,
          adminMember: adminMemberPDA,
          organization: orgPDA,
          newMember: newMemberWallet.publicKey,
          member: newMemberPDA,
        })
        .signers([attacker])
        .rpc();
      assert.fail("Transaction should have failed");
    } catch (err) {
      assert.include(
        err.toString(),
        "A seeds constraint was violated",
        "Should fail due to seeds constraint"
      );
    }
  });

  it("Should update organization name and URL", async () => {
    const admin = await createAndFundWallet();
    const orgName = "OrgToUpdate";
    const { orgPDA, adminMemberPDA } = findPDAs(admin.publicKey, orgName);
    await program.methods
      .createOrganization(orgName, "old.url")
      .accountsPartial({
        admin: admin.publicKey,
        organization: orgPDA,
        adminMember: adminMemberPDA,
      })
      .signers([admin])
      .rpc();

    const newName = "Updated Name";
    const newUrl = "https://new.url";

    await program.methods
      .updateOrganization(newName, newUrl, false)
      .accountsPartial({
        admin: admin.publicKey,
        adminMember: adminMemberPDA,
        organization: orgPDA,
      })
      .signers([admin])
      .rpc();

    const orgAccount = await program.account.organizationAccount.fetch(orgPDA);
    assert.strictEqual(orgAccount.name, newName, "Name should be updated");
    assert.strictEqual(orgAccount.url, newUrl, "URL should be updated");
  });

  it("Should update organization to clear the URL (Double Option)", async () => {
    const admin = await createAndFundWallet();
    const orgName = "OrgClearUrl";
    const { orgPDA, adminMemberPDA } = findPDAs(admin.publicKey, orgName);
    await program.methods
      .createOrganization(orgName, "url.to.clear")
      .accountsPartial({
        admin: admin.publicKey,
        organization: orgPDA,
        adminMember: adminMemberPDA,
      })
      .signers([admin])
      .rpc();

    let orgAccount = await program.account.organizationAccount.fetch(orgPDA);
    assert.strictEqual(orgAccount.url, "url.to.clear");

    await program.methods
      .updateOrganization(null, null, true)
      .accountsPartial({
        admin: admin.publicKey,
        adminMember: adminMemberPDA,
        organization: orgPDA,
      })
      .signers([admin])
      .rpc();

    orgAccount = await program.account.organizationAccount.fetch(orgPDA);
    assert.isNull(orgAccount.url, "URL should be cleared to null");
  });

  it("Should remove a member", async () => {
    const admin = await createAndFundWallet();
    const orgName = "OrgRemoveMember";
    const { orgPDA, adminMemberPDA } = findPDAs(admin.publicKey, orgName);
    await program.methods
      .createOrganization(orgName, null)
      .accountsPartial({
        admin: admin.publicKey,
        organization: orgPDA,
        adminMember: adminMemberPDA,
      })
      .signers([admin])
      .rpc();

    const memberWallet = Keypair.generate();
    const memberPDA = findMemberPDA(orgPDA, memberWallet.publicKey);
    await program.methods
      .addMember({ uploader: {} })
      .accountsPartial({
        admin: admin.publicKey,
        adminMember: adminMemberPDA,
        organization: orgPDA,
        newMember: memberWallet.publicKey,
        member: memberPDA,
      })
      .signers([admin])
      .rpc();

    let orgAccount = await program.account.organizationAccount.fetch(orgPDA);
    assert.strictEqual(orgAccount.membersCount, 2);

    await program.methods
      .removeMember()
      .accountsPartial({
        admin: admin.publicKey,
        adminMember: adminMemberPDA,
        organization: orgPDA,
        member: memberPDA,
      })
      .signers([admin])
      .rpc();

    orgAccount = await program.account.organizationAccount.fetch(orgPDA);
    assert.strictEqual(
      orgAccount.membersCount,
      1,
      "Members count should be 1 after removal"
    );

    try {
      await program.account.memberAccount.fetch(memberPDA);
      assert.fail("Member account should have been closed");
    } catch (err) {
      assert.include(
        err.message,
        "Account does not exist",
        "Fetch should fail for closed account"
      );
    }
  });

  it("Should fail to remove self (admin)", async () => {
    const admin = await createAndFundWallet();
    const orgName = "OrgRemoveSelf";
    const { orgPDA, adminMemberPDA } = findPDAs(admin.publicKey, orgName);
    await program.methods
      .createOrganization(orgName, null)
      .accountsPartial({
        admin: admin.publicKey,
        organization: orgPDA,
        adminMember: adminMemberPDA,
      })
      .signers([admin])
      .rpc();

    try {
      await program.methods
        .removeMember()
        .accountsPartial({
          admin: admin.publicKey,
          adminMember: adminMemberPDA,
          organization: orgPDA,
          member: adminMemberPDA,
        })
        .signers([admin])
        .rpc();
      assert.fail("Transaction should have failed");
    } catch (err) {
      assert.include(
        err.error.errorMessage,
        "An admin cannot remove themselves from the organization.",
        "Should fail with CannotRemoveSelf error"
      );
    }
  });
});
