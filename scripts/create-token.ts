import * as anchor from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

const DECIMALS = 6;
const AMOUNT = 1_000_000;

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const wallet = provider.wallet as anchor.Wallet;

  console.log("token_creation_started");
  console.log("wallet:", wallet.publicKey.toBase58());

  const mint = await createMint(
    provider.connection,
    wallet.payer,
    wallet.publicKey,
    wallet.publicKey,
    DECIMALS
  );

  console.log("mint_created:", mint.toBase58());

  const userAta = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    wallet.payer,
    mint,
    wallet.publicKey
  );

  await mintTo(
    provider.connection,
    wallet.payer,
    mint,
    userAta.address,
    wallet.payer,
    AMOUNT * 10 ** DECIMALS
  );

  console.log("initial_supply_minted:", AMOUNT);
  console.log("mint_address:", mint.toBase58());
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("token_creation_failed");
    console.error(error);
    process.exit(1);
  });
