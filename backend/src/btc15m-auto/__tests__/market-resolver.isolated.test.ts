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

  // The slug suffix IS the canonical window-start time. Polymarket's `startDate` field is the
  // market LISTING date (often hours/days before the window), so we deliberately use a
  // listing-time that differs from window-start here to lock in the slug-priority behavior.
  const view = parseMarketView({
    slug: "btc-updown-15m-1779278400",
    question: "BTC up/down 15m",
    startDate: "2026-05-19T20:00:00.000Z", // listing date — must NOT be used as window start
    endDate: "2026-05-20T12:15:00.000Z",
    outcomes: JSON.stringify(["Up", "Down"]),
    clobTokenIds: JSON.stringify(["tok-up", "tok-down"]),
  }, "btc-updown-15m-1779278400");
  assert.equal(view?.upTokenId, "tok-up");
  assert.equal(view?.downTokenId, "tok-down");
  assert.equal(view?.startTimeMs, Date.parse("2026-05-20T12:00:00.000Z"));

  // Fallback when slug is malformed: derive from endDate - 900s.
  const fallback = parseMarketView({
    slug: "bad-slug",
    endDate: "2026-05-20T12:15:00.000Z",
    outcomes: JSON.stringify(["Up", "Down"]),
    clobTokenIds: JSON.stringify(["tok-up", "tok-down"]),
  }, "bad-slug");
  assert.equal(fallback?.startTimeMs, Date.parse("2026-05-20T12:00:00.000Z"));

  console.log("market-resolver: OK");
}

main();
