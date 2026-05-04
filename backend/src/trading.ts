import {
  AssetType,
  type BalanceAllowanceResponse,
  ClobClient,
  OrderType,
  Side,
  type ApiKeyCreds,
  type TickSize,
} from "@polymarket/clob-client";
import { ethers } from "ethers";
import axios from "axios";

import { hasL2Creds, type Settings } from "./config.js";

// Global axios interceptor to bypass Cloudflare bot detection for clob-client
axios.interceptors.request.use((config) => {
  config.headers["User-Agent"] =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  config.headers["Accept"] =
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7";
  config.headers["Accept-Language"] = "en-US,en;q=0.9";
  config.headers["Connection"] = "keep-alive";
  return config;
});

export class TradingClient {
  constructor(private readonly settings: Settings) {}

  async createOrDeriveApiCredsRaw(): Promise<ApiKeyCreds> {
    const client = this.buildL1Client();
    return client.createOrDeriveApiKey();
  }

  async createOrDeriveApiCreds(): Promise<Record<string, string>> {
    const creds = await this.createOrDeriveApiCredsRaw();

    return {
      POLYMARKET_API_KEY: creds.key,
      POLYMARKET_API_SECRET: creds.secret,
      POLYMARKET_API_PASSPHRASE: creds.passphrase,
    };
  }

  async placeLimitOrder(params: {
    tokenId: string;
    side: "buy" | "sell";
    price: number;
    size: number;
    tickSize?: TickSize;
  }): Promise<unknown> {
    const client = this.buildL2Client();

    const signer = buildSigner(this.settings);
    const makerAddress = this.settings.funderAddress ?? signer.address;

    console.log(
      `[Trading] Placing limit order: ${params.side} ${params.size} at ${params.price} (Token: ${params.tokenId})`,
    );

    const signedOrder = await client.createOrder(
      {
        tokenID: params.tokenId,
        price: params.price,
        side: toSdkSide(params.side),
        size: params.size,
        feeRateBps: 1000,
        expiration: 0,
      },
      { tickSize: (params.tickSize as any) ?? "0.01" },
    );

    console.log(
      "[Trading] Signed order payload:",
      JSON.stringify(signedOrder, null, 2),
    );

    const result = await client.postOrder(signedOrder, OrderType.GTC);

    console.log("[Trading] API response:", JSON.stringify(result, null, 2));

    // ClobClient sometimes returns the error response instead of throwing
    if (result && typeof result === "object" && "error" in result) {
      console.error(
        "[Trading] Order placement failed (error in result):",
        result.error,
      );
      throw new Error((result as any).error);
    }
    // ClobClient might also return an error string
    if (typeof result === "string" && result.toLowerCase().includes("error")) {
      console.error("[Trading] Order placement failed (error string):", result);
      throw new Error(result);
    }

    return result;
  }

  async getBalanceAllowance(): Promise<BalanceAllowanceResponse> {
    const client = this.buildL2Client();
    return client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  }

  async updateBalanceAllowance(): Promise<void> {
    const client = this.buildL2Client();
    await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  }

  async updateTokenAllowance(): Promise<void> {
    const client = this.buildL2Client();
    // For conditional tokens (ERC1155)
    await client.updateBalanceAllowance({ asset_type: AssetType.CONDITIONAL });
  }

  private buildL1Client(): ClobClient {
    return new ClobClient(
      this.settings.polymarketHost,
      this.settings.chainId,
      buildSigner(this.settings),
      undefined,
      this.settings.signatureType as any,
      this.settings.funderAddress,
    );
  }

  private buildL2Client(credsOverride?: ApiKeyCreds): ClobClient {
    const signer = buildSigner(this.settings);
    const creds: ApiKeyCreds | undefined =
      credsOverride ??
      (hasL2Creds(this.settings)
        ? {
            key: this.settings.apiKey!,
            secret: this.settings.apiSecret!,
            passphrase: this.settings.apiPassphrase!,
          }
        : undefined);

    return new ClobClient(
      this.settings.polymarketHost,
      this.settings.chainId,
      signer,
      creds,
      this.settings.signatureType as any,
      this.settings.funderAddress,
    );
  }

  withApiCreds(creds: ApiKeyCreds): TradingClient {
    const settings: Settings = {
      ...this.settings,
      apiKey: creds.key,
      apiSecret: creds.secret,
      apiPassphrase: creds.passphrase,
    };
    return new TradingClient(settings);
  }
}

function buildSigner(settings: Settings) {
  if (!settings.privateKey) {
    throw new Error("POLYMARKET_PRIVATE_KEY is required");
  }

  const normalized = settings.privateKey.startsWith("0x")
    ? settings.privateKey
    : `0x${settings.privateKey}`;

  // For clob-client 5.8.1, signer needs to be an ethers Wallet instance.
  // Note: If you need to send transactions, you'd attach a provider.
  // But for signing CLOB payloads, a Wallet without a provider is sufficient.
  return new ethers.Wallet(normalized);
}

function toSdkSide(side: "buy" | "sell"): Side {
  return side === "buy" ? Side.BUY : Side.SELL;
}
