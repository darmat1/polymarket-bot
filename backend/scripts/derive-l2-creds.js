import { ClobClient } from "@polymarket/clob-client-v2";
import { config as loadDotenv } from "dotenv";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

loadDotenv();

async function main() {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("POLYMARKET_PRIVATE_KEY is required");
  }

  const host = process.env.POLYMARKET_HOST ?? "https://clob.polymarket.com";
  const chainId = Number(process.env.POLYMARKET_CHAIN_ID ?? "137");
  const funderAddress = process.env.POLYMARKET_FUNDER_ADDRESS;
  const signatureType = parseSignatureType(process.env.POLYMARKET_SIGNATURE_TYPE, funderAddress);

  const normalizedPrivateKey = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  const account = privateKeyToAccount(normalizedPrivateKey);

  const signer = createWalletClient({
    account,
    chain: polygon,
    transport: http(),
  });

  const client = new ClobClient({
    host,
    chain: chainId,
    signer,
    signatureType,
    funderAddress,
  });

  const creds = await client.createOrDeriveApiKey();

  console.log(
    JSON.stringify(
      {
        signerAddress: account.address,
        funderAddress: funderAddress ?? null,
        signatureType,
        POLYMARKET_API_KEY: creds.key,
        POLYMARKET_API_SECRET: creds.secret,
        POLYMARKET_API_PASSPHRASE: creds.passphrase,
      },
      null,
      2,
    ),
  );
}

function parseSignatureType(value, funderAddress) {
  if (!value || value.trim() === "") {
    return funderAddress ? 2 : 0;
  }

  const parsed = Number(value);
  if (parsed === 0 || parsed === 1 || parsed === 2 || parsed === 3) {
    return parsed;
  }

  throw new Error(`Invalid POLYMARKET_SIGNATURE_TYPE: ${value}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
