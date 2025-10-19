import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Organization } from "../target/types/organization";
import { PublicKey, Keypair } from "@solana/web3.js";
import { assert } from "chai";
import BN from "bn.js";

describe("organization", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Organization as Program<Organization>;

  const Role = {
    Admin: 1,
    Uploader: 2,
  };

  let admin: Keypair;
  let uploader: Keypair;
  let attacker: Keypair;
  let orgPDA: PublicKey;
  let orgId: BN;
  let adminMemberPDA: PublicKey;
  let uploaderMemberPDA: PublicKey;

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

  function findPDAs(adminPubkey: PublicKey, orgId: anchor.BN) {
    const [orgPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("organization"),
        adminPubkey.toBuffer(),
        orgId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    const [adminMemberPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("member"), orgPDA.toBuffer(), adminPubkey.toBuffer()],
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

  function generateOrgId(): BN {
    return new BN(Date.now());
  }

  before(async () => {
    admin = await createAndFundWallet();
    uploader = await createAndFundWallet();
    attacker = await createAndFundWallet();

    orgId = generateOrgId();
    const orgName = "CineOrg Test";
    const pdaResult = findPDAs(admin.publicKey, orgId);
    orgPDA = pdaResult.orgPDA;
    adminMemberPDA = pdaResult.adminMemberPDA;

    await program.methods
      .createOrganization(orgId, orgName, "https://test.cine.org")
      .accountsPartial({
        admin: admin.publicKey,
        organization: orgPDA,
        adminMember: adminMemberPDA,
      })
      .signers([admin])
      .rpc();

    uploaderMemberPDA = findMemberPDA(orgPDA, uploader.publicKey);
    await program.methods
      .addMember({ uploader: {} })
      .accountsPartial({
        admin: admin.publicKey,
        adminMember: adminMemberPDA,
        organization: orgPDA,
        newMember: uploader.publicKey,
        member: uploaderMemberPDA,
      })
      .signers([admin])
      .rpc();
  });

  it("Should create an organization successfully", async () => {
    const orgAccount = await program.account.organizationAccount.fetch(orgPDA);
    assert.strictEqual(orgAccount.name, "CineOrg Test");
    assert.strictEqual(
      orgAccount.membersCount,
      2,
      "Should have admin and uploader members"
    );
  });

  it("Should add a new member (Admin) successfully", async () => {
    const anotherMember = Keypair.generate();
    const anotherMemberPDA = findMemberPDA(orgPDA, anotherMember.publicKey);

    await program.methods
      .addMember({ admin: {} })
      .accountsPartial({
        admin: admin.publicKey,
        adminMember: adminMemberPDA,
        organization: orgPDA,
        newMember: anotherMember.publicKey,
        member: anotherMemberPDA,
      })
      .signers([admin])
      .rpc();

    const orgAccount = await program.account.organizationAccount.fetch(orgPDA);
    assert.strictEqual(
      orgAccount.membersCount,
      3,
      "Members count should now be 3"
    );
  });

  it("Should remove a member", async () => {
    await program.methods
      .removeMember()
      .accountsPartial({
        admin: admin.publicKey,
        adminMember: adminMemberPDA,
        organization: orgPDA,
        member: uploaderMemberPDA,
      })
      .signers([admin])
      .rpc();

    const orgAccount = await program.account.organizationAccount.fetch(orgPDA);
    assert.strictEqual(
      orgAccount.membersCount,
      2,
      "Members count should be 2 after removal"
    );

    try {
      await program.account.memberAccount.fetch(uploaderMemberPDA);
      assert.fail("Member account should have been closed");
    } catch (err) {
      assert.include(err.message, "Account does not exist");
    }
  });

  it("Should update organization name and clear the URL", async () => {
    const newName = "Updated Name";

    await program.methods
      .updateOrganization(newName, null, true)
      .accountsPartial({
        admin: admin.publicKey,
        adminMember: adminMemberPDA,
        organization: orgPDA,
      })
      .signers([admin])
      .rpc();

    const orgAccount = await program.account.organizationAccount.fetch(orgPDA);
    assert.strictEqual(orgAccount.name, newName, "Name should be updated");
    assert.isNull(orgAccount.url, "URL should be cleared to null");
  });

  it("Should fail to create organization with name too long", async () => {
    const localAdmin = await createAndFundWallet();
    const localOrgId = generateOrgId();
    const longName = "a".repeat(65);
    const { orgPDA: localOrgPDA, adminMemberPDA: localAdminMemberPDA } =
      findPDAs(localAdmin.publicKey, localOrgId);

    try {
      await program.methods
        .createOrganization(localOrgId, longName, null)
        .accountsPartial({
          admin: localAdmin.publicKey,
          organization: localOrgPDA,
          adminMember: localAdminMemberPDA,
        })
        .signers([localAdmin])
        .rpc();
      assert.fail("Transaction should have failed");
    } catch (err) {
      assert.include(
        err.error.errorMessage,
        "Organization name must be between 1 and 64 characters."
      );
    }
  });

  it("Should fail to add member if signer is not an authorized admin", async () => {
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
      assert.include(err.toString(), "A seeds constraint was violated");
    }
  });

  it("Should fail to remove self (admin)", async () => {
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
        "An admin cannot remove themselves from the organization."
      );
    }
  });
});
