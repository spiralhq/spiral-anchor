import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  createMetadataAccountV3,
  mplTokenMetadata,
} from "@metaplex-foundation/mpl-token-metadata";
import {
  keypairIdentity,
  publicKey,
} from "@metaplex-foundation/umi";
import { fromWeb3JsKeypair } from "@metaplex-foundation/umi-web3js-adapters";
import * as anchor from "@coral-xyz/anchor";

const MINT_ADDRESS = "9oJTUbMkqYrEzGRugikzRnFfXnXs9XA7Pm9mvBdhhiik";

const TOKEN_NAME = "Spiral Coin";
const TOKEN_SYMBOL = "SPIRAL";
const TOKEN_URI =
  "https://raw.githubusercontent.com/spiralhq/spiral-token-metadata/main/metadata.json";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const wallet = provider.wallet as anchor.Wallet;

  const umi = createUmi(provider.connection.rpcEndpoint).use(
    mplTokenMetadata()
  );

  umi.use(keypairIdentity(fromWeb3JsKeypair(wallet.payer)));

  console.log("metadata_creation_started");
  console.log("mint:", MINT_ADDRESS);

  const tx = await createMetadataAccountV3(umi, {
    mint: publicKey(MINT_ADDRESS),
    mintAuthority: umi.identity,
    payer: umi.identity,
    updateAuthority: umi.identity,
    data: {
      name: TOKEN_NAME,
      symbol: TOKEN_SYMBOL,
      uri: TOKEN_URI,
      sellerFeeBasisPoints: 0,
      creators: null,
      collection: null,
      uses: null,
    },
    isMutable: true,
    collectionDetails: null,
  });

  const result = await tx.sendAndConfirm(umi);

  console.log("metadata_created");
  console.log("signature:", result.signature);
}

main().catch((error) => {
  console.error("metadata_creation_failed");
  console.error(error);
  process.exit(1);
});
