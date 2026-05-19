import { AssetType, type OpenOrder, type OpenOrderParams } from "@polymarket/clob-client-v2";

import { loadSettings, type Settings } from "./config.js";
import {
  getRuntimePolymarketService,
  getRuntimeApiCreds,
  initializeRuntimeApiCreds,
} from "./runtime-auth.js";
import { TradingClient, type PlaceOrderParams } from "./trading.js";

export interface PolymarketUserChannelAuth {
  apiKey: string;
  passphrase: string;
  secret: string;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export class PolymarketService {
  private static instance: PolymarketService | null = null;
  private readonly settings: Settings;

  private constructor(settings: Settings) {
    this.settings = settings;
  }

  static getInstance(settings = loadSettings()): PolymarketService {
    if (!PolymarketService.instance) {
      PolymarketService.instance = new PolymarketService(settings);
    }
    return PolymarketService.instance;
  }

  async initialize(): Promise<void> {
    await initializeRuntimeApiCreds();
  }

  async getUserChannelAuth(): Promise<PolymarketUserChannelAuth | null> {
    const creds = await getRuntimeApiCreds();
    if (!creds) {
      return null;
    }

    return {
      apiKey: creds.key,
      passphrase: creds.passphrase,
      secret: creds.secret,
    };
  }

  async placeLimitOrder(params: PlaceOrderParams): Promise<unknown> {
    const notional = params.price * params.size;
    if (notional > this.settings.maxOrderUsdc) {
      throw new Error(
        `Order notional ${notional.toFixed(2)} exceeds BOT_MAX_ORDER_USDC=${this.settings.maxOrderUsdc.toFixed(2)}`,
      );
    }

    const client = await getRuntimePolymarketService();
    const negRisk =
      params.negRisk !== undefined
        ? params.negRisk
        : await client.getNegRisk(params.tokenId);

    if (this.settings.dryRun) {
      return {
        dry_run: true,
        negRisk,
        price: params.price,
        side: params.side,
        size: params.size,
        tick_size: params.tickSize ?? "0.01",
        token_id: params.tokenId,
      };
    }

    try {
      return await client.placeLimitOrder({
        ...params,
        negRisk,
      });
    } catch (error) {
      throw new Error(`Polymarket placeLimitOrder failed: ${stringifyError(error)}`);
    }
  }

  async getOpenOrders(
    params?: OpenOrderParams,
    onlyFirstPage = true,
    nextCursor?: string,
  ): Promise<OpenOrder[]> {
    const client = await getRuntimePolymarketService();
    return client.getOpenOrders(params, onlyFirstPage, nextCursor);
  }

  async getOrder(orderId: string): Promise<OpenOrder> {
    const client = await getRuntimePolymarketService();
    return client.getOrder(orderId);
  }

  async cancelOrder(orderId: string): Promise<unknown> {
    const client = await getRuntimePolymarketService();
    return client.cancelOrder(orderId);
  }

  async cancelOrders(orderIds: string[]): Promise<unknown> {
    const client = await getRuntimePolymarketService();
    return client.cancelOrders(orderIds);
  }

  async getCollateralBalance(): Promise<number> {
    const client = await getRuntimePolymarketService();
    const balance = await client.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });
    return parseUsdc(balance.balance);
  }

  async getAvailableBalance(): Promise<number> {
    return this.getCollateralBalance();
  }

  async getConditionalBalance(tokenId: string): Promise<number> {
    const client = await getRuntimePolymarketService();
    const balance = await client.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenId,
    });
    return parseUsdc(balance.balance);
  }

  createBaseTradingClient(): TradingClient {
    return new TradingClient(this.settings);
  }
}

function parseUsdc(value: string): number {
  const parsed = Number(value) / 1_000_000;
  return Number.isFinite(parsed) ? parsed : 0;
}
