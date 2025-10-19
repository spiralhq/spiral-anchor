import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Organization } from "../target/types/organization";
import { Film } from "../target/types/film";
import { PublicKey, Keypair } from "@solana/web3.js";
import { assert } from "chai";
import BN from "bn.js";

describe("film", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const orgProgram = anchor.workspace.Organization as Program<Organization>;
  const filmProgram = anchor.workspace.Film as Program<Film>;

  let admin: Keypair;
  let uploader: Keypair;
  let attacker: Keypair;

  let orgPDA: PublicKey;
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

  function findOrgPDAs(admin: PublicKey, orgId: anchor.BN) {
    const [orgPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("organization"),
        admin.toBuffer(),
        orgId.toArrayLike(Buffer, "le", 8),
      ],
      orgProgram.programId
    );
    const [adminMemberPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("member"), orgPDA.toBuffer(), admin.toBuffer()],
      orgProgram.programId
    );
    return { orgPDA, adminMemberPDA };
  }

  function findMemberPDA(orgPDA: PublicKey, memberWallet: PublicKey) {
    const [memberPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("member"), orgPDA.toBuffer(), memberWallet.toBuffer()],
      orgProgram.programId
    );
    return memberPDA;
  }

  function findProgramSignerPDA() {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("signer")],
      filmProgram.programId
    );
    return pda;
  }

  function generateOrgId(): BN {
    return new BN(Date.now());
  }

  before(async () => {
    admin = await createAndFundWallet();
    uploader = await createAndFundWallet();
    attacker = await createAndFundWallet();

    const orgId = generateOrgId();
    const orgName = "CPI Test Studios";
    const pdaResult = findOrgPDAs(admin.publicKey, orgId);
    orgPDA = pdaResult.orgPDA;
    adminMemberPDA = pdaResult.adminMemberPDA;

    await orgProgram.methods
      .createOrganization(orgId, orgName, null)
      .accountsPartial({
        admin: admin.publicKey,
        organization: orgPDA,
        adminMember: adminMemberPDA,
      })
      .signers([admin])
      .rpc();

    uploaderMemberPDA = findMemberPDA(orgPDA, uploader.publicKey);
    await orgProgram.methods
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

  it("Should allow an authorized member to register a film via CPI", async () => {
    let orgAccount = await orgProgram.account.organizationAccount.fetch(orgPDA);
    assert.strictEqual(
      orgAccount.filmsCount,
      0,
      "Initial film count should be 0"
    );

    const programSignerPDA = findProgramSignerPDA();

    await filmProgram.methods
      .registerFilm()
      .accountsPartial({
        payer: uploader.publicKey,
        organization: orgPDA,
        member: uploaderMemberPDA,
        organizationProgram: orgProgram.programId,
        programSigner: programSignerPDA,
        filmAccount: filmProgram.programId,
      })
      .signers([uploader])
      .rpc();

    orgAccount = await orgProgram.account.organizationAccount.fetch(orgPDA);
    assert.strictEqual(
      orgAccount.filmsCount,
      1,
      "Film count should be incremented to 1"
    );
  });

  it("Should fails to register a film when the member is not authorized", async () => {
    const programSignerPDA = findProgramSignerPDA();

    try {
      await filmProgram.methods
        .registerFilm()
        .accountsPartial({
          payer: attacker.publicKey,
          organization: orgPDA,
          member: uploaderMemberPDA,
          organizationProgram: orgProgram.programId,
          programSigner: programSignerPDA,
          filmAccount: filmProgram.programId,
        })
        .signers([attacker])
        .rpc();
      assert.fail("Transaction should have failed!");
    } catch (err) {
      assert.include(
        err.error.errorMessage,
        "You are not authorized to perform this action",
        "Should fail due to authorization constraint"
      );
    }
  });

  it("Should fails when making a direct call to `increment_film_count`", async () => {
    try {
      await orgProgram.methods
        .incrementFilmCount()
        .accountsPartial({
          organization: orgPDA,
          filmProgram: filmProgram.programId,
        })
        .signers([attacker])
        .rpc();

      assert.fail("Direct call should have been rejected!");
    } catch (err) {
      assert.include(
        err.message,
        "signer",
        "Should fail because program_signer is not a valid signer"
      );
    }
  });
});
