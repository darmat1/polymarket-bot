import assert from "node:assert/strict";

import {
  currentWindowStartSec,
  nextWindowStartSec,
  parseMarketView,
  slugForWindow,
} from "../market-resolver.js";

function main() {
  const t = Date.UTC(2026, 4, 20, 12, 7, 13);
  const window = currentWindowStartSec(t);
  assert.equal(window, Date.UTC(2026, 4, 20, 12, 0, 0) / 1000);
  assert.equal(window % 900, 0);

  const next = nextWindowStartSec(t);
  assert.equal(next, Date.UTC(2026, 4, 20, 12, 15, 0) / 1000);

  const onBoundary = Date.UTC(2026, 4, 20, 12, 15, 0);
  assert.equal(currentWindowStartSec(onBoundary), Date.UTC(2026, 4, 20, 12, 15, 0) / 1000);

  assert.equal(slugForWindow(1779220800), "btc-updown-15m-1779220800");

  const view = parseMarketView({
    slug: "btc-updown-15m-1779220800",
    question: "BTC up/down 15m",
    startTime: "2026-05-20T12:00:00.000Z",
    startDate: "2026-05-19T11:00:00.000Z",
    endDate: "2026-05-20T12:15:00.000Z",
    outcomes: JSON.stringify(["Up", "Down"]),
    clobTokenIds: JSON.stringify(["tok-up", "tok-down"]),
    events: [{
      eventMetadata: {
        priceToBeat: 76643.27209766455,
      },
    }],
  }, "btc-updown-15m-1779220800");
  assert.equal(view?.upTokenId, "tok-up");
  assert.equal(view?.downTokenId, "tok-down");
  assert.equal(view?.startTimeMs, Date.parse("2026-05-20T12:00:00.000Z"));
  assert.equal(view?.priceToBeat, 76643.27209766455);

  console.log("market-resolver: OK");
}

main();
