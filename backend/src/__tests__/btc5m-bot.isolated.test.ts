/**
 * ISOLATED Unit Test for btc5m-bot
 * Target: /Users/andrew/Projects/PM/backend/src/btc5m-bot.ts
 * Session: ses_3
 *
 * **WARNING**: THIS FILE WILL BE DELETED AFTER TEST PASSES
 * Test code preserved in: .opencode/unit-tests/
 */

import assert from "node:assert/strict";

import {
  Btc5mBot,
  stopBtc5mBot,
  type Btc5mMarketView,
} from "../btc5m-bot.js";
import type { Settings } from "../config.js";

const fakeNow = Date.parse("2026-05-11T00:00:00.000Z");

const settings: Settings = {
  polymarketHost: "https://clob.polymarket.com",
  gammaHost: "https://gamma-api.polymarket.com",
  chainId: 137,
  signatureType: 0,
  maxSpreadBps: 300,
  maxOrderUsdc: 25,
  minEdgeBps: 500,
  dryRun: false,
  enableScalper: false,
  buyPriceLimit: 0.2,
  sellPriceLimit: 0.3,
  orderSize: 5,
  maxBotBudget: 3,
  minLiquidity: 0,
  cancelBuyBeforeSec: 30,
  cancelSellBeforeSec: 15,
  scalperScanIntervalSec: 5,
  scalper: {
    buyPriceLimit: 0.2,
    sellPriceLimit: 0.3,
    orderSize: 5,
    maxBotBudget: 3,
    minLiquidity: 0,
    cancelBuyBeforeSec: 30,
    cancelSellBeforeSec: 15,
    scannerPollIntervalSec: 5,
    stateFile: "data/scalper-state.json",
  },
  btc5m: {
    buyPriceLimit: 0.6,
    sellPriceLimit: 0.7,
    orderSize: 5,
    marketScanIntervalSec: 60,
  },
};

const nextMarket: Btc5mMarketView = {
  marketId: "market-next",
  slug: "btc-updown-5m-next",
  question: "Bitcoin Up or Down - Next?",
  startDateIso: new Date(fakeNow + 300_000).toISOString(),
  endDateIso: new Date(fakeNow + 600_000).toISOString(),
  upTokenId: "token-up-next",
  downTokenId: "token-down-next",
};

const activeQueuedMarket: Btc5mMarketView = {
  ...nextMarket,
  startDateIso: new Date(fakeNow - 30_000).toISOString(),
  endDateIso: new Date(fakeNow + 270_000).toISOString(),
};

const placeLimitOrderCalls: Array<{
  tokenId: string;
  side: string;
  price: number;
  size: number;
  tickSize?: string;
}> = [];

const selections = [
  { current: null, next: nextMarket },
  { current: activeQueuedMarket, next: null },
];

async function main() {
  const bot = new Btc5mBot(settings, {
    service: {
      async initialize() {
        return undefined;
      },
      async placeLimitOrder(order) {
        placeLimitOrderCalls.push(order);
        return { orderId: `${order.side}-order-1` };
      },
      async cancelOrder() {
        return undefined;
      },
    },
    createUserWs() {
      return {
        async start() {
          return undefined;
        },
        stop() {},
      };
    },
    async findMarketSelection() {
      return selections.shift() ?? { current: activeQueuedMarket, next: null };
    },
    now: () => fakeNow,
    setIntervalFn: (() => ({}) as unknown as ReturnType<typeof setInterval>) as unknown as typeof setInterval,
    clearIntervalFn: (() => undefined) as typeof clearInterval,
  });

  await bot.start({ scheduleLoop: false });

  const queuedStatus = bot.getStatus();
  assert.equal(queuedStatus.active, true);
  assert.equal(queuedStatus.phase, "buy_open");
  assert.equal(queuedStatus.dryRun, false);
  assert.equal(queuedStatus.orderSize, 5);
  assert.equal(queuedStatus.buyPriceLimit, 0.6);
  assert.equal(queuedStatus.sellPriceLimit, 0.7);
  assert.equal(queuedStatus.currentMarket, null);
  assert.equal(queuedStatus.nextMarket?.slug, "btc-updown-5m-next");
  assert.equal(placeLimitOrderCalls.length, 1);
  assert.deepEqual(placeLimitOrderCalls[0], {
    tokenId: "token-up-next",
    side: "buy",
    price: 0.6,
    size: 5,
    tickSize: "0.01",
  });

  await bot.tickNow();

  const activeStatus = bot.getStatus();
  assert.equal(activeStatus.phase, "buy_open");
  assert.equal(activeStatus.currentMarket?.slug, "btc-updown-5m-next");
  assert.equal(activeStatus.nextMarket, null);
  assert.equal(placeLimitOrderCalls.length, 1);

  bot.stop();

  const stoppedStatus = bot.getStatus();
  assert.equal(stoppedStatus.active, false);
  assert.equal(stoppedStatus.phase, "idle");
  assert.equal(stoppedStatus.dryRun, false);
  assert.equal(stoppedStatus.orderSize, 5);
  assert.equal(stoppedStatus.buyPriceLimit, 0.6);
  assert.equal(stoppedStatus.sellPriceLimit, 0.7);
  assert.equal(stoppedStatus.currentMarket?.slug, "btc-updown-5m-next");

  const idleStopStatus = stopBtc5mBot(settings);
  assert.equal(idleStopStatus.active, false);
  assert.equal(idleStopStatus.phase, "idle");
  assert.equal(idleStopStatus.dryRun, false);
  assert.equal(idleStopStatus.orderSize, 5);
  assert.equal(idleStopStatus.buyPriceLimit, 0.6);
  assert.equal(idleStopStatus.sellPriceLimit, 0.7);
}

await main();
