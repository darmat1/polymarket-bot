import { TopOfBook } from "./models.js";

interface BookLevel {
  price?: string | number;
}

interface OrderBookResponse {
  bids?: BookLevel[];
  asks?: BookLevel[];
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
    const book = await this.getOrderBook(tokenId);
    const bids = book.bids ?? [];
    const asks = book.asks ?? [];

    return new TopOfBook(
      bids.length > 0 ? extractPrice(bids[0]) : null,
      asks.length > 0 ? extractPrice(asks[0]) : null,
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
