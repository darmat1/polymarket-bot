import axios from "axios";
import {
  AssetType,
  Chain,
  ClobClient,
  OrderType,
  Side,
  type ApiKeyCreds,
  type BalanceAllowanceResponse,
  type TickSize,
  type Trade,
  type TradeParams,
} from "@polymarket/clob-client-v2";
import { ethers } from "ethers";

import { hasL2Creds, type Settings } from "../config.js";

let polymarketAxiosConfigured = false;

export interface PlaceOrderParams {
  tokenId: string;
  price: number;
  size: number;
  side: "buy" | "sell";
  tickSize?: string;
  negRisk?: boolean;
}

export class BasePolymarketClient {
  protected readonly settings: Settings;

  constructor(settings: Settings) {
    this.settings = settings;
    configurePolymarketAxios();
  }

  async getBalance(tokenId: string): Promise<BalanceAllowanceResponse> {
    return this.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenId,
    });
  }

  async getUsdcBalance(): Promise<BalanceAllowanceResponse> {
    return this.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  }

  async getBalanceAllowance(params?: {
    asset_type: AssetType;
    token_id?: string;
  }): Promise<BalanceAllowanceResponse> {
    const client = this.buildAuthenticatedClient();
    return client.getBalanceAllowance(
      params ?? { asset_type: AssetType.COLLATERAL },
    );
  }

  async updateBalanceAllowance(params?: {
    asset_type: AssetType;
    token_id?: string;
  }): Promise<void> {
    const client = this.buildAuthenticatedClient();
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
    const client = this.buildAuthenticatedClient();
    try {
      return await client.getNegRisk(tokenId);
    } catch (error) {
      console.error(`[Trading] Failed to get negRisk for ${tokenId}:`, error);
      return false;
    }
  }

  async placeLimitOrder(params: PlaceOrderParams): Promise<unknown> {
    const client = this.buildAuthenticatedClient();

    console.log(
      `[Trading] Placing limit order: ${params.side} ${params.size} at ${params.price} (Token: ${params.tokenId})`,
    );
    console.log(`[Trading] Using signatureType: ${this.settings.signatureType}`);

    const result = await client.createAndPostOrder(
      {
        tokenID: params.tokenId,
        price: params.price,
        side: toSdkSide(params.side),
        size: params.size,
      },
      {
        tickSize: (params.tickSize as TickSize | undefined) ?? "0.01",
        negRisk: params.negRisk ?? false,
      },
      OrderType.GTC,
    );

    console.log("[Trading] Order result:", JSON.stringify(result, null, 2));
    return result;
  }

  async placeMarketOrder(params: {
    tokenId: string;
    amount: number;
    side: "buy" | "sell";
    tickSize?: string;
    negRisk?: boolean;
    orderType?: OrderType.FOK | OrderType.FAK;
  }): Promise<unknown> {
    const client = this.buildAuthenticatedClient();

    console.log(
      `[Trading] Placing market order: ${params.side} ${params.amount} USDC (Token: ${params.tokenId})`,
    );

    const result = await client.createAndPostMarketOrder(
      {
        tokenID: params.tokenId,
        amount: params.amount,
        side: toSdkSide(params.side),
        orderType: params.orderType ?? OrderType.FOK,
      },
      {
        tickSize: (params.tickSize as TickSize | undefined) ?? "0.01",
        negRisk: params.negRisk ?? false,
      },
      params.orderType ?? OrderType.FOK,
    );

    console.log("[Trading] Market order result:", JSON.stringify(result, null, 2));
    return result;
  }

  async getTrades(
    params?: TradeParams,
    onlyFirstPage = true,
    nextCursor?: string,
  ): Promise<Trade[]> {
    const client = this.buildAuthenticatedClient();
    return client.getTrades(params, onlyFirstPage, nextCursor);
  }

  protected createSettingsWithApiCreds(creds: ApiKeyCreds): Settings {
    return {
      ...this.settings,
      apiKey: creds.key,
      apiSecret: creds.secret,
      apiPassphrase: creds.passphrase,
    };
  }

  protected buildAuthenticatedClient(): ClobClient {
    if (!hasL2Creds(this.settings)) {
      throw new Error("L2 credentials (API key/secret/passphrase) not found");
    }

    const signer = buildSigner(this.settings);

    return new ClobClient({
      host: this.settings.polymarketHost,
      chain: this.settings.chainId as Chain,
      signer: signer as never,
      creds: {
        key: this.settings.apiKey!,
        secret: this.settings.apiSecret!,
        passphrase: this.settings.apiPassphrase!,
      },
      signatureType: this.settings.signatureType,
      funderAddress: this.settings.funderAddress,
    });
  }
}

function configurePolymarketAxios() {
  if (polymarketAxiosConfigured) {
    return;
  }

  axios.interceptors.request.use((config) => {
    if (config.url?.includes("polymarket.com")) {
      config.headers.set(
        "User-Agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      );
    }
    return config;
  });

  polymarketAxiosConfigured = true;
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
