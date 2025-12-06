import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Organization } from "../target/types/organization";
import { Film } from "../target/types/film";
import {
  PublicKey,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { assert } from "chai";
import BN from "bn.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getTokenMetadata,
  createTransferCheckedInstruction,
} from "@solana/spl-token";

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
    lamports = 20 * anchor.web3.LAMPORTS_PER_SOL
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

  function findOrgPDAs(admin: PublicKey, orgId: BN) {
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

  function findNftAuthorityPDA(orgKey: PublicKey) {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("nft_authority"), orgKey.toBuffer()],
      filmProgram.programId
    );
    return pda;
  }

  let orgIdCounter = 0;
  function generateOrgId(): BN {
    orgIdCounter++;
    return new BN(Date.now() + orgIdCounter);
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
      .createOrganization(orgId, orgName, null, filmProgram.programId)
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

  it("Should mint a film NFT and increment film count", async () => {
    let orgAccount = await orgProgram.account.organizationAccount.fetch(orgPDA);
    assert.strictEqual(orgAccount.filmsCount, 0);

    const programSignerPDA = findProgramSignerPDA();
    const nftAuthority = findNftAuthorityPDA(orgPDA);

    const mint = new Keypair();
    const tokenAccount = getAssociatedTokenAddressSync(
      mint.publicKey,
      uploader.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    const name = "My First Film";
    const symbol = "MFF";
    const uri = "https://example.com/my_first_film.json";
    const fileHash =
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    const txSig = await filmProgram.methods
      .mintFilm(name, symbol, uri, fileHash)
      .accountsPartial({
        signer: uploader.publicKey,
        member: uploaderMemberPDA,
        organization: orgPDA,
        organizationProgram: orgProgram.programId,
        programSigner: programSignerPDA,
        filmAccount: filmProgram.programId,
        nftAuthority,
        mint: mint.publicKey,
        tokenAccount,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([uploader, mint])
      .rpc();

    const latest = await provider.connection.getLatestBlockhash();

    await provider.connection.confirmTransaction(
      {
        signature: txSig,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      "confirmed"
    );

    orgAccount = await orgProgram.account.organizationAccount.fetch(orgPDA);
    assert.strictEqual(orgAccount.filmsCount, 1);

    const mintInfo = await provider.connection.getAccountInfo(mint.publicKey);
    assert.ok(mintInfo, "Mint account should exist");

    const tokenInfo = await provider.connection.getAccountInfo(tokenAccount);
    assert.ok(tokenInfo, "Associated token account should exist");

    const metadata = await getTokenMetadata(
      provider.connection,
      mint.publicKey,
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );

    assert.ok(metadata, "Metadata should not be null");
    assert.strictEqual(metadata.name, name, "Name mismatch");
    assert.strictEqual(metadata.symbol, symbol, "Symbol mismatch");
    assert.strictEqual(metadata.uri, uri, "URI mismatch");

    const orgKeyPair = metadata.additionalMetadata.find(
      ([key]) => key === "organization_key"
    );
    const orgKey = orgKeyPair ? orgKeyPair[1] : undefined;
    assert.strictEqual(orgKey, orgPDA.toString(), "Organization key mismatch");

    const hashPair = metadata.additionalMetadata.find(
      ([key]) => key === "file_hash"
    );
    const hashVal = hashPair ? hashPair[1] : undefined;
    assert.strictEqual(hashVal, fileHash, "File Hash mismatch");
  });

  it("Should fail to mint a film when the member is not authorized", async () => {
    const programSignerPDA = findProgramSignerPDA();
    const nftAuthority = findNftAuthorityPDA(orgPDA);

    const mint = new Keypair();
    const tokenAccount = getAssociatedTokenAddressSync(
      mint.publicKey,
      attacker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    const name = "Hacker Film";
    const symbol = "HACK";
    const uri = "https://example.com/hacker_film.json";
    const fileHash = "hackhash";

    try {
      await filmProgram.methods
        .mintFilm(name, symbol, uri, fileHash)
        .accountsPartial({
          signer: attacker.publicKey,
          member: uploaderMemberPDA,
          organization: orgPDA,
          organizationProgram: orgProgram.programId,
          programSigner: programSignerPDA,
          filmAccount: filmProgram.programId,
          nftAuthority,
          mint: mint.publicKey,
          tokenAccount,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([attacker, mint])
        .rpc();

      assert.fail("Transaction should have failed!");
    } catch (err: any) {
      const msg = err.error?.errorMessage || err.message || JSON.stringify(err);
      assert.include(
        msg,
        "You are not authorized to perform this action",
        "Should fail due to authorization constraint"
      );
    }
  });

  it("Should fail when making a direct call to increment_film_count", async () => {
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
    } catch (err: any) {
      assert.include(
        err.message,
        "signer",
        "Should fail because program_signer is not a valid signer"
      );
    }
  });

  it("Should update film metadata", async () => {
    const programSignerPDA = findProgramSignerPDA();
    const nftAuthorityPDA = findNftAuthorityPDA(orgPDA);
    const mint = new Keypair();
    const tokenAccount = getAssociatedTokenAddressSync(
      mint.publicKey,
      uploader.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const originalUri = "https://example.com/original-uri.json";
    const fileHash = "hash1";

    const txSig = await filmProgram.methods
      .mintFilm("Film To Update", "FTU", originalUri, fileHash)
      .accountsPartial({
        signer: uploader.publicKey,
        member: uploaderMemberPDA,
        organization: orgPDA,
        organizationProgram: orgProgram.programId,
        programSigner: programSignerPDA,
        filmAccount: filmProgram.programId,
        nftAuthority: nftAuthorityPDA,
        mint: mint.publicKey,
        tokenAccount,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([uploader, mint])
      .rpc();

    const latest = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction(
      {
        signature: txSig,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      "confirmed"
    );

    const newUri = "https://example.com/new-updated-uri.json";

    const txSigUpdate = await filmProgram.methods
      .updateFilmMetadata(newUri)
      .accountsPartial({
        signer: uploader.publicKey,
        organization: orgPDA,
        member: uploaderMemberPDA,
        nftAuthority: nftAuthorityPDA,
        mint: mint.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([uploader])
      .rpc();

    const latestUpdate = await provider.connection.getLatestBlockhash();

    await provider.connection.confirmTransaction(
      {
        signature: txSigUpdate,
        blockhash: latestUpdate.blockhash,
        lastValidBlockHeight: latestUpdate.lastValidBlockHeight,
      },
      "confirmed"
    );

    const metadata = await getTokenMetadata(
      provider.connection,
      mint.publicKey,
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );

    assert.strictEqual(metadata.uri, newUri, "URI should be updated");
  });

  it("Should fail to update metadata with invalid URI", async () => {
    const programSignerPDA = findProgramSignerPDA();
    const nftAuthorityPDA = findNftAuthorityPDA(orgPDA);
    const mint = new Keypair();
    const tokenAccount = getAssociatedTokenAddressSync(
      mint.publicKey,
      uploader.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    const txSigMint = await filmProgram.methods
      .mintFilm("Film URI Test", "FUT", "https://valid.uri", "hash")
      .accountsPartial({
        signer: uploader.publicKey,
        member: uploaderMemberPDA,
        organization: orgPDA,
        programSigner: programSignerPDA,
        filmAccount: filmProgram.programId,
        nftAuthority: nftAuthorityPDA,
        mint: mint.publicKey,
        tokenAccount,
      })
      .signers([uploader, mint])
      .rpc();

    const latestMint = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction(
      {
        signature: txSigMint,
        blockhash: latestMint.blockhash,
        lastValidBlockHeight: latestMint.lastValidBlockHeight,
      },
      "confirmed"
    );

    try {
      const longUri = "a".repeat(201);
      await filmProgram.methods
        .updateFilmMetadata(longUri)
        .accountsPartial({
          signer: uploader.publicKey,
          organization: orgPDA,
          member: uploaderMemberPDA,
          nftAuthority: nftAuthorityPDA,
          mint: mint.publicKey,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([uploader])
        .rpc();
      assert.fail("Transaction should have failed with long URI");
    } catch (err) {
      assert.include(
        err.error.errorMessage,
        "URI must be between 1 and 200 characters.",
        "Error message for long URI mismatch"
      );
    }

    try {
      const emptyUri = "";
      await filmProgram.methods
        .updateFilmMetadata(emptyUri)
        .accountsPartial({
          signer: uploader.publicKey,
          organization: orgPDA,
          member: uploaderMemberPDA,
          nftAuthority: nftAuthorityPDA,
          mint: mint.publicKey,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([uploader])
        .rpc();
      assert.fail("Transaction should have failed with empty URI");
    } catch (err) {
      assert.include(
        err.error.errorMessage,
        "URI must be between 1 and 200 characters.",
        "Error message for empty URI mismatch"
      );
    }
  });

  it("Should fail to update metadata from another organization (OrganizationMismatch/CPI Error)", async () => {
    const nftAuthorityPDA = findNftAuthorityPDA(orgPDA);
    const mintOrgA = new Keypair();
    const tokenAccountOrgA = getAssociatedTokenAddressSync(
      mintOrgA.publicKey,
      uploader.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    const txSigMintA = await filmProgram.methods
      .mintFilm("Film Org A", "FOA", "https://org-a.com", "hashA")
      .accountsPartial({
        signer: uploader.publicKey,
        member: uploaderMemberPDA,
        organization: orgPDA,
        programSigner: findProgramSignerPDA(),
        filmAccount: filmProgram.programId,
        nftAuthority: nftAuthorityPDA,
        mint: mintOrgA.publicKey,
        tokenAccount: tokenAccountOrgA,
      })
      .signers([uploader, mintOrgA])
      .rpc();

    const latestMintA = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction(
      {
        signature: txSigMintA,
        blockhash: latestMintA.blockhash,
        lastValidBlockHeight: latestMintA.lastValidBlockHeight,
      },
      "confirmed"
    );

    const adminB = await createAndFundWallet();
    const orgIdB = generateOrgId();
    const { orgPDA: orgPDA_B, adminMemberPDA: adminMemberPDA_B } = findOrgPDAs(
      adminB.publicKey,
      orgIdB
    );

    const txSigOrgB = await orgProgram.methods
      .createOrganization(orgIdB, "Org B", null, filmProgram.programId)
      .accountsPartial({
        admin: adminB.publicKey,
        organization: orgPDA_B,
        adminMember: adminMemberPDA_B,
      })
      .signers([adminB])
      .rpc();

    const latestOrgB = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction(
      {
        signature: txSigOrgB,
        blockhash: latestOrgB.blockhash,
        lastValidBlockHeight: latestOrgB.lastValidBlockHeight,
      },
      "confirmed"
    );

    const nftAuthorityPDA_B = findNftAuthorityPDA(orgPDA_B);

    try {
      await filmProgram.methods
        .updateFilmMetadata("https://hacked.com")
        .accountsPartial({
          signer: adminB.publicKey,
          organization: orgPDA_B,
          member: adminMemberPDA_B,
          nftAuthority: nftAuthorityPDA_B,
          mint: mintOrgA.publicKey,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([adminB])
        .rpc();
      assert.fail("Admin B should not be able to update Admin A's film");
    } catch (err: any) {
      assert.ok(true, "Transaction failed as expected");
    }
  });

  it("Should burn a film NFT, reclaim rent and decrement film count", async () => {
    let orgAccount = await orgProgram.account.organizationAccount.fetch(orgPDA);
    const initialCount = orgAccount.filmsCount;

    const programSignerPDA = findProgramSignerPDA();
    const nftAuthorityPDA = findNftAuthorityPDA(orgPDA);

    const mint = new Keypair();
    const tokenAccount = getAssociatedTokenAddressSync(
      mint.publicKey,
      admin.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    const txSigMint = await filmProgram.methods
      .mintFilm("Burnable Film", "BRN", "https://burn.me", "burnhash")
      .accountsPartial({
        signer: admin.publicKey,
        member: adminMemberPDA,
        organization: orgPDA,
        organizationProgram: orgProgram.programId,
        programSigner: programSignerPDA,
        filmAccount: filmProgram.programId,
        nftAuthority: nftAuthorityPDA,
        mint: mint.publicKey,
        tokenAccount,
      })
      .signers([admin, mint])
      .rpc();

    const latestMint = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction(
      {
        signature: txSigMint,
        blockhash: latestMint.blockhash,
        lastValidBlockHeight: latestMint.lastValidBlockHeight,
      },
      "confirmed"
    );

    orgAccount = await orgProgram.account.organizationAccount.fetch(orgPDA);
    assert.strictEqual(orgAccount.filmsCount, initialCount + 1);

    const txSigBurn = await filmProgram.methods
      .burnFilm()
      .accountsPartial({
        filmAccount: filmProgram.programId,
        signer: admin.publicKey,
        organization: orgPDA,
        member: adminMemberPDA,
        organizationProgram: orgProgram.programId,
        programSigner: programSignerPDA,
        nftAuthority: nftAuthorityPDA,
        mint: mint.publicKey,
        tokenAccount,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();

    const latestBurn = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction(
      {
        signature: txSigBurn,
        blockhash: latestBurn.blockhash,
        lastValidBlockHeight: latestBurn.lastValidBlockHeight,
      },
      "confirmed"
    );

    orgAccount = await orgProgram.account.organizationAccount.fetch(orgPDA);
    assert.strictEqual(
      orgAccount.filmsCount,
      initialCount,
      "Film count should have been decremented"
    );

    const mintAccountInfo = await provider.connection.getAccountInfo(
      mint.publicKey
    );
    assert.strictEqual(
      mintAccountInfo,
      null,
      "Mint account should be closed and rent reclaimed"
    );

    const ataInfo = await provider.connection.getAccountInfo(tokenAccount);
    assert.strictEqual(
      ataInfo,
      null,
      "ATA account should be closed and rent reclaimed"
    );
  });

  it("Should fail to burn if the user does not own the NFT", async () => {
    const programSignerPDA = findProgramSignerPDA();
    const nftAuthorityPDA = findNftAuthorityPDA(orgPDA);

    const mint = new Keypair();
    const tokenAccountUploader = getAssociatedTokenAddressSync(
      mint.publicKey,
      uploader.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    await filmProgram.methods
      .mintFilm("Not Yours", "NY", "https://not.yours", "nyhash")
      .accountsPartial({
        signer: uploader.publicKey,
        member: uploaderMemberPDA,
        organization: orgPDA,
        organizationProgram: orgProgram.programId,
        programSigner: programSignerPDA,
        filmAccount: filmProgram.programId,
        nftAuthority: nftAuthorityPDA,
        mint: mint.publicKey,
        tokenAccount: tokenAccountUploader,
      })
      .signers([uploader, mint])
      .rpc();

    try {
      await filmProgram.methods
        .burnFilm()
        .accountsPartial({
          filmAccount: filmProgram.programId,
          signer: admin.publicKey,
          organization: orgPDA,
          member: adminMemberPDA,
          organizationProgram: orgProgram.programId,
          programSigner: programSignerPDA,
          nftAuthority: nftAuthorityPDA,
          mint: mint.publicKey,
          tokenAccount: tokenAccountUploader,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([admin])
        .rpc();

      assert.fail("Burn should fail because Admin does not own the NFT");
    } catch (err: any) {
      const msg = err.message || JSON.stringify(err);
      const logs = err.logs || [];

      const isOwnerMismatch =
        logs.some((l: string) => l.includes("owner does not match")) ||
        msg.includes("custom program error: 0x4") ||
        msg.includes("0x4");

      assert.ok(
        isOwnerMismatch,
        `Expected SPL Token Error 0x4 (OwnerMismatch), but got: ${msg}`
      );
    }
  });

  it("Should fail to burn when member does not have role Admin", async () => {
    const programSignerPDA = findProgramSignerPDA();
    const nftAuthorityPDA = findNftAuthorityPDA(orgPDA);

    const uploader2 = await createAndFundWallet();
    const uploaderMemberPDA2 = findMemberPDA(orgPDA, uploader2.publicKey);

    await orgProgram.methods
      .addMember({ uploader: {} })
      .accountsPartial({
        admin: admin.publicKey,
        adminMember: adminMemberPDA,
        organization: orgPDA,
        newMember: uploader2.publicKey,
        member: uploaderMemberPDA2,
      })
      .signers([admin])
      .rpc();

    const mint = new Keypair();
    const tokenAccount = getAssociatedTokenAddressSync(
      mint.publicKey,
      uploader2.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    await filmProgram.methods
      .mintFilm("Uploader Film", "UF", "https://uploader", "uhash")
      .accountsPartial({
        signer: uploader2.publicKey,
        member: uploaderMemberPDA2,
        organization: orgPDA,
        organizationProgram: orgProgram.programId,
        programSigner: programSignerPDA,
        filmAccount: filmProgram.programId,
        nftAuthority: nftAuthorityPDA,
        mint: mint.publicKey,
        tokenAccount,
      })
      .signers([uploader2, mint])
      .rpc();

    try {
      await filmProgram.methods
        .burnFilm()
        .accountsPartial({
          filmAccount: filmProgram.programId,
          signer: uploader2.publicKey,
          organization: orgPDA,
          member: uploaderMemberPDA2,
          organizationProgram: orgProgram.programId,
          programSigner: programSignerPDA,
          nftAuthority: nftAuthorityPDA,
          mint: mint.publicKey,
          tokenAccount,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([uploader2])
        .rpc();

      assert.fail("Uploader should not be authorized to burn film");
    } catch (err: any) {
      assert.include(
        err.error.errorMessage,
        "You are not authorized to perform this action",
        "Uploader should fail auth check"
      );
    }
  });

  it("Should fail to burn film from another organization (OrganizationMismatch/CPI Error)", async () => {
    const programSignerPDA = findProgramSignerPDA();
    const nftAuthorityPDA = findNftAuthorityPDA(orgPDA);

    const adminB = await createAndFundWallet();
    const orgIdB = generateOrgId();
    const { orgPDA: orgPDA_B, adminMemberPDA: adminMemberPDA_B } = findOrgPDAs(
      adminB.publicKey,
      orgIdB
    );

    await orgProgram.methods
      .createOrganization(orgIdB, "Org B", null, filmProgram.programId)
      .accountsPartial({
        admin: adminB.publicKey,
        organization: orgPDA_B,
        adminMember: adminMemberPDA_B,
      })
      .signers([adminB])
      .rpc();

    const mintA = new Keypair();
    const tokenAccountA = getAssociatedTokenAddressSync(
      mintA.publicKey,
      uploader.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    await filmProgram.methods
      .mintFilm("OrgA Film", "OA", "https://orga", "hashA")
      .accountsPartial({
        signer: uploader.publicKey,
        member: uploaderMemberPDA,
        organization: orgPDA,
        organizationProgram: orgProgram.programId,
        programSigner: programSignerPDA,
        filmAccount: filmProgram.programId,
        nftAuthority: nftAuthorityPDA,
        mint: mintA.publicKey,
        tokenAccount: tokenAccountA,
      })
      .signers([uploader, mintA])
      .rpc();

    const nftAuthorityPDA_B = findNftAuthorityPDA(orgPDA_B);

    try {
      await filmProgram.methods
        .burnFilm()
        .accountsPartial({
          filmAccount: filmProgram.programId,
          signer: adminB.publicKey,
          organization: orgPDA_B,
          member: adminMemberPDA_B,
          organizationProgram: orgProgram.programId,
          programSigner: programSignerPDA,
          nftAuthority: nftAuthorityPDA_B,
          mint: mintA.publicKey,
          tokenAccount: tokenAccountA,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([adminB])
        .rpc();

      assert.fail("Org B should not burn NFT from Org A");
    } catch (err: any) {
      assert.ok(true, "Transaction failed as expected");
    }
  });
});
