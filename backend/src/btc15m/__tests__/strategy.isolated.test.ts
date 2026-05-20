import assert from "node:assert/strict";

import { Btc15mBot, type Btc15mRuntime, type PlaceOrderArgs } from "../strategy.js";
import type { Btc15mBotConfig, Btc15mCompletedTrade, Btc15mMarketView } from "../types.js";

const config: Btc15mBotConfig = {
  workingBudgetUsd: 5,
  shares: 5,
  buyPrice: 0.25,
  trailStep: 0.05,
  trailDist: 0.02,
  trailUpdateIntervalSec: 3,
  repeatThresholdMin: 6,
  forceSellThresholdMin: 2,
  neutralZoneUsd: 5,
  tickIntervalSec: 2,
};

const market: Btc15mMarketView = {
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
  market: Btc15mMarketView | null;
  reserveThrows: boolean;
}> = {}) {
  let now = overrides.now ?? market.startTimeMs + 60_000;
  let currentBtc = overrides.currentBtc ?? 100_000;
  let startBtc = overrides.startBtc ?? 100_000;
  let nextMarket: Btc15mMarketView | null = overrides.market === undefined ? market : overrides.market;
  let reserved = 0;
  let consumed = 0;
  let added = 0;
  const orders: PlaceOrderArgs[] = [];
  const cancelled: string[] = [];
  const trades: Btc15mCompletedTrade[] = [];
  const listeners = new Map<string, BookListener>();

  const runtime: Btc15mRuntime = {
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
    setMarket(value: Btc15mMarketView | null) { nextMarket = value; },
  };
}

async function startStopTest() {
  const h = makeHarness();
  const bot = new Btc15mBot({ config, dryRun: true, runtime: h.runtime });
  assert.equal(bot.getStatus().enginePhase, "stopped");
  await bot.start({ scheduleLoop: false });
  assert.equal(bot.getStatus().enginePhase, "running");
  bot.stop();
  assert.equal(bot.getStatus().enginePhase, "stopped");
  console.log("strategy start/stop: OK");
}

async function placesBuyOnDownWhenBtcAboveStart() {
  const h = makeHarness({ currentBtc: 100_000 });
  const bot = new Btc15mBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });
  h.setCurrentBtc(100_100);
  await bot.runOneTick();
  assert.equal(h.orders.length, 1);
  assert.equal(h.orders[0].tokenId, "tok-down");
  assert.equal(h.orders[0].side, "buy");
  assert.equal(h.orders[0].price, 0.25);
  assert.equal(h.reserved, 1.25);
  assert.equal(bot.getStatus().cycle.cyclePhase, "buy_pending");
  bot.stop();
  console.log("placeBuy on DOWN: OK");
}

async function noOrderInsideNeutralZone() {
  const h = makeHarness({ currentBtc: 100_002 });
  const bot = new Btc15mBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });
  assert.equal(h.orders.length, 0);
  assert.equal(bot.getStatus().cycle.cyclePhase, "waiting_direction");
  bot.stop();
  console.log("neutral zone: OK");
}

async function cancelsBuyOnReturnToNeutralZone() {
  const h = makeHarness({ currentBtc: 100_100 });
  const bot = new Btc15mBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });
  assert.equal(h.orders.length, 1);
  h.setCurrentBtc(100_002);
  await bot.runOneTick();
  assert.deepEqual(h.cancelled, ["buy-1"]);
  assert.equal(h.reserved, 0);
  assert.equal(bot.getStatus().cycle.cyclePhase, "waiting_direction");
  bot.stop();
  console.log("cancel neutral buy: OK");
}

async function simBuyAndTargetSellFillCompletesTrade() {
  const h = makeHarness({ currentBtc: 100_100 });
  const bot = new Btc15mBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });

  // Buy fills → HOLDING, no sell placed yet (trailing stop, not immediate sell)
  h.listeners.get("tok-down")?.(null, 0.24);
  await bot.flushPendingActions();
  assert.equal(bot.getStatus().cycle.cyclePhase, "holding");
  assert.equal(h.orders.length, 1); // only the buy order so far
  assert.equal(bot.getStatus().cycle.sellOrder, null);
  assert.equal(h.consumed, 1.25);

  // Simulate bestBid = 0.38 > buyPrice(0.25) + trailStep(0.05) = 0.30 → trailing sell triggered
  // Fire the sell-mode listener to update the book snapshot
  h.listeners.get("tok-down")?.(0.38, null);
  await bot.flushPendingActions();

  // Run a tick so reconcileHolding fires the trailing stop logic
  await bot.runOneTick();
  assert.equal(h.orders.length, 2);
  assert.equal(h.orders[1].side, "sell");
  assert.equal(h.orders[1].price, 0.36); // 0.38 - trailDist(0.02)

  // Simulate bestBid = 0.37 >= sellOrder.price(0.36) → sell fills via book listener
  h.listeners.get("tok-down")?.(0.37, null);
  await bot.flushPendingActions();
  assert.equal(h.trades.length, 1);
  assert.equal(h.trades[0].result, "win");
  assert.equal(h.trades[0].exitReason, "target_sell");
  assert.equal(h.trades[0].pnlUsd, 0.55); // (0.36 - 0.25) * 5
  assert.equal(h.added, 1.8); // 0.36 * 5
  assert.equal(bot.getStatus().cycle.cyclePhase, "cycle_done");
  bot.stop();
  console.log("sim buy/sell fills: OK");
}

async function forceSellsAtBestBidWhenLate() {
  const h = makeHarness({ currentBtc: 100_100 });
  const bot = new Btc15mBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });
  // Buy fills → HOLDING, no sell placed yet
  h.listeners.get("tok-down")?.(null, 0.24);
  await bot.flushPendingActions();
  assert.equal(bot.getStatus().cycle.cyclePhase, "holding");
  // Update book snapshot with bestBid=0.2 (below trailStep threshold, so no trailing sell)
  h.listeners.get("tok-down")?.(0.2, null);
  // Run tick at late time (within force-sell threshold)
  h.setNow(market.endTimeMs - 60_000);
  await bot.runOneTick();
  // No existing sell to cancel; force sell placed at bestBid=0.2
  assert.equal(h.orders.at(-1)?.price, 0.2);
  assert.equal(bot.getStatus().cycle.cyclePhase, "market_idle");
  assert.equal(h.trades.at(-1)?.exitReason, "force_sell");
  assert.equal(h.trades.at(-1)?.result, "loss");
  bot.stop();
  console.log("force sell: OK");
}

async function repeatsAndSwitchesMarket() {
  const h = makeHarness({ currentBtc: 100_100 });
  const bot = new Btc15mBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });
  // Buy fills → HOLDING
  h.listeners.get("tok-down")?.(null, 0.24);
  await bot.flushPendingActions();
  // Set bestBid above trailStep threshold so reconcileHolding places trailing sell
  h.listeners.get("tok-down")?.(0.38, null);
  // Tick triggers reconcileHolding → trailing sell placed at 0.36
  await bot.runOneTick();
  assert.equal(bot.getStatus().cycle.sellOrder !== null, true);
  // Fire listener with bestBid >= sell price → sell fills
  h.listeners.get("tok-down")?.(0.41, null);
  await bot.flushPendingActions();
  assert.equal(bot.getStatus().cycle.cyclePhase, "cycle_done");
  // Tick → decideRepeat → waiting_direction (enough time left)
  await bot.runOneTick();
  assert.equal(bot.getStatus().cycle.cyclePhase, "waiting_direction");

  const nextMarket = { ...market, slug: "btc-updown-15m-1779221700", startTimeMs: market.endTimeMs, endTimeMs: market.endTimeMs + 900_000 };
  h.setNow(market.endTimeMs + 1_000);
  h.setMarket(nextMarket);
  h.setStartBtc(101_000);
  h.setCurrentBtc(101_000);
  await bot.runOneTick();
  assert.equal(bot.getStatus().market?.slug, nextMarket.slug);
  assert.equal(bot.getStatus().marketStartBtcPrice, 101_000);
  assert.equal(bot.getStatus().completedTrades.length, 1);
  bot.stop();
  console.log("repeat/switch market: OK");
}

async function autoStopsWhenBudgetReserveThrows() {
  const h = makeHarness({ currentBtc: 100_100, reserveThrows: true });
  const bot = new Btc15mBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });
  assert.equal(bot.getStatus().enginePhase, "auto_stopped");
  assert.match(bot.getStatus().lastError ?? "", /budget/i);
  bot.stop();
  console.log("budget auto-stop: OK");
}

async function main() {
  await startStopTest();
  await placesBuyOnDownWhenBtcAboveStart();
  await noOrderInsideNeutralZone();
  await cancelsBuyOnReturnToNeutralZone();
  await simBuyAndTargetSellFillCompletesTrade();
  await forceSellsAtBestBidWhenLate();
  await repeatsAndSwitchesMarket();
  await autoStopsWhenBudgetReserveThrows();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
