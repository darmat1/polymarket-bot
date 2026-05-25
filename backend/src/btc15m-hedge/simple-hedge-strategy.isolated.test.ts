import assert from "node:assert/strict";

import { SimpleHedgeBot, type PlaceOrderArgs, type SimpleHedgeRuntime } from "./simple-hedge-strategy.js";
import type { Btc15mHedgeBotConfig, Btc15mHedgeMarketView } from "./types.js";

const config: Btc15mHedgeBotConfig = {
  marketUrl: "https://polymarket.com/event/hype-updown-5m-seed",
  buyPrice: 0.4,
  shares: 5,
};

function makeMarket(slug: string, startTimeMs: number, endTimeMs: number): Btc15mHedgeMarketView {
  return {
    slug,
    question: slug,
    startTimeMs,
    endTimeMs,
    priceToBeat: null,
    upTokenId: `${slug}-up`,
    downTokenId: `${slug}-down`,
  };
}

async function main() {
  const base = Date.parse("2026-05-24T12:00:00.000Z");
  const lateMarket = makeMarket("hype-updown-5m-late", base, base + 5 * 60_000);
  const nextMarket = makeMarket("hype-updown-5m-next", lateMarket.endTimeMs, lateMarket.endTimeMs + 5 * 60_000);

  let now = lateMarket.endTimeMs - 2 * 60_000;
  let orderId = 0;
  const orders: PlaceOrderArgs[] = [];
  const cancelled: string[] = [];
  const orderStatus = new Map<string, { status: string; matched: number; price: number }>();

  const runtime: SimpleHedgeRuntime = {
    now: () => now,
    getMarketFromUrl: async () => {
      if (now < lateMarket.endTimeMs) {
        return lateMarket;
      }
      return nextMarket;
    },
    placeLimitOrder: async (args) => {
      orders.push(args);
      orderId += 1;
      return { orderId: `order-${orderId}` };
    },
    getOrderStatus: async (currentOrderId) => orderStatus.get(currentOrderId) ?? { status: "open", matched: 0, price: 0 },
    cancelOrder: async (currentOrderId) => {
      cancelled.push(currentOrderId);
    },
  };

  const bot = new SimpleHedgeBot({
    config,
    dryRun: true,
    runtime,
  });

  await assert.rejects(() => bot.start(), /below the 3 minute cutoff/);
  assert.equal(orders.length, 0);
  assert.equal(bot.getStatus().enginePhase, "stopped");

  now = nextMarket.startTimeMs + 30_000;
  const oneShotRuntime: SimpleHedgeRuntime = {
    now: () => now,
    getMarketFromUrl: async () => nextMarket,
    placeLimitOrder: async (args) => {
      orders.push(args);
      orderId += 1;
      return { orderId: `order-${orderId}` };
    },
    getOrderStatus: async (currentOrderId) => orderStatus.get(currentOrderId) ?? { status: "open", matched: 0, price: 0 },
    cancelOrder: async (currentOrderId) => {
      cancelled.push(currentOrderId);
    },
  };
  const oneShotBot = new SimpleHedgeBot({
    config,
    dryRun: true,
    runtime: oneShotRuntime,
  });

  await oneShotBot.start();
  assert.equal(oneShotBot.getStatus().market?.slug, nextMarket.slug);
  assert.equal(oneShotBot.getStatus().cycle.phase, "waiting_fills");
  assert.equal(orders.length, 2);

  orderStatus.set("order-1", { status: "matched", matched: 5, price: 0.4 });
  orderStatus.set("order-2", { status: "matched", matched: 5, price: 0.4 });
  await (oneShotBot as any).tick();
  assert.equal(oneShotBot.getStatus().cycle.phase, "paired_holding");
  assert.equal(oneShotBot.getStatus().cycle.pairedShares, 5);

  now = nextMarket.endTimeMs + 1_000;
  await (oneShotBot as any).tick();
  assert.equal(oneShotBot.getStatus().enginePhase, "stopped");
  assert.equal(oneShotBot.getStatus().completedCycles.length, 1);
  assert.equal(oneShotBot.getStatus().completedCycles[0]?.marketSlug, nextMarket.slug);
  assert.equal(orders.length, 2);
  assert.deepEqual(cancelled, []);

  await oneShotBot.stop();

  let failedNow = base;
  const failedOrders: PlaceOrderArgs[] = [];
  const failedCancelled: string[] = [];
  let failOrderId = 0;
  const failingRuntime: SimpleHedgeRuntime = {
    now: () => failedNow,
    getMarketFromUrl: async () => nextMarket,
    placeLimitOrder: async (args) => {
      failedOrders.push(args);
      failOrderId += 1;
      if (failOrderId === 2) {
        throw new Error("DOWN placement rejected");
      }
      return { orderId: `failed-order-${failOrderId}` };
    },
    getOrderStatus: async () => ({ status: "open", matched: 0, price: 0 }),
    cancelOrder: async (orderId) => {
      failedCancelled.push(orderId);
    },
  };

  const failingBot = new SimpleHedgeBot({
    config,
    dryRun: true,
    runtime: failingRuntime,
  });

  await assert.rejects(() => failingBot.start(), /DOWN placement rejected/);
  assert.equal(failingBot.getStatus().enginePhase, "stopped");
  assert.equal(failedOrders.length, 2);
  assert.deepEqual(failedCancelled, ["failed-order-1"]);

  const exposureBot = new SimpleHedgeBot({
    config,
    dryRun: false,
    runtime: {
      now: () => base,
      getMarketFromUrl: async () => nextMarket,
      placeLimitOrder: async () => ({ orderId: "unused" }),
      getOrderStatus: async () => ({ status: "open", matched: 0, price: 0 }),
      cancelOrder: async () => undefined,
      getLiveStateForAsset: async (tokenId) => ({
        openOrders: [],
        position: tokenId === nextMarket.upTokenId ? { size: 5, avgPrice: 0.4 } : null,
      }),
    },
  });

  await assert.rejects(
    () => exposureBot.start(),
    /Existing exposure detected/,
  );
  assert.equal(exposureBot.getStatus().enginePhase, "stopped");
}

void main();
