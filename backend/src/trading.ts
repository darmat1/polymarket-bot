import {
  AssetType,
  type BalanceAllowanceResponse,
  ClobClient,
  OrderType,
  Side,
  type ApiKeyCreds,
  type TickSize,
  Chain,
} from "@polymarket/clob-client-v2";
import { ethers } from "ethers";
import axios from "axios";
import { hasL2Creds, type Settings } from "./config.js";

// Global axios interceptor to bypass Cloudflare bot detection for clob-client
axios.interceptors.request.use((config) => {
  if (config.url?.includes("polymarket.com")) {
    config.headers["User-Agent"] =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  }
  return config;
});

export interface PlaceOrderParams {
  tokenId: string;
  price: number;
  size: number;
  side: "buy" | "sell";
  tickSize?: string;
  negRisk?: boolean;
}

export class TradingClient {
  private settings: Settings;

  constructor(settings: Settings) {
    this.settings = settings;
  }

  async getBalance(tokenId: string): Promise<BalanceAllowanceResponse> {
    const client = this.buildL2Client();
    return client.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenId,
    });
  }

  /**
   * Helper to update settings with runtime credentials
   */
  withApiCreds(creds: ApiKeyCreds): TradingClient {
    return new TradingClient({
      ...this.settings,
      apiKey: creds.key,
      apiSecret: creds.secret,
      apiPassphrase: creds.passphrase,
    });
  }

  /**
   * Used for runtime authentication derivation
   */
  async createOrDeriveApiCredsRaw(): Promise<unknown> {
    const client = this.buildL2Client();
    return client.createOrDeriveApiKey();
  }

  async getUsdcBalance(): Promise<BalanceAllowanceResponse> {
    return this.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });
  }

  async getBalanceAllowance(params?: {
    asset_type: AssetType;
    token_id?: string;
  }): Promise<BalanceAllowanceResponse> {
    const client = this.buildL2Client();
    return client.getBalanceAllowance(
      params ?? { asset_type: AssetType.COLLATERAL },
    );
  }

  async updateBalanceAllowance(params?: {
    asset_type: AssetType;
    token_id?: string;
  }): Promise<void> {
    const client = this.buildL2Client();
    return client.updateBalanceAllowance(
      params ?? { asset_type: AssetType.COLLATERAL },
    );
  }

  async updateTokenAllowance(): Promise<void> {
    return this.updateBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
    });
  }

  async getNegRisk(tokenId: string): Promise<boolean> {
    const client = this.buildL2Client();
    try {
      return await client.getNegRisk(tokenId);
    } catch (e) {
      console.error(`[Trading] Failed to get negRisk for ${tokenId}:`, e);
      return false;
    }
  }

  async placeLimitOrder(params: PlaceOrderParams): Promise<unknown> {
    const client = this.buildL2Client();

    console.log(
      `[Trading] Placing limit order: ${params.side} ${params.size} at ${params.price} (Token: ${params.tokenId})`,
    );
    console.log(`[Trading] Using signatureType: ${this.settings.signatureType}`);

    // Create and post order in one go using the new v2 SDK
    // It will automatically handle version selection (v1 or v2) based on the market
    const result = await client.createAndPostOrder(
      {
        tokenID: params.tokenId,
        price: params.price,
        side: toSdkSide(params.side),
        size: params.size,
      },
      {
        tickSize: (params.tickSize as any) ?? "0.01",
        negRisk: params.negRisk ?? false,
      },
    );

    console.log("[Trading] Order result:", JSON.stringify(result, null, 2));
    return result;
  }

  private buildL2Client(): ClobClient {
    if (!hasL2Creds(this.settings)) {
      throw new Error("L2 credentials (API key/secret/passphrase) not found");
    }

    const signer = buildSigner(this.settings);

    return new ClobClient({
      host: this.settings.polymarketHost,
      chain: this.settings.chainId as Chain,
      signer: signer as any,
      creds: {
        key: this.settings.apiKey!,
        secret: this.settings.apiSecret!,
        passphrase: this.settings.apiPassphrase!,
      },
      signatureType: this.settings.signatureType as any,
      funderAddress: this.settings.funderAddress,
    });
  }
}

function buildSigner(settings: Settings) {
  if (!settings.privateKey) {
    throw new Error("Private key not found");
  }
  return new ethers.Wallet(settings.privateKey);
}

function toSdkSide(side: "buy" | "sell"): Side {
  return side === "buy" ? Side.BUY : Side.SELL;
}
