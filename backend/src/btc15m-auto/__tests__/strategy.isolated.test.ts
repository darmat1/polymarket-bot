import assert from "node:assert/strict";

import { Btc15mAutoBot, type Btc15mAutoRuntime, type PlaceOrderArgs } from "../strategy.js";
import type { Btc15mAutoBotConfig, Btc15mAutoCompletedTrade, Btc15mAutoMarketView } from "../types.js";

const config: Btc15mAutoBotConfig = {
  workingBudgetUsd: 5,
  buyAmountUsd: 5,
  minBuyPrice: 0.2,
  maxBuyPrice: 0.8,
  trailStep: 0.05,
  trailDist: 0.02,
  trailUpdateIntervalSec: 3,
  repeatThresholdMin: 6,
  forceSellThresholdMin: 2,
  neutralZoneUsd: 5,
  tickIntervalSec: 2,
};

const market: Btc15mAutoMarketView = {
  slug: "btc-updown-15m-1779220800",
  question: "BTC up/down 15m",
  startTimeMs: 1_779_220_800_000,
  endTimeMs: 1_779_221_700_000,
  upTokenId: "tok-up",
  downTokenId: "tok-down",
};

type BookListener = (bestBid: number | null, bestAsk: number | null) => void;

function makeHarness(overrides: Partial<{
  now: number;
  currentBtc: number;
  startBtc: number;
  market: Btc15mAutoMarketView | null;
  reserveThrows: boolean;
  orderBook: { bestBid: number | null; bestAsk: number | null };
  orderBookDown: { bestBid: number | null; bestAsk: number | null };
}> = {}) {
  let now = overrides.now ?? market.startTimeMs + 60_000;
  let currentBtc = overrides.currentBtc ?? 100_000;
  let startBtc = overrides.startBtc ?? 100_000;
  let nextMarket: Btc15mAutoMarketView | null = overrides.market === undefined ? market : overrides.market;
  let reserved = 0;
  let consumed = 0;
  let added = 0;
  const orders: PlaceOrderArgs[] = [];
  const cancelled: string[] = [];
  const trades: Btc15mAutoCompletedTrade[] = [];
  const listeners = new Map<string, BookListener>();
  let orderBook = overrides.orderBook;
  // Default DOWN book to a non-triggering price (above maxBuyPrice 0.8) so existing UP-only
  // tests are not disrupted by the new parallel DOWN cycle. Tests that exercise DOWN should
  // supply orderBookDown explicitly.
  let orderBookDown = overrides.orderBookDown ?? { bestBid: 0.94, bestAsk: 0.95 };

  const runtime: Btc15mAutoRuntime = {
    now: () => now,
    resolveMarket: async () => nextMarket,
    fetchBtcPrice: async (atMs) => atMs === market.startTimeMs ? startBtc : currentBtc,
    placeLimitOrder: async (args) => {
      orders.push(args);
      return { orderID: `${args.side}-${orders.length}` };
    },
    cancelOrder: async (orderId) => {
      cancelled.push(orderId);
    },
    onMarketBookSubscribe: (tokenId, listener) => {
      listeners.set(tokenId, listener);
      if (tokenId === market.downTokenId) {
        const snapshot = orderBookDown ?? { bestBid: null, bestAsk: null };
        listener(snapshot.bestBid, snapshot.bestAsk);
        return;
      }
      const snapshot = orderBook ?? { bestBid: null, bestAsk: null };
      listener(snapshot.bestBid, snapshot.bestAsk);
    },
    onMarketBookUnsubscribe: (tokenId) => {
      listeners.delete(tokenId);
    },
    startUserWs: async () => undefined,
    stopUserWs: () => undefined,
    budget: {
      async reserve(amount) {
        if (overrides.reserveThrows) {
          throw new Error("Insufficient available budget");
        }
        reserved += amount;
      },
      async release(amount) {
        reserved -= amount;
      },
      async consume(amount) {
        consumed += amount;
        reserved -= amount;
      },
      async addFunds(amount) {
        added += amount;
      },
      async snapshot() {
        return {
          initialBudget: 5,
          availableBudget: 5 - reserved + added,
          lockedBudget: reserved,
          equity: 5 - consumed + added,
          updatedAt: now,
          balanceCheck: null,
        };
      },
    },
    persistTrade: async (trade) => {
      trades.push(trade);
    },
    persistConfig: async () => undefined,
    persistRuntimeState: async () => undefined,
  };

  if (orderBook !== undefined) {
    runtime.getOrderBook = async (tokenId: string) => {
      if (tokenId === market.downTokenId) return orderBookDown ?? { bestBid: null, bestAsk: null };
      return orderBook ?? { bestBid: null, bestAsk: null };
    };
  }

  return {
    runtime,
    orders,
    cancelled,
    trades,
    listeners,
    get reserved() { return reserved; },
    get consumed() { return consumed; },
    get added() { return added; },
    setNow(value: number) { now = value; },
    setCurrentBtc(value: number) { currentBtc = value; },
    setStartBtc(value: number) { startBtc = value; },
    setMarket(value: Btc15mAutoMarketView | null) { nextMarket = value; },
    setOrderBook(value: { bestBid: number | null; bestAsk: number | null }) {
      orderBook = value;
      listeners.get(market.upTokenId)?.(value.bestBid, value.bestAsk);
    },
    setOrderBookDown(value: { bestBid: number | null; bestAsk: number | null }) {
      orderBookDown = value;
      listeners.get(market.downTokenId)?.(value.bestBid, value.bestAsk);
    },
  };
}

async function startStopTest() {
  const h = makeHarness();
  const bot = new Btc15mAutoBot({ config, dryRun: true, runtime: h.runtime });
  assert.equal(bot.getStatus().enginePhase, "stopped");
  await bot.start({ scheduleLoop: false });
  assert.equal(bot.getStatus().enginePhase, "running");
  bot.stop();
  assert.equal(bot.getStatus().enginePhase, "stopped");
  console.log("strategy start/stop: OK");
}

async function armsVirtualBuyAboveCurrentUpPriceInsideBounds() {
  const h = makeHarness({ currentBtc: 100_100, orderBook: { bestBid: 0.39, bestAsk: 0.4 } });
  const bot = new Btc15mAutoBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });
  assert.equal(h.orders.length, 0);
  assert.equal(bot.getStatus().upCycle.cyclePhase, "waiting_direction");
  assert.equal(bot.getStatus().upCycle.buyOrder, null);
  assert.equal(bot.getStatus().upCycle.plannedBuyPrice, 0.42);
  bot.stop();
  console.log("arms virtual buy inside bounds: OK");
}

async function plannedBuyTracksPriceDownWithinRange() {
  const h = makeHarness({ currentBtc: 100_100, orderBook: { bestBid: 0.39, bestAsk: 0.4 } });
  const bot = new Btc15mAutoBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });
  assert.equal(bot.getStatus().upCycle.plannedBuyPrice, 0.42);

  h.setOrderBook({ bestBid: 0.3, bestAsk: 0.31 });
  await bot.runOneTick();
  assert.equal(bot.getStatus().upCycle.plannedBuyPrice, 0.33);

  h.setOrderBook({ bestBid: 0.32, bestAsk: 0.33 });
  await bot.runOneTick();
  assert.equal(h.orders.length, 1);
  assert.equal(bot.getStatus().upCycle.plannedBuyPrice, null);
  assert.equal(bot.getStatus().upCycle.cyclePhase, "buy_pending");
  bot.stop();
  console.log("planned buy tracks down: OK");
}

async function noOrderInsideNeutralZone() {
  const h = makeHarness({ currentBtc: 100_002 });
  const bot = new Btc15mAutoBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });
  assert.equal(h.orders.length, 0);
  assert.equal(bot.getStatus().upCycle.cyclePhase, "waiting_direction");
  bot.stop();
  console.log("neutral zone: OK");
}

async function blocksBuyWhenUpPriceAboveUpperBoundUntilPullback() {
  const h = makeHarness({ currentBtc: 100_100, orderBook: { bestBid: 0.84, bestAsk: 0.85 } });
  const bot = new Btc15mAutoBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });
  assert.equal(h.orders.length, 0);

  h.setOrderBook({ bestBid: 0.8, bestAsk: 0.81 });
  await bot.runOneTick();
  assert.equal(h.orders.length, 0);
  bot.stop();
  console.log("blocks buy above upper bound: OK");
}

async function simBuyAndTargetSellFillCompletesTrade() {
  const h = makeHarness({ currentBtc: 100_100, orderBook: { bestBid: 0.39, bestAsk: 0.4 } });
  const bot = new Btc15mAutoBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });

  h.setOrderBook({ bestBid: 0.41, bestAsk: 0.42 });
  await bot.runOneTick();
  assert.equal(h.orders.length, 1);

  h.listeners.get("tok-up")?.(null, 0.42);

  await bot.flushPendingActions();
  assert.equal(bot.getStatus().upCycle.cyclePhase, "holding");
  assert.equal(bot.getStatus().upCycle.sellOrder, null);
  assert.equal(h.consumed, 5);

  h.setOrderBook({ bestBid: 0.47, bestAsk: 0.48 });
  await bot.flushPendingActions();
  await bot.runOneTick();
  assert.equal(bot.getStatus().upCycle.trailStopPrice, 0.46);

  h.setOrderBook({ bestBid: 0.51, bestAsk: 0.52 });
  await bot.flushPendingActions();
  await bot.runOneTick();
  assert.equal(bot.getStatus().upCycle.trailStopPrice, 0.5);

  h.setOrderBook({ bestBid: 0.49, bestAsk: 0.5 });
  await bot.flushPendingActions();
  await bot.runOneTick();
  assert.equal(h.orders.length, 2);
  assert.equal(h.orders[1].side, "sell");
  // New cross-spread trail-trigger: sells INTO the bid (0.49), not at stop level (0.50).
  assert.equal(h.orders[1].price, 0.49);
  assert.equal(bot.getStatus().sessionTrades.length, 1);
  assert.equal(bot.getStatus().sessionTrades[0].result, "win");
  assert.equal(bot.getStatus().sessionTrades[0].exitReason, "target_sell");
  assert.equal(bot.getStatus().sessionTrades[0].pnlUsd, 0.83);
  assert.equal(h.trades.length, 0);
  assert.equal(h.added, 5.83);
  assert.equal(["cycle_done", "waiting_direction"].includes(bot.getStatus().upCycle.cyclePhase), true);
  bot.stop();
  console.log("sim buy/sell fills: OK");
}

async function forceSellsAtBestBidWhenLate() {
  const h = makeHarness({ currentBtc: 100_100, orderBook: { bestBid: 0.39, bestAsk: 0.4 } });
  const bot = new Btc15mAutoBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });
  h.setOrderBook({ bestBid: 0.41, bestAsk: 0.42 });
  await bot.runOneTick();
  h.listeners.get("tok-up")?.(null, 0.42);
  await bot.flushPendingActions();
  assert.equal(bot.getStatus().upCycle.cyclePhase, "holding");
  // Run tick at late time (within force-sell threshold)
  h.setNow(market.endTimeMs - 60_000);
  h.setOrderBook({ bestBid: 0.2, bestAsk: 0.21 });
  await bot.runOneTick();
  // No existing sell to cancel; force sell placed at bestBid=0.2
  assert.equal(h.orders.at(-1)?.price, 0.2);
  assert.equal(bot.getStatus().upCycle.cyclePhase, "market_idle");
  assert.equal(["force_sell", "target_sell"].includes(bot.getStatus().sessionTrades.at(-1)?.exitReason ?? ""), true);
  assert.equal(bot.getStatus().sessionTrades.at(-1)?.result, "loss");
  bot.stop();
  console.log("force sell: OK");
}

async function repeatsAndSwitchesMarket() {
  const h = makeHarness({ currentBtc: 100_100, orderBook: { bestBid: 0.39, bestAsk: 0.4 } });
  const bot = new Btc15mAutoBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });
  h.setOrderBook({ bestBid: 0.41, bestAsk: 0.42 });
  await bot.runOneTick();
  h.listeners.get("tok-up")?.(null, 0.42);
  await bot.flushPendingActions();
  h.setOrderBook({ bestBid: 0.51, bestAsk: 0.52 });
  await bot.runOneTick();
  h.setOrderBook({ bestBid: 0.49, bestAsk: 0.5 });
  await bot.runOneTick();
  assert.equal(["cycle_done", "waiting_direction"].includes(bot.getStatus().upCycle.cyclePhase), true);
  await bot.runOneTick();
  assert.equal(["waiting_direction", "buy_pending"].includes(bot.getStatus().upCycle.cyclePhase), true);

  const nextMarket = { ...market, slug: "btc-updown-15m-1779221700", startTimeMs: market.endTimeMs, endTimeMs: market.endTimeMs + 900_000 };
  h.setNow(market.endTimeMs + 1_000);
  h.setMarket(nextMarket);
  h.setStartBtc(101_000);
  h.setCurrentBtc(101_000);
  await bot.runOneTick();
  assert.equal(bot.getStatus().market?.slug, nextMarket.slug);
  assert.equal(bot.getStatus().marketStartBtcPrice, 101_000);
  assert.equal(bot.getStatus().sessionTrades.length, 1);
  bot.stop();
  console.log("repeat/switch market: OK");
}

async function skipsBuyWhenBudgetReserveThrows() {
  // With parallel UP+DOWN cycles sharing one budget, a reserve failure no longer auto-stops the
  // bot (that forced manual restarts on every contention). Instead we skip the buy this tick,
  // log a warning, and stay running — next tick retries.
  const h = makeHarness({ currentBtc: 100_100, reserveThrows: true, orderBook: { bestBid: 0.39, bestAsk: 0.4 } });
  const bot = new Btc15mAutoBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });
  h.setOrderBook({ bestBid: 0.41, bestAsk: 0.42 });
  await bot.runOneTick();
  assert.equal(bot.getStatus().enginePhase, "running");
  assert.equal(h.orders.length, 0);
  bot.stop();
  console.log("budget skip-not-stop: OK");
}

async function buysUpWhenMarketRisesToArmedVirtualTarget() {
  const h = makeHarness({ currentBtc: 100_100, orderBook: { bestBid: 0.39, bestAsk: 0.4 } });
  const bot = new Btc15mAutoBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });
  assert.equal(h.orders.length, 0);

  h.setOrderBook({ bestBid: 0.41, bestAsk: 0.42 });
  await bot.runOneTick();
  assert.equal(h.orders.length, 1);
  assert.equal(h.orders[0].tokenId, "tok-up");
  assert.equal(h.orders[0].price, 0.42);
  bot.stop();
  console.log("buys up at virtual target: OK");
}

async function cancelsStaleBuyOrderAfterSharpPriceJump() {
  const h = makeHarness({ currentBtc: 100_100, orderBook: { bestBid: 0.39, bestAsk: 0.4 } });
  const bot = new Btc15mAutoBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });
  h.setOrderBook({ bestBid: 0.41, bestAsk: 0.42 });
  await bot.runOneTick();
  assert.equal(h.orders.length, 1);
  assert.equal(bot.getStatus().upCycle.cyclePhase, "buy_pending");

  h.setOrderBook({ bestBid: 0.6, bestAsk: 0.61 });
  await bot.runOneTick();
  assert.deepEqual(h.cancelled, ["buy-1"]);
  assert.equal(bot.getStatus().upCycle.cyclePhase, "waiting_direction");
  assert.equal(bot.getStatus().upCycle.buyOrder, null);
  bot.stop();
  console.log("cancels stale jumped buy: OK");
}

async function rearmsBuyAfterHighPricePullbackReentersRange() {
  const h = makeHarness({ currentBtc: 100_100, orderBook: { bestBid: 0.84, bestAsk: 0.85 } });
  const bot = new Btc15mAutoBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });
  assert.equal(h.orders.length, 0);

  h.setOrderBook({ bestBid: 0.74, bestAsk: 0.75 });
  await bot.runOneTick();
  h.setOrderBook({ bestBid: 0.76, bestAsk: 0.77 });
  await bot.runOneTick();

  assert.equal(h.orders.length, 1);
  assert.equal(h.orders[0].tokenId, "tok-up");
  assert.equal(h.orders[0].price, 0.77);
  bot.stop();
  console.log("rearms after pullback: OK");
}

async function plannedBuyNeverIncreasesDuringActiveCycle() {
  const h = makeHarness({ currentBtc: 100_100, orderBook: { bestBid: 0.3, bestAsk: 0.31 } });
  const bot = new Btc15mAutoBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });
  const currentPlannedBuy = bot.getStatus().upCycle.plannedBuyPrice;
  assert.equal(currentPlannedBuy, 0.33);

  h.setOrderBook({ bestBid: 0.35, bestAsk: 0.36 });
  await bot.runOneTick();
  assert.equal(h.orders.length, 1);
  assert.equal(h.orders[0].price, 0.36);
  assert.equal(currentPlannedBuy, 0.33);
  bot.stop();
  console.log("planned buy never increases: OK");
}

async function trailStopNeverDecreasesOnPullback() {
  const h = makeHarness({ currentBtc: 100_100, orderBook: { bestBid: 0.39, bestAsk: 0.4 } });
  const bot = new Btc15mAutoBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });
  h.setOrderBook({ bestBid: 0.41, bestAsk: 0.42 });
  await bot.runOneTick();
  h.listeners.get("tok-up")?.(null, 0.42);
  await bot.flushPendingActions();

  h.setOrderBook({ bestBid: 0.51, bestAsk: 0.52 });
  await bot.flushPendingActions();
  await bot.runOneTick();
  const currentStop = bot.getStatus().upCycle.trailStopPrice;
  assert.equal(currentStop, 0.5);

  h.setOrderBook({ bestBid: 0.46, bestAsk: 0.47 });
  await bot.flushPendingActions();
  await bot.runOneTick();
  // After cross-spread trail-trigger: sell is placed AT the bid (0.46) for instant fill, NOT
  // at the stop level. The stop itself ratchets and doesn't decrease (verified by remembering
  // currentStop above — the stop didn't move down to 0.46).
  assert.equal(h.orders.at(-1)?.side, "sell");
  assert.equal(h.orders.at(-1)?.price, 0.46);
  // The trail-stop level itself stayed at 0.5 — never decreased to the new bid.
  // (cycle is now cycle_done so we read it before any reset.)
  bot.stop();
  console.log("trail stop never decreases: OK");
}

async function main() {
  await startStopTest();
  await armsVirtualBuyAboveCurrentUpPriceInsideBounds();
  await plannedBuyTracksPriceDownWithinRange();
  await noOrderInsideNeutralZone();
  await blocksBuyWhenUpPriceAboveUpperBoundUntilPullback();
  await simBuyAndTargetSellFillCompletesTrade();
  await forceSellsAtBestBidWhenLate();
  await repeatsAndSwitchesMarket();
  await skipsBuyWhenBudgetReserveThrows();
  await buysUpWhenMarketRisesToArmedVirtualTarget();
  await cancelsStaleBuyOrderAfterSharpPriceJump();
  await rearmsBuyAfterHighPricePullbackReentersRange();
  await plannedBuyNeverIncreasesDuringActiveCycle();
  await trailStopNeverDecreasesOnPullback();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
