import { AssetType, ClobClient } from "@polymarket/clob-client-v2";
import { config as loadDotenv } from "dotenv";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

loadDotenv();

async function main() {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  const apiKey = process.env.POLYMARKET_API_KEY;
  const apiSecret = process.env.POLYMARKET_API_SECRET;
  const apiPassphrase = process.env.POLYMARKET_API_PASSPHRASE;

  if (!privateKey) {
    throw new Error("POLYMARKET_PRIVATE_KEY is required");
  }
  if (!apiKey || !apiSecret || !apiPassphrase) {
    throw new Error("POLYMARKET_API_KEY, POLYMARKET_API_SECRET and POLYMARKET_API_PASSPHRASE are required");
  }

  const normalizedPrivateKey = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  const account = privateKeyToAccount(normalizedPrivateKey);
  const signatureType = Number(process.env.POLYMARKET_SIGNATURE_TYPE ?? "0");
  const host = process.env.POLYMARKET_HOST ?? "https://clob.polymarket.com";
  const chainId = Number(process.env.POLYMARKET_CHAIN_ID ?? "137");

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
    creds: {
      key: apiKey,
      secret: apiSecret,
      passphrase: apiPassphrase,
    },
  });

  console.log(
    JSON.stringify(
      {
        request: {
          host,
          endpoint: "/balance-allowance",
          params: {
            asset_type: "COLLATERAL",
            signature_type: signatureType,
          },
          signer_address: account.address,
        },
      },
      null,
      2,
    ),
  );

  const result = await client.getBalanceAllowance({
    asset_type: AssetType.COLLATERAL,
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});
