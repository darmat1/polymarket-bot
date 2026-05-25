import { AssetType, type OpenOrder, type OpenOrderParams } from "@polymarket/clob-client-v2";
import { ethers } from "ethers";

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

const POLYMARKET_DATA_API = "https://data-api.polymarket.com";

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
      const response = await client.placeLimitOrder({
        ...params,
        negRisk,
      });
      // Polymarket CLOB returns { success: false, errorMsg: "..." } for REJECTED orders without
      // throwing. Without this check the bot treated rejections as accepted orders → polling later
      // got 404 (no such order on Polymarket) → "not_found" sentinel → bot faked a fill →
      // phantom position in the UI with no real position on Polymarket. ALWAYS validate.
      const r = response as { success?: boolean; errorMsg?: string; orderID?: string };
      if (r && r.success === false) {
        throw new Error(`Polymarket rejected order: ${r.errorMsg ?? "unknown reason"}`);
      }
      return response;
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

  /**
   * Reconcile target — fetch the EXACT live state Polymarket has for a single token (asset id).
   * Returns the open buy/sell orders (raw orderId + price + sizes) and the current position
   * (size + avg entry). The bot in LIVE mode uses this every tick as the source of truth
   * instead of trusting its own cached state.
   */
  async getLiveStateForAsset(tokenId: string): Promise<{
    openOrders: Array<{ id: string; side: "buy" | "sell"; price: number; originalSize: number; matchedSize: number; status: string }>;
    position: { size: number; avgPrice: number } | null;
  }> {
    const client = await getRuntimePolymarketService();
    let openOrders: Array<{ id: string; side: "buy" | "sell"; price: number; originalSize: number; matchedSize: number; status: string }> = [];
    try {
      const orders = await client.getOpenOrders({ asset_id: tokenId }, false);
      openOrders = orders.map((o) => ({
        id: o.id,
        side: String(o.side).toLowerCase() === "buy" ? "buy" : "sell",
        price: parseFloat(o.price) || 0,
        originalSize: parseFloat(o.original_size) || 0,
        matchedSize: parseFloat(o.size_matched) || 0,
        status: o.status,
      }));
    } catch {
      // best-effort; treat as no open orders
    }
    // Position: query Polymarket data API directly to be robust.
    let position: { size: number; avgPrice: number } | null = null;
    try {
      const { getOpenPositions } = await import("./app.js");
      const payload = await getOpenPositions();
      const row = payload.positions?.find((p) => p.asset === tokenId);
      if (row && typeof row.size === "number" && row.size > 0) {
        position = {
          size: row.size,
          avgPrice: typeof row.avgPrice === "number" ? row.avgPrice : 0,
        };
      }
    } catch {
      // best-effort
    }
    return { openOrders, position };
  }

  /**
   * Fetch the actual settled trades for an order ID. A single limit order can match against
   * multiple counterparties at different prices, so to compute the TRUE avg fill price + total
   * fees we must aggregate across all trades, not just trust the limit price.
   */
  async getTradesForOrder(orderId: string): Promise<Array<{ price: number; size: number; feeRateBps: number; side: string }>> {
    const client = await getRuntimePolymarketService();
    const trades = await client.getTradesForOrder(orderId);
    // `getTrades({ id })` on Polymarket CLOB does NOT reliably filter by order id — it can
    // return ALL recent account trades. Without this defensive client-side filter we'd average
    // across multiple orders, producing systematic ~$0.02 price-recording errors.
    // Per Trade shape: our order is either the taker (taker_order_id) OR one of the makers
    // (maker_orders[].order_id). We aggregate per maker_order if WE were the maker, since each
    // maker entry has its own filled size/price/fee for the partial that matched US.
    const result: Array<{ price: number; size: number; feeRateBps: number; side: string }> = [];
    for (const t of trades) {
      const takerOrderId = (t as { taker_order_id?: string }).taker_order_id ?? "";
      const makerOrders = ((t as { maker_orders?: Array<{ order_id: string; price: string; matched_amount: string; fee_rate_bps: string; side?: string }> }).maker_orders) ?? [];
      if (takerOrderId === orderId) {
        // WE were the taker — use the trade-level price/size/fee (this represents our fill).
        result.push({
          price: parseFloat(t.price) || 0,
          size: parseFloat(t.size) || 0,
          feeRateBps: parseFloat(t.fee_rate_bps) || 0,
          side: String(t.side ?? ""),
        });
        continue;
      }
      const matchedMaker = makerOrders.find((m) => m.order_id === orderId);
      if (matchedMaker) {
        // WE were the maker — use the maker entry's price/matched_amount/fee.
        result.push({
          price: parseFloat(matchedMaker.price) || 0,
          size: parseFloat(matchedMaker.matched_amount) || 0,
          feeRateBps: parseFloat(matchedMaker.fee_rate_bps) || parseFloat(t.fee_rate_bps) || 0,
          side: String(matchedMaker.side ?? t.side ?? ""),
        });
      }
      // else: trade is unrelated to our order — skip.
    }
    return result;
  }

  async getRecentAccountTrades(): Promise<Array<{
    id: string;
    market: string;
    asset_id: string;
    side: string;
    size: string;
    fee_rate_bps: string;
    price: string;
    status: string;
    match_time: string;
    outcome: string;
    trader_side: "TAKER" | "MAKER";
  }>> {
    const users = resolvePolymarketUserAddresses(this.settings);
    if (!users.length) {
      return [];
    }
    const seen = new Set<string>();
    const allTrades: Array<{
      id: string;
      market: string;
      asset_id: string;
      side: string;
      size: string;
      fee_rate_bps: string;
      price: string;
      status: string;
      match_time: string;
      outcome: string;
      trader_side: "TAKER" | "MAKER";
    }> = [];
    for (const user of users) {
      const url = new URL("/trades", POLYMARKET_DATA_API);
      url.searchParams.set("user", user);
      url.searchParams.set("limit", "200");
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Polymarket trades: ${response.status} ${response.statusText}`);
      }
      const rows = (await response.json()) as Array<Record<string, unknown>>;
      for (const trade of rows) {
        const normalizedId = String(
          trade.id
            ?? trade.tradeID
            ?? trade.tradeId
            ?? trade.transactionHash
            ?? `${trade.asset ?? trade.asset_id ?? "asset"}-${trade.side ?? "side"}-${trade.timestamp ?? trade.match_time ?? trade.matchTime ?? "time"}`,
        );
        const normalized = {
          id: normalizedId,
          market: String(trade.market ?? trade.market_slug ?? trade.slug ?? ""),
          asset_id: String(trade.asset_id ?? trade.asset ?? ""),
          side: String(trade.side ?? ""),
          size: String(trade.size ?? ""),
          fee_rate_bps: String(trade.fee_rate_bps ?? trade.feeRateBps ?? "0"),
          price: String(trade.price ?? ""),
          status: String(trade.status ?? ""),
          match_time: String(trade.match_time ?? trade.matchTime ?? trade.timestamp ?? ""),
          outcome: String(trade.outcome ?? ""),
          trader_side: (String(trade.trader_side ?? trade.traderSide ?? "TAKER").toUpperCase() === "MAKER" ? "MAKER" : "TAKER") as "TAKER" | "MAKER",
        };
        if (!normalized.id || !normalized.market || !normalized.asset_id || seen.has(normalized.id)) {
          continue;
        }
        seen.add(normalized.id);
        allTrades.push(normalized);
      }
    }
    return allTrades;
  }

  async getOrderBook(tokenId: string): Promise<{ bestBid: number | null; bestAsk: number | null }> {
    const client = await getRuntimePolymarketService();
    const book = await client.getOrderBook(tokenId);
    // bids sorted desc by price, asks asc — but be defensive: scan for max bid / min ask.
    let bestBid: number | null = null;
    for (const b of book.bids ?? []) {
      const p = parseFloat(b.price);
      if (Number.isFinite(p) && (bestBid === null || p > bestBid)) bestBid = p;
    }
    let bestAsk: number | null = null;
    for (const a of book.asks ?? []) {
      const p = parseFloat(a.price);
      if (Number.isFinite(p) && (bestAsk === null || p < bestAsk)) bestAsk = p;
    }
    return { bestBid, bestAsk };
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

function resolvePolymarketUserAddresses(settings: Settings): string[] {
  const users = new Set<string>();
  const funder = settings.funderAddress?.trim();
  if (funder) {
    users.add(funder);
  }
  if (settings.privateKey) {
    const normalized = settings.privateKey.startsWith("0x")
      ? settings.privateKey
      : `0x${settings.privateKey}`;
    users.add(new ethers.Wallet(normalized).address);
  }
  return Array.from(users);
}
