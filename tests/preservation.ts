import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Preservation } from "../target/types/preservation";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";

describe("preservation", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Preservation as Program<Preservation>;

  const organizationAdmin = anchor.web3.Keypair.generate();
  const storageProviderOwner = anchor.web3.Keypair.generate();
  const daoTreasuryOwner = anchor.web3.Keypair.generate();

  const filmNftMint = anchor.web3.Keypair.generate().publicKey;
  const filmNftMintSlash = anchor.web3.Keypair.generate().publicKey;
  const filmNftMintCancel = anchor.web3.Keypair.generate().publicKey;

  let spiralCoinMint: anchor.web3.PublicKey;
  let orgTokenAccount: anchor.web3.PublicKey;
  let providerTokenAccount: anchor.web3.PublicKey;
  let daoTokenAccount: anchor.web3.PublicKey;

  let providerPda: anchor.web3.PublicKey;
  let stakeVaultPda: anchor.web3.PublicKey;

  const getDealPda = (mint: anchor.web3.PublicKey) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("deal"),
        mint.toBuffer(),
        organizationAdmin.publicKey.toBuffer(),
      ],
      program.programId
    )[0];

  const getRewardVaultPda = (dealPda: anchor.web3.PublicKey) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("reward_vault"), dealPda.toBuffer()],
      program.programId
    )[0];

  const STAKE_AMOUNT = new anchor.BN(1000 * 10 ** 6);
  const TOP_UP_AMOUNT = new anchor.BN(500 * 10 ** 6);
  const REWARD_AMOUNT = new anchor.BN(100 * 10 ** 6);
  const TEST_DURATION = new anchor.BN(2);

  it("Setup: Initializes SpiralCoin Mint and Airdrops", async () => {
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        organizationAdmin.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      ),
      "confirmed"
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        storageProviderOwner.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      ),
      "confirmed"
    );

    spiralCoinMint = await createMint(
      provider.connection,
      organizationAdmin,
      organizationAdmin.publicKey,
      null,
      6
    );

    orgTokenAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        organizationAdmin,
        spiralCoinMint,
        organizationAdmin.publicKey
      )
    ).address;

    providerTokenAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        storageProviderOwner,
        spiralCoinMint,
        storageProviderOwner.publicKey
      )
    ).address;

    daoTokenAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        organizationAdmin,
        spiralCoinMint,
        daoTreasuryOwner.publicKey
      )
    ).address;

    await mintTo(
      provider.connection,
      organizationAdmin,
      spiralCoinMint,
      orgTokenAccount,
      organizationAdmin,
      5000 * 10 ** 6
    );
    await mintTo(
      provider.connection,
      organizationAdmin,
      spiralCoinMint,
      providerTokenAccount,
      organizationAdmin,
      2000 * 10 ** 6
    );
  });

  it("Registers a Storage Provider", async () => {
    [providerPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("provider"), storageProviderOwner.publicKey.toBuffer()],
      program.programId
    );
    [stakeVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("stake_vault"), providerPda.toBuffer()],
      program.programId
    );

    await program.methods
      .registerProvider(STAKE_AMOUNT)
      .accountsPartial({
        owner: storageProviderOwner.publicKey,
        provider: providerPda,
        ownerTokenAccount: providerTokenAccount,
        stakeVault: stakeVaultPda,
        spiralCoinMint: spiralCoinMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([storageProviderOwner])
      .rpc();

    const providerAccount = await program.account.storageProviderAccount.fetch(
      providerPda
    );
    assert.equal(providerAccount.lockedStake.toNumber(), 0);
    assert.equal(
      providerAccount.stakeAmount.toNumber(),
      STAKE_AMOUNT.toNumber()
    );

    const stakeVaultAccount = await getAccount(
      provider.connection,
      stakeVaultPda
    );
    assert.equal(Number(stakeVaultAccount.amount), STAKE_AMOUNT.toNumber());
  });

  it("Allows Provider to Deposit More Stake (Top-up)", async () => {
    const initialVault = (await getAccount(provider.connection, stakeVaultPda))
      .amount;
    const initialStats = await program.account.storageProviderAccount.fetch(
      providerPda
    );

    await program.methods
      .depositStake(TOP_UP_AMOUNT)
      .accountsPartial({
        owner: storageProviderOwner.publicKey,
        provider: providerPda,
        stakeVault: stakeVaultPda,
        ownerTokenAccount: providerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([storageProviderOwner])
      .rpc();

    const finalVault = (await getAccount(provider.connection, stakeVaultPda))
      .amount;
    const finalStats = await program.account.storageProviderAccount.fetch(
      providerPda
    );

    assert.equal(
      Number(finalVault),
      Number(initialVault) + TOP_UP_AMOUNT.toNumber()
    );
    assert.equal(
      finalStats.stakeAmount.toNumber(),
      initialStats.stakeAmount.toNumber() + TOP_UP_AMOUNT.toNumber()
    );
  });

  it("Scenario: Organization Proposes and then Cancels a Deal", async () => {
    const cancelDealPda = getDealPda(filmNftMintCancel);
    const cancelRewardVaultPda = getRewardVaultPda(cancelDealPda);

    const initialOrgBalance = (
      await getAccount(provider.connection, orgTokenAccount)
    ).amount;

    await program.methods
      .proposeDeal(filmNftMintCancel, REWARD_AMOUNT, TEST_DURATION)
      .accountsPartial({
        organizationAdmin: organizationAdmin.publicKey,
        deal: cancelDealPda,
        orgTokenAccount: orgTokenAccount,
        rewardVault: cancelRewardVaultPda,
        spiralCoinMint: spiralCoinMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([organizationAdmin])
      .rpc();

    await program.methods
      .cancelDeal()
      .accountsPartial({
        organizationAdmin: organizationAdmin.publicKey,
        deal: cancelDealPda,
        orgTokenAccount: orgTokenAccount,
        rewardVault: cancelRewardVaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([organizationAdmin])
      .rpc();

    try {
      await program.account.storageDealAccount.fetch(cancelDealPda);
      assert.fail("The deal account should have been closed/deleted!");
    } catch (error: any) {
      assert.include(error.message, "Account does not exist");
    }

    try {
      await getAccount(provider.connection, cancelRewardVaultPda);
      assert.fail("The Reward Vault Token Account should have been closed!");
    } catch (error: any) {
      assert.ok(true);
    }

    const finalOrgBalance = (
      await getAccount(provider.connection, orgTokenAccount)
    ).amount;
    assert.equal(finalOrgBalance.toString(), initialOrgBalance.toString());
  });

  let mainDealPda: anchor.web3.PublicKey;
  let mainRewardVaultPda: anchor.web3.PublicKey;

  it("Proposes a valid Deal", async () => {
    mainDealPda = getDealPda(filmNftMint);
    mainRewardVaultPda = getRewardVaultPda(mainDealPda);

    await program.methods
      .proposeDeal(filmNftMint, REWARD_AMOUNT, TEST_DURATION)
      .accountsPartial({
        organizationAdmin: organizationAdmin.publicKey,
        deal: mainDealPda,
        orgTokenAccount: orgTokenAccount,
        rewardVault: mainRewardVaultPda,
        spiralCoinMint: spiralCoinMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([organizationAdmin])
      .rpc();

    const dealAccount = await program.account.storageDealAccount.fetch(
      mainDealPda
    );
    assert.deepEqual(dealAccount.status, { pending: {} });
  });

  it("Provider Accepts the Deal (And locks stake)", async () => {
    await program.methods
      .acceptDeal()
      .accountsPartial({
        providerOwner: storageProviderOwner.publicKey,
        provider: providerPda,
        deal: mainDealPda,
      })
      .signers([storageProviderOwner])
      .rpc();

    const dealAccount = await program.account.storageDealAccount.fetch(
      mainDealPda
    );
    assert.deepEqual(dealAccount.status, { active: {} });

    const providerStats = await program.account.storageProviderAccount.fetch(
      providerPda
    );
    assert.equal(
      providerStats.lockedStake.toNumber(),
      REWARD_AMOUNT.toNumber()
    );
  });

  it("Verifies and Releases Payment (Closes Account & Unlocks Stake)", async () => {
    console.log("      ...Waiting 3 seconds for deal to mature...");
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const initialProviderBalance = (
      await getAccount(provider.connection, providerTokenAccount)
    ).amount;

    await program.methods
      .verifyAndReleasePayment()
      .accountsPartial({
        authority: organizationAdmin.publicKey,
        deal: mainDealPda,
        provider: providerPda,
        rewardVault: mainRewardVaultPda,
        providerTokenAccount: providerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([organizationAdmin])
      .rpc();

    try {
      await program.account.storageDealAccount.fetch(mainDealPda);
      assert.fail("The deal account should have been closed after completion!");
    } catch (error: any) {
      assert.include(error.message, "Account does not exist");
    }

    const finalProviderBalance = (
      await getAccount(provider.connection, providerTokenAccount)
    ).amount;
    assert.equal(
      Number(finalProviderBalance),
      Number(initialProviderBalance) + REWARD_AMOUNT.toNumber()
    );

    const providerStats = await program.account.storageProviderAccount.fetch(
      providerPda
    );
    assert.equal(providerStats.lockedStake.toNumber(), 0);
    assert.equal(providerStats.successfulDeals.toNumber(), 1);
  });

  it("Scenario: Slash Provider on Failed Deal", async () => {
    const slashDealPda = getDealPda(filmNftMintSlash);
    const slashRewardVaultPda = getRewardVaultPda(slashDealPda);

    await program.methods
      .proposeDeal(filmNftMintSlash, REWARD_AMOUNT, TEST_DURATION)
      .accountsPartial({
        organizationAdmin: organizationAdmin.publicKey,
        deal: slashDealPda,
        orgTokenAccount: orgTokenAccount,
        rewardVault: slashRewardVaultPda,
        spiralCoinMint: spiralCoinMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([organizationAdmin])
      .rpc();

    await program.methods
      .acceptDeal()
      .accountsPartial({
        providerOwner: storageProviderOwner.publicKey,
        provider: providerPda,
        deal: slashDealPda,
      })
      .signers([storageProviderOwner])
      .rpc();

    let providerStats = await program.account.storageProviderAccount.fetch(
      providerPda
    );
    assert.equal(
      providerStats.lockedStake.toNumber(),
      REWARD_AMOUNT.toNumber()
    );

    const initialStakeVault = await getAccount(
      provider.connection,
      stakeVaultPda
    );

    await program.methods
      .slashProvider()
      .accountsPartial({
        authority: organizationAdmin.publicKey,
        deal: slashDealPda,
        provider: providerPda,
        stakeVault: stakeVaultPda,
        rewardVault: slashRewardVaultPda,
        daoTreasury: daoTokenAccount,
        orgRefundAccount: orgTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([organizationAdmin])
      .rpc();

    try {
      await program.account.storageDealAccount.fetch(slashDealPda);
      assert.fail("The deal account should have been closed after slashing!");
    } catch (error: any) {
      assert.include(error.message, "Account does not exist");
    }

    const finalStakeVault = await getAccount(
      provider.connection,
      stakeVaultPda
    );
    assert.equal(
      Number(finalStakeVault.amount),
      Number(initialStakeVault.amount) - REWARD_AMOUNT.toNumber()
    );

    providerStats = await program.account.storageProviderAccount.fetch(
      providerPda
    );
    assert.equal(providerStats.failedDeals.toNumber(), 1);
    assert.equal(providerStats.lockedStake.toNumber(), 0);
  });

  it("Allows Provider to Withdraw partial Stake", async () => {
    const withdrawAmount = new anchor.BN(50 * 10 ** 6);
    const initialVault = (await getAccount(provider.connection, stakeVaultPda))
      .amount;

    await program.methods
      .withdrawStake(withdrawAmount)
      .accountsPartial({
        owner: storageProviderOwner.publicKey,
        provider: providerPda,
        stakeVault: stakeVaultPda,
        ownerTokenAccount: providerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([storageProviderOwner])
      .rpc();

    const finalVault = (await getAccount(provider.connection, stakeVaultPda))
      .amount;
    assert.equal(
      Number(finalVault),
      Number(initialVault) - withdrawAmount.toNumber()
    );
  });
});
