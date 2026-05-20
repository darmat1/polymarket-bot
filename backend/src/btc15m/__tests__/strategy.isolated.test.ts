import assert from "node:assert/strict";

import { Btc15mBot, type Btc15mRuntime, type PlaceOrderArgs } from "../strategy.js";
import type { Btc15mBotConfig, Btc15mCompletedTrade, Btc15mMarketView } from "../types.js";

const config: Btc15mBotConfig = {
  workingBudgetUsd: 5,
  shares: 5,
  buyPrice: 0.25,
  targetSellPrice: 0.8,
  fallbackSellPrice: 0.4,
  profitCheckDelayMin: 3,
  budgetResetIntervalHours: 3,
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
  priceToBeat: null,
  upTokenId: "tok-up",
  downTokenId: "tok-down",
};

type BookListener = (bestBid: number | null, bestAsk: number | null) => void;
type UserWsHandler = Parameters<Btc15mRuntime["startUserWs"]>[0];

function makeHarness(overrides: Partial<{
  now: number;
  currentBtc: number;
  startBtc: number;
  market: Btc15mMarketView | null;
  reserveThrows: boolean;
  livePosition: { bettingSide: "up" | "down"; tokenId: string; shares: number } | null;
  topOfBook: { bestBid: number | null; bestAsk: number | null };
  slowAddFunds: boolean;
  addedFunds: number;
  lastProfitResetAt: number;
}> = {}) {
  let now = overrides.now ?? market.startTimeMs + 60_000;
  let currentBtc = overrides.currentBtc ?? 100_000;
  let startBtc = overrides.startBtc ?? 100_000;
  let nextMarket: Btc15mMarketView | null = overrides.market === undefined ? market : overrides.market;
  let reserved = 0;
  let consumed = 0;
  let added = overrides.addedFunds ?? 0;
  let lastProfitResetAt = overrides.lastProfitResetAt ?? now;
  let skimmedProfitUsd = 0;
  let livePosition = overrides.livePosition ?? null;
  const orders: PlaceOrderArgs[] = [];
  const cancelled: string[] = [];
  const trades: Btc15mCompletedTrade[] = [];
  const listeners = new Map<string, BookListener>();
  let userWsHandler: UserWsHandler | null = null;

  const runtime: Btc15mRuntime = {
    now: () => now,
    resolveMarket: async () => nextMarket,
    fetchBtcPrice: async () => currentBtc,
    fetchMarketStartPrice: async () => startBtc,
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
    startUserWs: async (handler) => {
      userWsHandler = handler;
    },
    stopUserWs: () => {
      userWsHandler = null;
    },
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
        if (overrides.slowAddFunds) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        added += amount;
      },
      async resetAvailableBudget(maxAvailable, resetAt) {
        const availableBudget = 5 - reserved + added;
        const skimmed = reserved <= 0 && availableBudget > maxAvailable
          ? Math.round((availableBudget - maxAvailable) * 100) / 100
          : 0;
        if (skimmed > 0) {
          added -= skimmed;
          skimmedProfitUsd = Math.round((skimmedProfitUsd + skimmed) * 100) / 100;
        }
        lastProfitResetAt = resetAt;
        return {
          skimmedProfitUsd: skimmed,
          snapshot: {
            initialBudget: 5,
            availableBudget: 5 - reserved + added,
            lockedBudget: reserved,
            equity: 5 - consumed + added,
            updatedAt: resetAt,
            balanceCheck: null,
            lastProfitResetAt,
            skimmedProfitUsd,
          },
        };
      },
      async snapshot() {
        return {
          initialBudget: 5,
          availableBudget: 5 - reserved + added,
          lockedBudget: reserved,
          equity: 5 - consumed + added,
          updatedAt: now,
          balanceCheck: null,
          lastProfitResetAt,
          skimmedProfitUsd,
        };
      },
    },
    persistTrade: async (trade) => {
      trades.push(trade);
    },
    persistConfig: async () => undefined,
    persistRuntimeState: async () => undefined,
    getLivePosition: async () => livePosition,
    getTopOfBook: async () => overrides.topOfBook ?? { bestBid: 0.2, bestAsk: 0.21 },
  };

  return {
    runtime,
    orders,
    cancelled,
    trades,
    listeners,
    emitUserWs(message: Parameters<UserWsHandler>[0]) {
      userWsHandler?.(message);
    },
    get reserved() { return reserved; },
    get consumed() { return consumed; },
    get added() { return added; },
    get lastProfitResetAt() { return lastProfitResetAt; },
    get skimmedProfitUsd() { return skimmedProfitUsd; },
    setLivePosition(value: { bettingSide: "up" | "down"; tokenId: string; shares: number } | null) { livePosition = value; },
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
  await bot.stop();
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
  await bot.stop();
  console.log("placeBuy on DOWN: OK");
}

async function usesPolymarketStartPriceNotCurrentTickForDirection() {
  const h = makeHarness({ currentBtc: 76_745.79, startBtc: 76_643.27209766455 });
  const bot = new Btc15mBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });

  assert.equal(bot.getStatus().marketStartBtcPrice, 76_643.27209766455);
  assert.equal(h.orders.length, 1);
  assert.equal(h.orders[0].tokenId, "tok-down");
  assert.equal(bot.getStatus().cycle.buyOrder?.bettingSide, "down");
  await bot.stop();
  console.log("polymarket start price direction: OK");
}

async function doesNotTradeWhenPolymarketStartPriceUnavailable() {
  const h = makeHarness({ currentBtc: 100_100 });
  h.runtime.fetchMarketStartPrice = async () => null;
  const bot = new Btc15mBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });

  assert.equal(bot.getStatus().marketStartBtcPrice, null);
  assert.equal(h.orders.length, 0);
  assert.equal(bot.getStatus().cycle.cyclePhase, "waiting_direction");
  await bot.stop();
  console.log("missing polymarket start price blocks trading: OK");
}

async function noOrderInsideNeutralZone() {
  const h = makeHarness({ currentBtc: 100_002 });
  const bot = new Btc15mBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });
  assert.equal(h.orders.length, 0);
  assert.equal(bot.getStatus().cycle.cyclePhase, "waiting_direction");
  await bot.stop();
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
  await bot.stop();
  console.log("cancel neutral buy: OK");
}

async function simBuyAndTargetSellFillCompletesTrade() {
  const h = makeHarness({ currentBtc: 100_100 });
  const bot = new Btc15mBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });
  h.listeners.get("tok-down")?.(null, 0.24);
  await bot.flushPendingActions();
  assert.equal(bot.getStatus().cycle.cyclePhase, "holding");
  assert.equal(h.orders.length, 2);
  assert.equal(h.orders[1].side, "sell");
  assert.equal(h.orders[1].price, 0.8);
  assert.equal(h.consumed, 1.25);

  h.listeners.get("tok-down")?.(0.81, null);
  await bot.flushPendingActions();
  assert.equal(h.trades.length, 1);
  assert.equal(h.trades[0].result, "win");
  assert.equal(h.trades[0].exitReason, "target_sell");
  assert.equal(h.trades[0].pnlUsd, 2.75);
  assert.equal(h.added, 4);
  assert.equal(bot.getStatus().cycle.cyclePhase, "cycle_done");
  await bot.stop();
  console.log("sim buy/sell fills: OK");
}

async function forceSellsAtBestBidWhenLate() {
  const h = makeHarness({ currentBtc: 100_100 });
  const bot = new Btc15mBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });
  h.listeners.get("tok-down")?.(null, 0.24);
  await bot.flushPendingActions();
  h.listeners.get("tok-down")?.(0.2, null);
  h.setNow(market.endTimeMs - 60_000);
  await bot.runOneTick();
  assert.equal(h.cancelled.includes("sell-2"), true);
  assert.equal(h.orders.at(-1)?.price, 0.2);
  assert.equal(bot.getStatus().cycle.cyclePhase, "market_idle");
  assert.equal(h.trades.at(-1)?.exitReason, "force_sell");
  assert.equal(h.trades.at(-1)?.result, "loss");
  await bot.stop();
  console.log("force sell: OK");
}

async function forceSellUsesClobMinimumWhenBestBidIsTooLow() {
  const h = makeHarness({
    currentBtc: 100_100,
    topOfBook: { bestBid: 0.002, bestAsk: 0.003 },
  });
  const bot = new Btc15mBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });
  h.listeners.get("tok-down")?.(null, 0.24);
  await bot.flushPendingActions();

  h.setNow(market.endTimeMs - 60_000);
  await bot.runOneTick();
  await bot.flushPendingActions();

  assert.equal(h.cancelled.includes("sell-2"), true);
  assert.equal(h.orders.at(-1)?.side, "sell");
  assert.equal(h.orders.at(-1)?.price, 0.01);
  assert.equal(h.trades.length, 0);
  assert.equal(bot.getStatus().cycle.cyclePhase, "force_selling");
  assert.equal(bot.getStatus().logs.some((entry) => /below CLOB minimum/i.test(entry.message)), true);
  await bot.stop();
  console.log("force sell clamps below-min bid: OK");
}

async function profitCheckSellsAtCurrentBidAboveFallback() {
  const h = makeHarness({
    currentBtc: 100_100,
    topOfBook: { bestBid: 0.55, bestAsk: 0.56 },
  });
  const bot = new Btc15mBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });
  h.listeners.get("tok-down")?.(null, 0.24);
  await bot.flushPendingActions();

  h.setNow(market.startTimeMs + 60_000 + config.profitCheckDelayMin * 60_000);
  await bot.runOneTick();
  await bot.flushPendingActions();

  assert.equal(h.cancelled.includes("sell-2"), true);
  assert.equal(h.orders.at(-1)?.side, "sell");
  assert.equal(h.orders.at(-1)?.price, 0.55);
  assert.equal(h.trades.length, 1);
  assert.equal(h.trades[0].sellPrice, 0.55);
  assert.equal(h.trades[0].exitReason, "target_sell");
  await bot.stop();
  console.log("profit check sells at current bid: OK");
}

async function profitCheckFallsBackToSecondThresholdBelowFallback() {
  const h = makeHarness({
    currentBtc: 100_100,
    topOfBook: { bestBid: 0.33, bestAsk: 0.34 },
  });
  const bot = new Btc15mBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });
  h.listeners.get("tok-down")?.(null, 0.24);
  await bot.flushPendingActions();

  h.setNow(market.startTimeMs + 60_000 + config.profitCheckDelayMin * 60_000);
  await bot.runOneTick();
  await bot.flushPendingActions();

  assert.equal(h.cancelled.includes("sell-2"), true);
  assert.equal(h.orders.at(-1)?.side, "sell");
  assert.equal(h.orders.at(-1)?.price, 0.4);
  assert.equal(h.trades.length, 0);
  assert.equal(bot.getStatus().cycle.cyclePhase, "holding");
  assert.equal(bot.getStatus().cycle.sellOrder?.price, 0.4);
  await bot.stop();
  console.log("profit check falls back: OK");
}

async function stopsReEnteringSameMarketAfterCompletedTrade() {
  const h = makeHarness({ currentBtc: 100_100 });
  const bot = new Btc15mBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });
  h.listeners.get("tok-down")?.(null, 0.24);
  await bot.flushPendingActions();
  h.listeners.get("tok-down")?.(0.81, null);
  await bot.flushPendingActions();
  await bot.runOneTick();
  assert.equal(bot.getStatus().cycle.cyclePhase, "market_idle");

  const nextMarket = { ...market, slug: "btc-updown-15m-1779221700", startTimeMs: market.endTimeMs, endTimeMs: market.endTimeMs + 900_000 };
  h.setNow(market.endTimeMs + 1_000);
  h.setMarket(nextMarket);
  h.setStartBtc(101_000);
  h.setCurrentBtc(101_000);
  await bot.runOneTick();
  assert.equal(bot.getStatus().market?.slug, nextMarket.slug);
  assert.equal(bot.getStatus().marketStartBtcPrice, 101_000);
  assert.equal(bot.getStatus().completedTrades.length, 1);
  await bot.stop();
  console.log("no re-entry within same market: OK");
}

async function autoStopsWhenBudgetReserveThrows() {
  const h = makeHarness({ currentBtc: 100_100, reserveThrows: true });
  const bot = new Btc15mBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });
  assert.equal(bot.getStatus().enginePhase, "auto_stopped");
  assert.match(bot.getStatus().lastError ?? "", /budget/i);
  await bot.stop();
  console.log("budget auto-stop: OK");
}

async function livePositionRecoveryForceSellsWhenWsFillWasMissed() {
  const h = makeHarness({
    currentBtc: 99_900,
    now: market.endTimeMs - 90_000,
    livePosition: { bettingSide: "up", tokenId: "tok-up", shares: 5 },
    topOfBook: { bestBid: 0.03, bestAsk: 0.04 },
  });
  const bot = new Btc15mBot({ config, dryRun: false, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });

  assert.equal(h.orders.length, 1);
  assert.equal(h.orders[0].side, "sell");
  assert.equal(h.orders[0].tokenId, "tok-up");
  assert.equal(h.orders[0].price, 0.03);
  assert.equal(bot.getStatus().cycle.cyclePhase, "force_selling");
  assert.equal(bot.getStatus().cycle.position?.shares, 5);
  assert.equal(bot.getStatus().logs.some((entry) => /Recovered LIVE position/i.test(entry.message)), true);

  await bot.stop();
  console.log("live position recovery force sell: OK");
}

async function recordsSellFillWhenLivePositionDisappears() {
  const now = market.endTimeMs - 60_000;
  const h = makeHarness({
    currentBtc: 100_100,
    now,
    livePosition: null,
  });
  const bot = new Btc15mBot({
    config,
    dryRun: false,
    runtime: h.runtime,
    initialRuntimeState: {
      market,
      marketStartBtcPrice: 100_000,
      currentBtcPrice: 100_100,
      cycle: {
        cyclePhase: "force_selling",
        cycleStartedAt: now - 8 * 60_000,
        buyOrder: null,
        sellOrder: {
          id: "sell",
          orderId: "sell-order",
          side: "sell",
          tokenId: "tok-down",
          bettingSide: "down",
          price: 0.2,
          size: 5,
          filledSize: 0,
          status: "open",
          reservedBudget: 0,
          createdAt: now - 30_000,
          updatedAt: now - 30_000,
        },
        position: {
          bettingSide: "down",
          tokenId: "tok-down",
          shares: 5,
          avgEntryPrice: 0.25,
          costBasisUsd: 1.25,
        },
      },
      logs: [],
      lastError: null,
    },
  });

  await bot.start({ scheduleLoop: false, runImmediateTick: false });
  await bot.runOneTick();

  assert.equal(h.trades.length, 1);
  assert.equal(h.trades[0].sellPrice, 0.2);
  assert.equal(h.trades[0].pnlUsd, -0.25);
  assert.equal(h.trades[0].result, "loss");
  assert.equal(h.trades[0].exitReason, "force_sell");
  assert.equal(bot.getStatus().cycle.position, null);
  assert.equal(bot.getStatus().completedTrades.length, 1);
  await bot.stop();
  console.log("missing sell fill reconciliation: OK");
}

async function recordsResolvedLossWhenMarketExpiresWithUnsoldPosition() {
  const expiredMarket = { ...market };
  const nextMarket = {
    ...market,
    slug: "btc-updown-15m-1779221700",
    startTimeMs: market.endTimeMs,
    endTimeMs: market.endTimeMs + 900_000,
  };
  const h = makeHarness({
    market: nextMarket,
    currentBtc: 99_900,
    startBtc: 100_000,
    now: expiredMarket.endTimeMs + 1_000,
    livePosition: { bettingSide: "up", tokenId: "tok-up", shares: 5 },
  });
  const bot = new Btc15mBot({
    config,
    dryRun: false,
    runtime: h.runtime,
    initialRuntimeState: {
      market: expiredMarket,
      marketStartBtcPrice: 100_000,
      currentBtcPrice: 100_090,
      cycle: {
        cyclePhase: "force_selling",
        cycleStartedAt: expiredMarket.startTimeMs + 60_000,
        buyOrder: null,
        sellOrder: {
          id: "sell",
          orderId: "sell-order",
          side: "sell",
          tokenId: "tok-up",
          bettingSide: "up",
          price: 0.08,
          size: 5,
          filledSize: 0,
          status: "open",
          reservedBudget: 0,
          createdAt: expiredMarket.endTimeMs - 60_000,
          updatedAt: expiredMarket.endTimeMs - 60_000,
        },
        position: {
          bettingSide: "up",
          tokenId: "tok-up",
          shares: 5,
          avgEntryPrice: 0.25,
          costBasisUsd: 1.25,
        },
      },
      logs: [],
      lastError: null,
    },
  });

  await bot.start({ scheduleLoop: false, runImmediateTick: false });
  await bot.runOneTick();

  assert.equal(h.trades.length, 1);
  assert.equal(h.trades[0].sellPrice, 0);
  assert.equal(h.trades[0].pnlUsd, -1.25);
  assert.equal(h.trades[0].result, "loss");
  assert.equal(h.trades[0].exitReason, "resolved_unfilled");
  assert.equal(bot.getStatus().market?.slug, nextMarket.slug);
  await bot.stop();
  console.log("expired market unresolved loss: OK");
}

async function stopCancelsOpenBuyAndReleasesBudget() {
  const h = makeHarness({ currentBtc: 99_900 });
  const bot = new Btc15mBot({ config, dryRun: false, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });

  assert.equal(bot.getStatus().cycle.cyclePhase, "buy_pending");
  assert.equal(h.reserved, 1.25);

  await bot.stop();

  assert.deepEqual(h.cancelled, ["buy-1"]);
  assert.equal(h.reserved, 0);
  assert.equal(bot.getStatus().enginePhase, "stopped");
  assert.equal(bot.getStatus().cycle.buyOrder, null);
  assert.equal(bot.getStatus().cycle.cyclePhase, "waiting_market");
  assert.equal(bot.getStatus().budget?.availableBudget, 5);
  assert.equal(bot.getStatus().budget?.lockedBudget, 0);
  console.log("stop cancels open buy: OK");
}

async function cancelsPendingBuyBeforeEntryCutoff() {
  const h = makeHarness({ currentBtc: 99_900, now: market.endTimeMs - 7 * 60_000 });
  const bot = new Btc15mBot({ config, dryRun: false, runtime: h.runtime });
  await bot.start({ scheduleLoop: false, runImmediateTick: false });

  await bot.runOneTick();
  assert.equal(bot.getStatus().cycle.cyclePhase, "buy_pending");
  assert.equal(h.orders.length, 1);

  h.setNow(market.endTimeMs - 5 * 60_000);
  await bot.runOneTick();

  assert.deepEqual(h.cancelled, ["buy-1"]);
  assert.equal(h.reserved, 0);
  assert.equal(bot.getStatus().cycle.cyclePhase, "market_idle");
  assert.equal(bot.getStatus().cycle.buyOrder, null);
  assert.equal(h.orders.length, 1);
  await bot.stop();
  console.log("entry cutoff cancels pending buy: OK");
}

async function doesNotOpenNewBuyInsideEntryCutoff() {
  const h = makeHarness({
    currentBtc: 100_100,
    now: market.endTimeMs - 5 * 60_000,
  });
  const bot = new Btc15mBot({ config, dryRun: false, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });

  assert.equal(h.orders.length, 0);
  assert.equal(bot.getStatus().cycle.cyclePhase, "market_idle");
  await bot.stop();
  console.log("entry cutoff blocks new buy: OK");
}

async function holdingWaitsUntilForceSellCutoff() {
  const h = makeHarness({
    currentBtc: 100_100,
    now: market.endTimeMs - 5 * 60_000,
    livePosition: { bettingSide: "down", tokenId: "tok-down", shares: 5 },
  });
  const bot = new Btc15mBot({
    config,
    dryRun: false,
    runtime: h.runtime,
    initialRuntimeState: {
      market,
      marketStartBtcPrice: 100_000,
      currentBtcPrice: 100_100,
      cycle: {
        cyclePhase: "holding",
        cycleStartedAt: market.startTimeMs + 60_000,
        buyOrder: null,
        sellOrder: {
          id: "sell",
          orderId: "sell-order",
          side: "sell",
          tokenId: "tok-down",
          bettingSide: "down",
          price: 0.8,
          size: 5,
          filledSize: 0,
          status: "open",
          reservedBudget: 0,
          createdAt: market.endTimeMs - 6 * 60_000,
          updatedAt: market.endTimeMs - 6 * 60_000,
        },
        position: {
          bettingSide: "down",
          tokenId: "tok-down",
          shares: 5,
          avgEntryPrice: 0.25,
          costBasisUsd: 1.25,
        },
      },
      logs: [],
      lastError: null,
    },
  });

  await bot.start({ scheduleLoop: false, runImmediateTick: false });
  await bot.runOneTick();

  assert.equal(h.cancelled.includes("sell-order"), false);
  assert.equal(h.orders.length, 0);
  assert.equal(bot.getStatus().cycle.cyclePhase, "holding");
  await bot.stop();
  console.log("holding waits until force cutoff: OK");
}

async function flipsStalePendingBuyWhenDirectionChanges() {
  const h = makeHarness({ currentBtc: 100_100 });
  const bot = new Btc15mBot({
    config,
    dryRun: false,
    runtime: h.runtime,
    initialRuntimeState: {
      market,
      marketStartBtcPrice: 100_000,
      currentBtcPrice: 99_900,
      cycle: {
        cyclePhase: "buy_pending",
        cycleStartedAt: market.startTimeMs + 30_000,
        buyOrder: {
          id: "stale-buy",
          orderId: "stale-up-order",
          side: "buy",
          tokenId: "tok-up",
          bettingSide: "up",
          price: 0.25,
          size: 5,
          filledSize: 0,
          status: "open",
          reservedBudget: 1.25,
          createdAt: market.startTimeMs + 30_000,
          updatedAt: market.startTimeMs + 30_000,
        },
        sellOrder: null,
        position: null,
      },
      logs: [],
      lastError: null,
    },
  });

  await bot.start({ scheduleLoop: false, runImmediateTick: false });
  await bot.runOneTick();

  assert.deepEqual(h.cancelled, ["stale-up-order"]);
  assert.equal(h.orders.length, 1);
  assert.equal(h.orders[0].tokenId, "tok-down");
  assert.equal(h.orders[0].side, "buy");
  assert.equal(bot.getStatus().cycle.buyOrder?.bettingSide, "down");
  assert.equal(bot.getStatus().cycle.cyclePhase, "buy_pending");
  await bot.stop();
  console.log("direction flip cancels stale buy: OK");
}

async function deduplicatesConcurrentSellFills() {
  const h = makeHarness({ currentBtc: 100_100, slowAddFunds: true });
  const bot = new Btc15mBot({ config, dryRun: true, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });
  h.listeners.get("tok-down")?.(null, 0.24);
  await bot.flushPendingActions();

  const listener = h.listeners.get("tok-down");
  listener?.(0.81, null);
  listener?.(0.81, null);
  listener?.(0.81, null);
  await bot.flushPendingActions();

  assert.equal(h.trades.length, 1);
  assert.equal(bot.getStatus().completedTrades.length, 1);
  assert.equal(h.added, 4);
  assert.equal(bot.getStatus().cycle.cyclePhase, "cycle_done");
  await bot.stop();
  console.log("dedupe concurrent sell fills: OK");
}

async function ignoresLiveFillEventsForSameAssetWithDifferentOrderId() {
  const h = makeHarness({ currentBtc: 100_100 });
  const bot = new Btc15mBot({ config, dryRun: false, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });
  assert.equal(bot.getStatus().cycle.buyOrder?.orderId, "buy-1");

  h.emitUserWs({
    eventType: "order",
    status: "matched",
    type: null,
    side: null,
    orderId: "other-order",
    assetIds: ["tok-down"],
    raw: { size: "5" },
  });
  await bot.flushPendingActions();

  assert.equal(h.trades.length, 0);
  assert.equal(bot.getStatus().cycle.cyclePhase, "buy_pending");
  assert.equal(bot.getStatus().cycle.buyOrder?.orderId, "buy-1");
  await bot.stop();
  console.log("ignore same-asset wrong-order live fill: OK");
}

async function doesNotRecoverLivePositionAfterCompletedTradeForSameMarket() {
  const h = makeHarness({
    currentBtc: 100_100,
    livePosition: { bettingSide: "down", tokenId: "tok-down", shares: 4.99 },
  });
  const completed: Btc15mCompletedTrade = {
    id: "done",
    marketSlug: market.slug,
    bettingSide: "down",
    buyPrice: 0.25,
    sellPrice: 0.4,
    shares: 4.99,
    pnlUsd: 0.75,
    result: "win",
    exitReason: "target_sell",
    startedAt: market.startTimeMs + 10_000,
    closedAt: market.startTimeMs + 20_000,
  };
  const bot = new Btc15mBot({
    config,
    dryRun: false,
    runtime: h.runtime,
    initialTrades: [completed],
    initialRuntimeState: {
      market,
      marketStartBtcPrice: 100_000,
      currentBtcPrice: 100_100,
      cycle: {
        cyclePhase: "cycle_done",
        cycleStartedAt: completed.startedAt,
        buyOrder: null,
        sellOrder: null,
        position: null,
      },
      logs: [],
      lastError: null,
    },
  });

  await bot.start({ scheduleLoop: false, runImmediateTick: false });
  await bot.runOneTick();

  assert.equal(h.orders.length, 0);
  assert.equal(bot.getStatus().cycle.position, null);
  assert.equal(bot.getStatus().completedTrades.length, 1);
  await bot.stop();
  console.log("skip recovered position after completed market trade: OK");
}

async function activeBuyStillRecoversAfterPreviousSameSideTrade() {
  const h = makeHarness({
    currentBtc: 99_900,
    livePosition: { bettingSide: "up", tokenId: "tok-up", shares: 5 },
  });
  const completed: Btc15mCompletedTrade = {
    id: "previous",
    marketSlug: market.slug,
    bettingSide: "up",
    buyPrice: 0.25,
    sellPrice: 0.4,
    shares: 5,
    pnlUsd: 0.75,
    result: "win",
    exitReason: "target_sell",
    startedAt: market.startTimeMs + 10_000,
    closedAt: market.startTimeMs + 20_000,
  };
  const bot = new Btc15mBot({
    config,
    dryRun: false,
    runtime: h.runtime,
    initialTrades: [completed],
  });

  await bot.start({ scheduleLoop: false });

  assert.equal(h.orders.length, 1);
  assert.equal(h.orders[0].side, "buy");
  await bot.runOneTick();

  assert.equal(h.orders.length, 2);
  assert.equal(h.orders[1].side, "sell");
  assert.equal(h.orders[1].tokenId, "tok-up");
  assert.equal(bot.getStatus().cycle.cyclePhase, "holding");
  assert.equal(bot.getStatus().cycle.sellOrder?.orderId, "sell-2");
  await bot.stop();
  console.log("active buy recovers after previous same-side trade: OK");
}

async function partialBuyFillCancelsRemainingOrderBeforeHolding() {
  const h = makeHarness({ currentBtc: 99_900 });
  const bot = new Btc15mBot({ config, dryRun: false, runtime: h.runtime });
  await bot.start({ scheduleLoop: false });

  h.setLivePosition({ bettingSide: "up", tokenId: "tok-up", shares: 2.3 });
  await bot.runOneTick();

  assert.deepEqual(h.cancelled, ["buy-1"]);
  assert.equal(bot.getStatus().cycle.cyclePhase, "holding");
  assert.equal(bot.getStatus().cycle.position?.shares, 2.3);
  assert.equal(bot.getStatus().cycle.sellOrder?.size, 2.3);
  assert.equal(h.orders.at(-1)?.side, "sell");
  await bot.stop();
  console.log("partial buy fill cancels remainder: OK");
}

async function matchedSellEventDoesNotCloseWholePosition() {
  const h = makeHarness();
  const bot = new Btc15mBot({
    config,
    dryRun: false,
    runtime: h.runtime,
    initialRuntimeState: {
      market,
      marketStartBtcPrice: 100_000,
      currentBtcPrice: 99_900,
      cycle: {
        cyclePhase: "holding",
        cycleStartedAt: market.startTimeMs + 30_000,
        buyOrder: null,
        sellOrder: {
          id: "sell-order",
          orderId: "sell-order",
          side: "sell",
          tokenId: "tok-up",
          bettingSide: "up",
          price: 0.8,
          size: 5,
          filledSize: 0,
          status: "open",
          reservedBudget: 0,
          createdAt: market.startTimeMs + 45_000,
          updatedAt: market.startTimeMs + 45_000,
        },
        position: {
          bettingSide: "up",
          tokenId: "tok-up",
          shares: 5,
          avgEntryPrice: 0.25,
          costBasisUsd: 1.25,
        },
      },
      logs: [],
      lastError: null,
    },
  });

  await bot.start({ scheduleLoop: false, runImmediateTick: false });
  h.emitUserWs({
    eventType: "order",
    status: "matched",
    type: null,
    side: null,
    orderId: "sell-order",
    assetIds: ["tok-up"],
    raw: { matched_size: "0.4" },
  });
  await bot.flushPendingActions();

  assert.equal(bot.getStatus().completedTrades.length, 0);
  assert.equal(bot.getStatus().cycle.position?.shares, 5);
  assert.equal(bot.getStatus().cycle.sellOrder?.orderId, "sell-order");
  await bot.stop();
  console.log("matched sell stays open: OK");
}

async function skimsProfitAfterBudgetResetIntervalWhenIdle() {
  const now = market.startTimeMs + 4 * 60 * 60_000;
  const h = makeHarness({
    currentBtc: 100_000,
    now,
    addedFunds: 5,
    lastProfitResetAt: now - config.budgetResetIntervalHours * 60 * 60_000,
  });
  const bot = new Btc15mBot({ config, dryRun: true, runtime: h.runtime });

  await bot.start({ scheduleLoop: false });

  assert.equal(bot.getStatus().budget?.availableBudget, config.workingBudgetUsd);
  assert.equal(bot.getStatus().budget?.skimmedProfitUsd, 5);
  assert.equal(h.skimmedProfitUsd, 5);
  assert.equal(h.lastProfitResetAt, now);
  assert.equal(bot.getStatus().logs.some((entry) => /Budget reset: skimmed \$5\.00 profit/.test(entry.message)), true);
  await bot.stop();
  console.log("budget profit skim: OK");
}

async function defersProfitSkimWhilePositionOpen() {
  const now = market.startTimeMs + 5 * 60_000;
  const activeMarket = {
    ...market,
    endTimeMs: now + 10 * 60_000,
  };
  const h = makeHarness({
    market: activeMarket,
    currentBtc: 100_100,
    now,
    addedFunds: 5,
    lastProfitResetAt: now - config.budgetResetIntervalHours * 60 * 60_000,
    livePosition: { bettingSide: "down", tokenId: "tok-down", shares: 5 },
  });
  const bot = new Btc15mBot({
    config,
    dryRun: false,
    runtime: h.runtime,
    initialRuntimeState: {
      market: activeMarket,
      marketStartBtcPrice: 100_000,
      currentBtcPrice: 100_100,
      cycle: {
        cyclePhase: "holding",
        cycleStartedAt: now - 60_000,
        buyOrder: null,
        sellOrder: {
          id: "sell",
          orderId: "sell-order",
          side: "sell",
          tokenId: "tok-down",
          bettingSide: "down",
          price: 0.8,
          size: 5,
          filledSize: 0,
          status: "open",
          reservedBudget: 0,
          createdAt: now,
          updatedAt: now,
        },
        position: {
          bettingSide: "down",
          tokenId: "tok-down",
          shares: 5,
          avgEntryPrice: 0.25,
          costBasisUsd: 1.25,
        },
      },
      logs: [],
      lastError: null,
    },
  });

  await bot.start({ scheduleLoop: false, runImmediateTick: false });
  await bot.runOneTick();

  assert.equal(bot.getStatus().budget?.availableBudget, 10);
  assert.equal(bot.getStatus().budget?.skimmedProfitUsd, 0);
  assert.equal(h.lastProfitResetAt, now - config.budgetResetIntervalHours * 60 * 60_000);
  await bot.stop();
  console.log("budget profit skim deferred while active: OK");
}

async function main() {
  await startStopTest();
  await placesBuyOnDownWhenBtcAboveStart();
  await usesPolymarketStartPriceNotCurrentTickForDirection();
  await doesNotTradeWhenPolymarketStartPriceUnavailable();
  await noOrderInsideNeutralZone();
  await cancelsBuyOnReturnToNeutralZone();
  await simBuyAndTargetSellFillCompletesTrade();
  await forceSellsAtBestBidWhenLate();
  await forceSellUsesClobMinimumWhenBestBidIsTooLow();
  await profitCheckSellsAtCurrentBidAboveFallback();
  await profitCheckFallsBackToSecondThresholdBelowFallback();
  await stopsReEnteringSameMarketAfterCompletedTrade();
  await autoStopsWhenBudgetReserveThrows();
  await livePositionRecoveryForceSellsWhenWsFillWasMissed();
  await recordsSellFillWhenLivePositionDisappears();
  await recordsResolvedLossWhenMarketExpiresWithUnsoldPosition();
  await stopCancelsOpenBuyAndReleasesBudget();
  await cancelsPendingBuyBeforeEntryCutoff();
  await doesNotOpenNewBuyInsideEntryCutoff();
  await holdingWaitsUntilForceSellCutoff();
  await flipsStalePendingBuyWhenDirectionChanges();
  await deduplicatesConcurrentSellFills();
  await ignoresLiveFillEventsForSameAssetWithDifferentOrderId();
  await doesNotRecoverLivePositionAfterCompletedTradeForSameMarket();
  await activeBuyStillRecoversAfterPreviousSameSideTrade();
  await partialBuyFillCancelsRemainingOrderBeforeHolding();
  await matchedSellEventDoesNotCloseWholePosition();
  await skimsProfitAfterBudgetResetIntervalWhenIdle();
  await defersProfitSkimWhilePositionOpen();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
