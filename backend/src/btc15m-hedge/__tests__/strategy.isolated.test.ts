import assert from "node:assert/strict";

import type { ScalperUserWsMessage } from "../../scalper-user-ws.js";
import { Btc15mHedgeBot, type Btc15mHedgeRuntime, type PlaceOrderArgs } from "../strategy.js";
import type {
  Btc15mHedgeBotConfig,
  Btc15mHedgeCompletedCycle,
  Btc15mHedgeMarketView,
  Btc15mHedgeRuntimeStateUpdate,
} from "../types.js";

const defaultConfig: Btc15mHedgeBotConfig = {
  workingBudgetUsd: 3,
  sharesPerSide: 5,
  targetCombinedPrice: 0.9,
  entryCutoffMin: 6,
  forceUnwindThresholdMin: 2,
  tickIntervalSec: 2,
};

class FakeRuntime implements Btc15mHedgeRuntime {
  nowMs = Date.UTC(2026, 4, 21, 12, 0, 0);
  market: Btc15mHedgeMarketView | null;
  placedOrders: Array<PlaceOrderArgs & { orderId: string }> = [];
  cancelledOrders: string[] = [];
  persistedStates: Btc15mHedgeRuntimeStateUpdate[] = [];
  completedCycles: Btc15mHedgeCompletedCycle[] = [];
  budgetReserved: Array<{ amount: number; reason?: string }> = [];
  budgetReleased: Array<{ amount: number; reason?: string }> = [];
  budgetConsumed: Array<{ amount: number; reason?: string }> = [];
  private nextOrderId = 1;

  constructor(market: Btc15mHedgeMarketView | null) {
    this.market = market;
  }

  now(): number {
    return this.nowMs;
  }

  async resolveMarket(): Promise<Btc15mHedgeMarketView | null> {
    return this.market;
  }

  async placeLimitOrder(args: PlaceOrderArgs): Promise<{ orderId: string }> {
    const orderId = `ord-${this.nextOrderId++}`;
    this.placedOrders.push({ ...args, orderId });
    return { orderId };
  }

  async cancelOrder(orderId: string): Promise<void> {
    this.cancelledOrders.push(orderId);
  }

  async persistRuntimeState(state: Btc15mHedgeRuntimeStateUpdate): Promise<void> {
    this.persistedStates.push(JSON.parse(JSON.stringify(state)) as Btc15mHedgeRuntimeStateUpdate);
  }

  async appendCompletedCycle(cycle: Btc15mHedgeCompletedCycle): Promise<void> {
    this.completedCycles.push(JSON.parse(JSON.stringify(cycle)) as Btc15mHedgeCompletedCycle);
  }

  budget = {
    reserve: async (amount: number, reason?: string) => {
      this.budgetReserved.push({ amount, reason });
    },
    release: async (amount: number, reason?: string) => {
      this.budgetReleased.push({ amount, reason });
    },
    consume: async (amount: number, reason?: string) => {
      this.budgetConsumed.push({ amount, reason });
    },
  };
}

async function pairAssemblesOnProfitablePartialFill() {
  const market = makeMarket("btc-updown-15m-1", 15);
  const runtime = new FakeRuntime(market);
  const bot = new Btc15mHedgeBot({ config: defaultConfig, dryRun: true, runtime });

  bot.updateBook(market.upTokenId, { bestBid: 0.44, bestAsk: 0.45 });
  bot.updateBook(market.downTokenId, { bestBid: 0.44, bestAsk: 0.45 });

  await bot.start({ runImmediateTick: false, scheduleLoop: false });
  await bot.runOneTick();

  const placedBuyOrders = runtime.placedOrders.filter((order) => order.side === "buy");
  assert.equal(placedBuyOrders.length, 2);
  assert.equal(runtime.budgetReserved.length, 2);

  const statusAfterPlacement = bot.getStatus();
  assert.equal(statusAfterPlacement.cycle.phase, "building_pair");

  await bot.handleUserWsMessage(fillMessage({
    orderId: statusAfterPlacement.cycle.upLeg.orderId!,
    assetId: market.upTokenId,
    side: "buy",
    status: "matched",
    matchedSize: 2,
  }));
  await bot.handleUserWsMessage(fillMessage({
    orderId: statusAfterPlacement.cycle.downLeg.orderId!,
    assetId: market.downTokenId,
    side: "buy",
    status: "matched",
    matchedSize: 2,
  }));

  await bot.runOneTick();

  const status = bot.getStatus();
  assert.equal(status.cycle.phase, "paired_holding");
  assert.equal(status.cycle.pairedShares, 2);
  assert.equal(status.cycle.pairedAvgUp, 0.45);
  assert.equal(status.cycle.pairedAvgDown, 0.45);
  assert.equal(status.cycle.combinedAverage, 0.9);
  assert.equal(runtime.cancelledOrders.length, 2);
  assert.equal(runtime.budgetConsumed.length, 2);
  assert.equal(runtime.budgetReleased.length, 2);
  assert.ok(runtime.persistedStates.length > 0);
}

async function doesNotEnterWhenCombinedAskIsAboveTarget() {
  const market = makeMarket("btc-updown-15m-high-spread", 15);
  const runtime = new FakeRuntime(market);
  const bot = new Btc15mHedgeBot({
    config: { ...defaultConfig, targetCombinedPrice: 0.9 },
    dryRun: true,
    runtime,
  });

  bot.updateBook(market.upTokenId, { bestBid: 0.59, bestAsk: 0.6 });
  bot.updateBook(market.downTokenId, { bestBid: 0.39, bestAsk: 0.4 });

  await bot.start({ runImmediateTick: false, scheduleLoop: false });
  await bot.runOneTick();

  assert.equal(runtime.placedOrders.length, 0);
  assert.equal(bot.getStatus().cycle.phase, "building_pair");
}

async function singleSidePartialFillDoesNotAssemblePair() {
  const market = makeMarket("btc-updown-15m-2", 15);
  const runtime = new FakeRuntime(market);
  const bot = new Btc15mHedgeBot({ config: defaultConfig, dryRun: true, runtime });

  bot.updateBook(market.upTokenId, { bestBid: 0.44, bestAsk: 0.45 });
  bot.updateBook(market.downTokenId, { bestBid: 0.44, bestAsk: 0.45 });

  await bot.start({ runImmediateTick: false, scheduleLoop: false });
  await bot.runOneTick();

  const placed = bot.getStatus();
  await bot.handleUserWsMessage(fillMessage({
    orderId: placed.cycle.upLeg.orderId!,
    assetId: market.upTokenId,
    side: "buy",
    status: "matched",
    matchedSize: 2.5,
  }));
  await bot.runOneTick();

  const status = bot.getStatus();
  assert.equal(status.cycle.phase, "building_pair");
  assert.equal(status.cycle.pairedShares, 0);
  assert.equal(status.cycle.combinedAverage, null);
  assert.equal(runtime.completedCycles.length, 0);

  runtime.nowMs = market.endTimeMs - (5 * 60 * 1000);
  await bot.runOneTick();
  assert.equal(runtime.cancelledOrders.length, 2);
  assert.equal(bot.getStatus().cycle.phase, "building_pair");
}

async function forceUnwindCancelsBuysAndSellsOnlyUnpairedRemainder() {
  const market = makeMarket("btc-updown-15m-3", 15);
  const runtime = new FakeRuntime(market);
  const bot = new Btc15mHedgeBot({
    config: { ...defaultConfig, targetCombinedPrice: 0.8 },
    dryRun: true,
    runtime,
  });

  bot.updateBook(market.upTokenId, { bestBid: 0.32, bestAsk: 0.35 });
  bot.updateBook(market.downTokenId, { bestBid: 0.31, bestAsk: 0.35 });

  await bot.start({ runImmediateTick: false, scheduleLoop: false });
  await bot.runOneTick();

  const placed = bot.getStatus();
  await bot.handleUserWsMessage(fillMessage({
    orderId: placed.cycle.upLeg.orderId!,
    assetId: market.upTokenId,
    side: "buy",
    status: "matched",
    matchedSize: 2,
  }));
  await bot.handleUserWsMessage(fillMessage({
    orderId: placed.cycle.downLeg.orderId!,
    assetId: market.downTokenId,
    side: "buy",
    status: "matched",
    matchedSize: 1,
  }));

  runtime.nowMs = market.endTimeMs - (90 * 1000);
  await bot.runOneTick();

  const sellOrders = runtime.placedOrders.filter((order) => order.side === "sell");
  assert.equal(runtime.cancelledOrders.length, 2);
  assert.equal(sellOrders.length, 1);
  assert.equal(sellOrders[0]?.tokenId, market.upTokenId);
  assert.equal(sellOrders[0]?.size, 1);
  assert.equal(sellOrders[0]?.price, 0.32);
  assert.equal(bot.getStatus().cycle.phase, "unwinding");
  assert.ok(runtime.budgetReleased.length >= 2);

  await bot.handleUserWsMessage(fillMessage({
    orderId: sellOrders[0]!.orderId,
    assetId: market.upTokenId,
    side: "sell",
    status: "filled",
    matchedSize: 1,
  }));

  assert.equal(runtime.completedCycles.length, 1);
  assert.equal(runtime.completedCycles[0]?.result, "partial_unwind");
  assert.equal(runtime.completedCycles[0]?.unpairedUnwindPnlUsd, -0.03);
}

async function noReentryAfterPairedHoldingAndCompletionAppendsOnce() {
  const market1 = makeMarket("btc-updown-15m-4", 15);
  const market2 = makeMarket("btc-updown-15m-5", 15, market1.endTimeMs + 1000);
  const runtime = new FakeRuntime(market1);
  const bot = new Btc15mHedgeBot({ config: defaultConfig, dryRun: true, runtime });

  bot.updateBook(market1.upTokenId, { bestBid: 0.44, bestAsk: 0.45 });
  bot.updateBook(market1.downTokenId, { bestBid: 0.44, bestAsk: 0.45 });

  await bot.start({ runImmediateTick: false, scheduleLoop: false });
  await bot.runOneTick();

  const placed = bot.getStatus();
  await bot.handleUserWsMessage(fillMessage({
    orderId: placed.cycle.upLeg.orderId!,
    assetId: market1.upTokenId,
    side: "buy",
    status: "matched",
    matchedSize: 1,
  }));
  await bot.handleUserWsMessage(fillMessage({
    orderId: placed.cycle.downLeg.orderId!,
    assetId: market1.downTokenId,
    side: "buy",
    status: "matched",
    matchedSize: 1,
  }));

  const orderCountBeforeAssembly = runtime.placedOrders.length;
  await bot.runOneTick();
  assert.equal(bot.getStatus().cycle.phase, "paired_holding");

  await bot.runOneTick();
  assert.equal(runtime.placedOrders.length, orderCountBeforeAssembly);
  assert.equal(runtime.completedCycles.length, 0);

  runtime.market = market2;
  bot.updateBook(market2.upTokenId, { bestBid: 0.42, bestAsk: 0.43 });
  bot.updateBook(market2.downTokenId, { bestBid: 0.46, bestAsk: 0.47 });

  await bot.runOneTick();

  assert.equal(runtime.completedCycles.length, 1);
  assert.equal(runtime.completedCycles[0]?.marketSlug, market1.slug);
  assert.equal(runtime.completedCycles[0]?.result, "paired_hold");
  assert.equal(bot.getStatus().market?.slug, market2.slug);
}

async function overfillUsesPairedPortionAverageNotWholeLegAverage() {
  const market = makeMarket("btc-updown-15m-overfill", 15);
  const runtime = new FakeRuntime(market);
  const bot = new Btc15mHedgeBot({
    config: { ...defaultConfig, targetCombinedPrice: 0.8 },
    dryRun: true,
    runtime,
  });

  bot.updateBook(market.upTokenId, { bestBid: 0.3, bestAsk: 0.3 });
  bot.updateBook(market.downTokenId, { bestBid: 0.49, bestAsk: 0.49 });

  await bot.start({ runImmediateTick: false, scheduleLoop: false });
  await bot.runOneTick();
  const first = bot.getStatus();

  await bot.handleUserWsMessage(fillMessage({
    orderId: first.cycle.upLeg.orderId!,
    assetId: market.upTokenId,
    side: "buy",
    status: "matched",
    matchedSize: 1,
  }));
  await bot.handleUserWsMessage(fillMessage({
    orderId: first.cycle.downLeg.orderId!,
    assetId: market.downTokenId,
    side: "buy",
    status: "matched",
    matchedSize: 1,
  }));
  await bot.runOneTick();

  bot.updateBook(market.upTokenId, { bestBid: 0.3, bestAsk: 0.3 });
  bot.updateBook(market.downTokenId, { bestBid: 0.19, bestAsk: 0.19 });
  await bot.runOneTick();
  const second = bot.getStatus();
  await bot.handleUserWsMessage(fillMessage({
    orderId: second.cycle.downLeg.orderId!,
    assetId: market.downTokenId,
    side: "buy",
    status: "matched",
    matchedSize: 1,
  }));

  const status = bot.getStatus();
  assert.equal(status.cycle.pairedShares, 1);
  assert.equal(status.cycle.pairedAvgUp, 0.3);
  assert.equal(status.cycle.pairedAvgDown, 0.49);
  assert.equal(status.cycle.combinedAverage, 0.79);
}

async function nullMarketFinalizesProgressInsteadOfDroppingCycle() {
  const market = makeMarket("btc-updown-15m-null-market", 15);
  const runtime = new FakeRuntime(market);
  const bot = new Btc15mHedgeBot({ config: defaultConfig, dryRun: true, runtime });

  bot.updateBook(market.upTokenId, { bestBid: 0.44, bestAsk: 0.45 });
  bot.updateBook(market.downTokenId, { bestBid: 0.44, bestAsk: 0.45 });

  await bot.start({ runImmediateTick: false, scheduleLoop: false });
  await bot.runOneTick();
  const placed = bot.getStatus();
  await bot.handleUserWsMessage(fillMessage({
    orderId: placed.cycle.upLeg.orderId!,
    assetId: market.upTokenId,
    side: "buy",
    status: "matched",
    matchedSize: 1,
  }));

  runtime.market = null;
  await bot.runOneTick();

  assert.equal(runtime.completedCycles.length, 0);
  assert.equal(bot.getStatus().market?.slug, market.slug);
  assert.equal(bot.getStatus().cycle.upLeg.filledShares, 1);
}

async function persistedOpenBuyOrderHydratesAndAcceptsWsFill() {
  const market = makeMarket("btc-updown-15m-restart", 15);
  const runtime = new FakeRuntime(market);
  const bot = new Btc15mHedgeBot({
    config: defaultConfig,
    dryRun: true,
    runtime,
    initialRuntimeState: {
      market,
      cycle: {
        phase: "building_pair",
        cycleStartedAt: runtime.now(),
        upLeg: {
          tokenId: market.upTokenId,
          side: "up",
          orderId: "persisted-up-buy",
          orderPrice: 0.45,
          orderSize: 2,
          orderStatus: "open",
          filledShares: 1,
          filledCostUsd: 0.45,
          avgEntryPrice: 0.45,
        },
        downLeg: {
          tokenId: market.downTokenId,
          side: "down",
          orderId: null,
          orderPrice: null,
          orderSize: 0,
          orderStatus: null,
          filledShares: 0,
          filledCostUsd: 0,
          avgEntryPrice: null,
        },
        pairedShares: 0,
        unpairedUpShares: 1,
        unpairedDownShares: 0,
        pairedAvgUp: null,
        pairedAvgDown: null,
        combinedAverage: null,
        pairAssembledAt: null,
        completionLocked: false,
      },
      logs: [],
      lastError: null,
    },
  });

  await bot.start({ runImmediateTick: false, scheduleLoop: false });
  await bot.handleUserWsMessage(fillMessage({
    orderId: "persisted-up-buy",
    assetId: market.upTokenId,
    side: "buy",
    status: "matched",
    matchedSize: 2,
  }));

  assert.equal(bot.getStatus().cycle.upLeg.filledShares, 2);
}

function makeMarket(slug: string, durationMin: number, startTimeMs = Date.UTC(2026, 4, 21, 12, 0, 0)): Btc15mHedgeMarketView {
  return {
    slug,
    question: slug,
    startTimeMs,
    endTimeMs: startTimeMs + durationMin * 60_000,
    priceToBeat: null,
    upTokenId: `${slug}-up`,
    downTokenId: `${slug}-down`,
  };
}

function fillMessage(args: {
  orderId: string;
  assetId: string;
  side: "buy" | "sell";
  status: string;
  matchedSize: number;
}): ScalperUserWsMessage {
  return {
    eventType: "order",
    status: args.status,
    type: "order",
    side: args.side,
    orderId: args.orderId,
    assetIds: [args.assetId],
    raw: {
      matched_size: args.matchedSize,
      order_id: args.orderId,
      asset_id: args.assetId,
    },
  };
}

async function main() {
  await pairAssemblesOnProfitablePartialFill();
  await doesNotEnterWhenCombinedAskIsAboveTarget();
  await singleSidePartialFillDoesNotAssemblePair();
  await forceUnwindCancelsBuysAndSellsOnlyUnpairedRemainder();
  await noReentryAfterPairedHoldingAndCompletionAppendsOnce();
  await overfillUsesPairedPortionAverageNotWholeLegAverage();
  await nullMarketFinalizesProgressInsteadOfDroppingCycle();
  await persistedOpenBuyOrderHydratesAndAcceptsWsFill();
  console.log("btc15m hedge strategy: OK");
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
