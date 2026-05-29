import { TopOfBook } from "./models.js";

interface BookLevel {
  price?: string | number;
  size?: string | number;
  quantity?: string | number;
}

interface OrderBookResponse {
  bids?: BookLevel[];
  asks?: BookLevel[];
}

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBookDepth {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

interface PriceHistoryPoint {
  t?: number;
  p?: number;
}

interface BatchPricesHistoryResponse {
  history?: Record<string, PriceHistoryPoint[]>;
}

export class ClobPublicClient {
  constructor(
    private readonly host: string,
    private readonly timeoutMs = 20_000,
  ) {}

  async getOrderBook(tokenId: string): Promise<OrderBookResponse> {
    const url = new URL("/book", this.host);
    url.searchParams.set("token_id", tokenId);

    const response = await fetch(url, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`CLOB API request failed: ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as OrderBookResponse;
  }

  async getTopOfBook(tokenId: string): Promise<TopOfBook> {
    const book = await this.getOrderBookDepth(tokenId);
    const bids = book.bids;
    const asks = book.asks;

    return new TopOfBook(
      bids.length > 0 ? bids[0].price : null,
      asks.length > 0 ? asks[0].price : null,
    );
  }

  async getOrderBookDepth(tokenId: string): Promise<OrderBookDepth> {
    const book = await this.getOrderBook(tokenId);
    return {
      bids: normalizeLevels(book.bids ?? []).sort((a, b) => b.price - a.price),
      asks: normalizeLevels(book.asks ?? []).sort((a, b) => a.price - b.price),
    };
  }

  async getBatchPricesHistory(params: {
    markets: string[];
    startTs?: number;
    endTs?: number;
    interval?: "max" | "all" | "1m" | "1w" | "1d" | "6h" | "1h";
    fidelity?: number;
  }): Promise<Record<string, Array<{ t: number; p: number }>>> {
    const url = new URL("/batch-prices-history", this.host);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        markets: params.markets,
        start_ts: params.startTs,
        end_ts: params.endTs,
        interval: params.interval,
        fidelity: params.fidelity,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`CLOB API request failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as BatchPricesHistoryResponse;
    const history = payload.history ?? {};

    return Object.fromEntries(
      Object.entries(history).map(([market, points]) => [
        market,
        (Array.isArray(points) ? points : [])
          .map((point) => ({
            t: Number(point.t),
            p: Number(point.p),
          }))
          .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.p)),
      ]),
    );
  }
}

function extractPrice(level: BookLevel): number | null {
  if (level.price === undefined) {
    return null;
  }

  const parsed = Number(level.price);
  return Number.isNaN(parsed) ? null : parsed;
}

function extractSize(level: BookLevel): number | null {
  const raw = level.size ?? level.quantity;
  if (raw === undefined) {
    return null;
  }

  const parsed = Number(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeLevels(levels: BookLevel[]): OrderBookLevel[] {
  return levels
    .map((level) => ({
      price: extractPrice(level),
      size: extractSize(level),
    }))
    .filter((level): level is OrderBookLevel =>
      level.price !== null &&
      level.size !== null &&
      Number.isFinite(level.price) &&
      Number.isFinite(level.size) &&
      level.price > 0 &&
      level.price < 1 &&
      level.size > 0,
    );
}
