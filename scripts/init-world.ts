import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

import { Organization } from "../target/types/organization";

const SPIRALCOIN_DECIMALS = 6;
const INITIAL_SUPPLY = 1_000_000;
const SPIRAL_COIN_MINT_ADDRESS = "9oJTUbMkqYrEzGRugikzRnFfXnXs9XA7Pm9mvBdhhiik";

const ORG_ID = new anchor.BN(1);
const ORG_NAME = "Spiral Foundation";
const ORG_URL: string | null = null;

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const wallet = provider.wallet as anchor.Wallet;

  console.log("init-world started");
  console.log("wallet:", wallet.publicKey.toBase58());

  const spiralCoinMint = new anchor.web3.PublicKey(SPIRAL_COIN_MINT_ADDRESS);

  console.log("spiralcoin_mint_loaded:", spiralCoinMint.toBase58());

  const adminAta = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    wallet.payer,
    spiralCoinMint,
    wallet.publicKey
  );

  console.log("admin_ata:", adminAta.address.toBase58());

  try {
    await mintTo(
      provider.connection,
      wallet.payer,
      spiralCoinMint,
      adminAta.address,
      wallet.payer,
      INITIAL_SUPPLY * 10 ** SPIRALCOIN_DECIMALS
    );
    console.log("initial_supply_minted:", INITIAL_SUPPLY);
  } catch (error) {
    console.log("skipping_mint_authority_might_be_transferred");
    console.error(error);
  }

  const orgProgram = anchor.workspace.Organization as Program<Organization>;

  const [organizationPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("organization"),
      wallet.publicKey.toBuffer(),
      ORG_ID.toArrayLike(Buffer, "le", 8),
    ],
    orgProgram.programId
  );

  const [adminMemberPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("member"),
      organizationPda.toBuffer(),
      wallet.publicKey.toBuffer(),
    ],
    orgProgram.programId
  );

  console.log("organization_pda:", organizationPda.toBase58());
  console.log("admin_member_pda:", adminMemberPda.toBase58());

  try {
    await orgProgram.methods
      .createOrganization(
        ORG_ID,
        ORG_NAME,
        ORG_URL,
        anchor.workspace.Film.programId
      )
      .accountsPartial({
        admin: wallet.publicKey,
        organization: organizationPda,
        adminMember: adminMemberPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("organization_created");
  } catch (error) {
    console.error("organization_creation_failed");
    console.error(error);
  }

  console.log("init-world completed");
  console.log("spiralcoin_mint:", spiralCoinMint.toBase58());
  console.log("organization_program_id:", orgProgram.programId.toBase58());
  console.log(
    "preservation_program_id:",
    anchor.workspace.Preservation.programId.toBase58()
  );
  console.log(
    "film_program_id:",
    anchor.workspace.Film.programId.toBase58()
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("init-world fatal error");
    console.error(error);
    process.exit(1);
  });