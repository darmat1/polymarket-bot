import type { Btc15mMarketView } from "./types.js";

interface CryptoPriceResponse {
  openPrice?: unknown;
  closePrice?: unknown;
}

const CRYPTO_PRICE_URL = "https://polymarket.com/api/crypto/crypto-price";
const SYMBOL = "BTC";
const VARIANT_15M = "fifteen";

export class PolymarketCryptoPriceClient {
  constructor(private readonly timeoutMs = 10_000) {}

  async getBtc15mPriceToBeat(market: Btc15mMarketView): Promise<number | null> {
    const url = new URL(CRYPTO_PRICE_URL);
    url.searchParams.set("symbol", SYMBOL);
    url.searchParams.set("eventStartTime", formatIsoSeconds(market.startTimeMs));
    url.searchParams.set("variant", VARIANT_15M);
    url.searchParams.set("endDate", formatIsoSeconds(market.endTimeMs));

    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          referer: "https://polymarket.com/",
          "user-agent": "Mozilla/5.0",
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        return null;
      }

      const payload = await response.json() as CryptoPriceResponse;
      return parseFinitePositiveNumber(payload.openPrice);
    } catch {
      return null;
    }
  }
}

function formatIsoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parseFinitePositiveNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
