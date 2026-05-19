import type { Settings } from "../config.js";

import type { Btc5mBotStatus } from "./types.js";

export function createIdleStatus(): Btc5mBotStatus {
  return {
    active: false,
    phase: "idle",
    dryRun: true,
    orderSize: 0,
    buyPriceLimit: 0.6,
    sellPriceLimit: 0.7,
    currentMarket: null,
    nextMarket: null,
    buyOrderId: null,
    sellOrderId: null,
    lastCompletedMarketSlug: null,
    lastError: null,
    updatedAt: Date.now(),
    logs: [],
  };
}

export function createConfiguredIdleStatus(settings: Settings): Btc5mBotStatus {
  return {
    ...createIdleStatus(),
    dryRun: settings.dryRun,
    orderSize: settings.btc5m.orderSize,
    buyPriceLimit: settings.btc5m.buyPriceLimit,
    sellPriceLimit: settings.btc5m.sellPriceLimit,
  };
}

export function cloneBtc5mStatus(status: Btc5mBotStatus): Btc5mBotStatus {
  return {
    ...status,
    logs: [...status.logs],
    currentMarket: status.currentMarket ? { ...status.currentMarket } : null,
    nextMarket: status.nextMarket ? { ...status.nextMarket } : null,
  };
}
