import assert from "node:assert/strict";

import { PolymarketCryptoPriceClient } from "../crypto-price-client.js";
import type { Btc15mMarketView } from "../types.js";

const market: Btc15mMarketView = {
  slug: "btc-updown-15m-1779231600",
  question: "BTC up/down 15m",
  startTimeMs: Date.parse("2026-05-19T23:00:00.000Z"),
  endTimeMs: Date.parse("2026-05-19T23:15:00.000Z"),
  priceToBeat: null,
  upTokenId: "tok-up",
  downTokenId: "tok-down",
};

async function main() {
  const originalFetch = globalThis.fetch;
  const seenUrls: string[] = [];

  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seenUrls.push(url);
      return new Response(JSON.stringify({ openPrice: 76643.27209766454 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const client = new PolymarketCryptoPriceClient();
    assert.equal(await client.getBtc15mPriceToBeat(market), 76643.27209766454);

    const url = new URL(seenUrls[0]);
    assert.equal(url.searchParams.get("symbol"), "BTC");
    assert.equal(url.searchParams.get("variant"), "fifteen");
    assert.equal(url.searchParams.get("eventStartTime"), "2026-05-19T23:00:00Z");
    assert.equal(url.searchParams.get("endDate"), "2026-05-19T23:15:00Z");

    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    assert.equal(await client.getBtc15mPriceToBeat(market), null);
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("crypto-price-client: OK");
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
