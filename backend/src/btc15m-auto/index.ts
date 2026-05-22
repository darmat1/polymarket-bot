import { PolymarketMarketWs, type PolymarketMarketWsEvent } from "../polymarket-market-ws.js";
import { PolymarketService } from "../polymarket-service.js";
import { ScalperUserWs } from "../scalper-user-ws.js";
import { createBudgetManager } from "../budget-manager.js";
import type { Settings } from "../config.js";

import { resolveCurrentMarket } from "./market-resolver.js";
import { createBtc15mAutoStateStore } from "./state-store.js";
import { Btc15mAutoBot, type Btc15mAutoRuntime } from "./strategy.js";
import type {
  Btc15mAutoBotConfig,
  Btc15mAutoBotStatus,
  Btc15mAutoCompletedTrade,
  Btc15mAutoPersistentState,
} from "./types.js";

export type {
  Btc15mAutoBotConfig,
  Btc15mAutoBotStatus,
  Btc15mAutoCompletedTrade,
} from "./types.js";

export interface StartBtc15mAutoBotOptions {
  configOverrides?: Partial<Btc15mAutoBotConfig>;
}

let activeBot: Btc15mAutoBot | null = null;
let marketWs: PolymarketMarketWs | null = null;
const bookListeners = new Map<string, Set<(bestBid: number | null, bestAsk: number | null) => void>>();

export async function startBtc15mAutoBot(
  settings: Settings,
  options: StartBtc15mAutoBotOptions = {},
): Promise<Btc15mAutoBotStatus> {
  if (activeBot) {
    if (activeBot.getStatus().enginePhase === "running") {
      return activeBot.getStatus();
    }
    activeBot = null;
  }

  const baseConfig = configFromSettings(settings);
  const config: Btc15mAutoBotConfig = { ...baseConfig, ...sanitizeConfigOverrides(options.configOverrides) };
  const store = createBtc15mAutoStateStore({
    filePath: settings.btc15mAuto.stateFile,
    defaultConfig: baseConfig,
  });
  await store.updateConfig(config);
  const persisted = await store.readState();

  // Reset budget to workingBudget when:
  //  (a) workingBudget config changed, OR
  //  (b) bot is idle (no open buy/sell order, no live position) and availableBudget is exhausted.
  // This is what the user expects when clicking Start after a prior session drained the budget
  // through losses — refill from working budget so the bot can place a fresh order.
  const hasActiveOrder = persisted.cycle.buyOrder !== null || persisted.cycle.sellOrder !== null;
  const hasPosition = persisted.cycle.position !== null;
  const isIdle = !hasActiveOrder && !hasPosition;
  const totalBudgetInPlay = persisted.budget.availableBudget + persisted.budget.lockedBudget;
  const budgetDepleted = totalBudgetInPlay < config.workingBudgetUsd;
  // Also resync if budget has drifted ABOVE workingBudget (e.g., race-condition over-credits from
  // duplicate sell-fill events in prior versions left $13.50 in the pot when working budget is $5).
  const budgetInflated = totalBudgetInPlay > config.workingBudgetUsd * 1.05;
  const shouldReset =
    persisted.budget.initialBudget !== config.workingBudgetUsd ||
    (isIdle && (budgetDepleted || budgetInflated));

  if (shouldReset) {
    await store.updateBudget((budget) => {
      budget.initialBudget = config.workingBudgetUsd;
      budget.availableBudget = config.workingBudgetUsd;
      budget.lockedBudget = 0;
      budget.lastBalanceCheck = null;
    });
  }

  const service = PolymarketService.getInstance(settings);
  await service.initialize();
  const budgetManager = createBudgetManager({
    store,
    maxBotBudget: config.workingBudgetUsd,
    balanceProvider: settings.dryRun ? undefined : service,
  });
  await budgetManager.initialize();

  let userWsInstance: ScalperUserWs | null = null;
  const runtime: Btc15mAutoRuntime = {
    now: () => Date.now(),
    resolveMarket: () => resolveCurrentMarket(settings.gammaHost),
    fetchBtcPrice,
    placeLimitOrder: (args) => service.placeLimitOrder({ ...args, tickSize: "0.01" }),
    cancelOrder: (orderId) => service.cancelOrder(orderId),
    onMarketBookSubscribe: subscribeMarketBook,
    onMarketBookUnsubscribe: unsubscribeMarketBook,
    startUserWs: async (handler) => {
      userWsInstance = new ScalperUserWs(handler);
      await userWsInstance.start();
    },
    stopUserWs: () => {
      userWsInstance?.stop();
      userWsInstance = null;
    },
    budget: {
      reserve: async (amount, reason) => {
        await budgetManager.reserve(amount, reason);
      },
      release: async (amount, reason) => {
        await budgetManager.release(amount, reason);
      },
      consume: async (amount, reason) => {
        await budgetManager.consume(amount, reason);
      },
      addFunds: async (amount, reason) => {
        await budgetManager.addFunds(amount, reason);
      },
      snapshot: () => budgetManager.getSnapshot(),
    },
    persistTrade: (trade) => store.appendCompletedTrade(trade),
    persistConfig: (cfg) => store.updateConfig(cfg),
    persistRuntimeState: settings.dryRun ? undefined : (state) => store.updateRuntimeState(state),
    getOrder: async (orderId) => {
      try {
        const order = await service.getOrder(orderId);
        return {
          status: order.status,
          size_matched: order.size_matched,
          original_size: order.original_size,
        };
      } catch (error) {
        // 404/not-found often means the order was fully matched and archived.
        // Surface this as a sentinel so the strategy can treat it as filled.
        const message = error instanceof Error ? error.message : String(error);
        if (/404|not[ _-]?found/i.test(message)) {
          return { status: "not_found", size_matched: "0", original_size: "0" };
        }
        return null;
      }
    },
    getOrderBook: async (tokenId) => service.getOrderBook(tokenId),
  };

  const latestPersisted = await store.readState();
  const bot = new Btc15mAutoBot({
    config,
    dryRun: settings.dryRun,
    runtime,
    initialTrades: settings.dryRun ? [] : latestPersisted.completedTrades,
    initialRuntimeState: settings.dryRun
      ? {
          ...latestPersisted,
          completedTrades: [],
          logs: [],
          lastError: null,
        }
      : latestPersisted,
  });
  await bot.start();
  activeBot = bot;
  return bot.getStatus();
}

/**
 * Manually reset the budget to workingBudget. Refuses if the bot is currently running OR has
 * an active position/order — resetting then would orphan budget reservations tracking the
 * still-open Polymarket order. Caller must Stop first.
 */
export async function resetBtc15mAutoBudget(settings: Settings): Promise<Btc15mAutoBotStatus> {
  if (activeBot?.getStatus().enginePhase === "running") {
    throw new Error("Cannot reset budget while bot is running. Stop the bot first.");
  }
  const config = configFromSettings(settings);
  const store = createBtc15mAutoStateStore({
    filePath: settings.btc15mAuto.stateFile,
    defaultConfig: config,
  });
  const persisted = await store.readState();
  if (persisted.cycle.buyOrder !== null || persisted.cycle.sellOrder !== null || persisted.cycle.position !== null) {
    throw new Error("Cannot reset budget with active order/position on disk. Stop the bot and let it cancel/close first.");
  }
  await store.updateBudget((budget) => {
    budget.initialBudget = config.workingBudgetUsd;
    budget.availableBudget = config.workingBudgetUsd;
    budget.lockedBudget = 0;
    budget.lastBalanceCheck = null;
  });
  return getBtc15mAutoBotStatus(settings);
}

export async function stopBtc15mAutoBot(settings?: Settings): Promise<Btc15mAutoBotStatus> {
  if (activeBot) {
    await activeBot.stop();
    const status = activeBot.getStatus();
    activeBot = null;
    return status;
  }

  if (settings) {
    return createIdleStatus(settings, configFromSettings(settings), [], null);
  }

  return {
    enginePhase: "stopped",
    dryRun: true,
    config: {
      workingBudgetUsd: 5,
      shares: 5,
      minBuyPrice: 0.2,
      maxBuyPrice: 0.8,
      trailStep: 0.05,
      trailDist: 0.02,
      trailUpdateIntervalSec: 3,
      repeatThresholdMin: 6,
      forceSellThresholdMin: 2,
      neutralZoneUsd: 5,
      tickIntervalSec: 2,
    },
    market: null,
    marketStartBtcPrice: null,
    currentBtcPrice: null,
    upPrice: null,
    downPrice: null,
    cycle: {
      cyclePhase: "waiting_market",
      cycleStartedAt: null,
      buyOrder: null,
      sellOrder: null,
      position: null,
      plannedBuyPrice: null,
      plannedBuyAnchorPrice: null,
      buyBlockReason: null,
      buyBlockReferencePrice: null,
      highWaterMark: null,
      trailStopPrice: null,
    },
    completedTrades: [],
    analytics: {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      totalPnlUsd: 0,
      grossProfitUsd: 0,
      grossLossUsd: 0,
      sessionStartBudgetUsd: 0,
      remainingBudgetUsd: 0,
    },
    sessionTrades: [],
    sessionAnalytics: {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      totalPnlUsd: 0,
      grossProfitUsd: 0,
      grossLossUsd: 0,
      sessionStartBudgetUsd: 0,
      remainingBudgetUsd: 0,
    },
    budget: null,
    logs: [],
    updatedAt: Date.now(),
    lastError: null,
  };
}

export async function getBtc15mAutoBotStatus(settings: Settings): Promise<Btc15mAutoBotStatus> {
  if (activeBot) {
    return activeBot.getStatus();
  }

  const store = createBtc15mAutoStateStore({
    filePath: settings.btc15mAuto.stateFile,
    defaultConfig: configFromSettings(settings),
  });
  const persisted = await store.readState();
  const persistedTrades = settings.dryRun ? [] : persisted.completedTrades;
  const status = createIdleStatus(settings, persisted.config, persistedTrades, persisted);
  status.market = persisted.market;
  status.sessionAnalytics.remainingBudgetUsd = status.analytics.remainingBudgetUsd;
  status.marketStartBtcPrice = persisted.marketStartBtcPrice;
  status.currentBtcPrice = persisted.currentBtcPrice;
  status.cycle = persisted.cycle;
  status.logs = settings.dryRun ? [] : persisted.logs;
  status.lastError = settings.dryRun ? null : persisted.lastError;
  return status;
}

export function configFromSettings(settings: Settings): Btc15mAutoBotConfig {
  return {
    workingBudgetUsd: settings.btc15mAuto.workingBudgetUsd,
    shares: settings.btc15mAuto.orderSize,
    minBuyPrice: settings.btc15mAuto.buyPriceLimit,
    maxBuyPrice: settings.btc15mAuto.maxBuyPriceLimit ?? 0.8,
    trailStep: settings.btc15mAuto.trailStep,
    trailDist: settings.btc15mAuto.trailDist,
    trailUpdateIntervalSec: settings.btc15mAuto.trailUpdateIntervalSec,
    repeatThresholdMin: settings.btc15mAuto.repeatThresholdMin,
    forceSellThresholdMin: settings.btc15mAuto.forceSellThresholdMin,
    neutralZoneUsd: settings.btc15mAuto.neutralZoneUsd,
    tickIntervalSec: settings.btc15mAuto.tickIntervalSec,
  };
}

function createIdleStatus(
  settings: Settings,
  config: Btc15mAutoBotConfig,
  trades: Btc15mAutoCompletedTrade[],
  persisted: Btc15mAutoPersistentState | null,
): Btc15mAutoBotStatus {
  const wins = trades.filter((trade) => trade.result === "win").length;
  const budget = persisted?.budget
    ? {
        initialBudget: persisted.budget.initialBudget,
        availableBudget: persisted.budget.availableBudget,
        lockedBudget: persisted.budget.lockedBudget,
        equity: persisted.budget.availableBudget + persisted.budget.lockedBudget,
        updatedAt: persisted.budget.updatedAt,
        balanceCheck: persisted.budget.lastBalanceCheck,
      }
    : null;

  return {
    enginePhase: "stopped",
    dryRun: settings.dryRun,
    config,
    market: null,
    marketStartBtcPrice: null,
    currentBtcPrice: null,
    upPrice: null,
    downPrice: null,
    cycle: {
      cyclePhase: "waiting_market",
      cycleStartedAt: null,
      buyOrder: null,
      sellOrder: null,
      position: null,
      plannedBuyPrice: null,
      plannedBuyAnchorPrice: null,
      buyBlockReason: null,
      buyBlockReferencePrice: null,
      highWaterMark: null,
      trailStopPrice: null,
    },
    completedTrades: trades,
    analytics: {
      totalTrades: trades.length,
      wins,
      losses: trades.length - wins,
      winRate: trades.length > 0 ? wins / trades.length : 0,
      totalPnlUsd: Math.round(trades.reduce((sum, trade) => sum + trade.pnlUsd, 0) * 100) / 100,
      grossProfitUsd: Math.round(trades.reduce((sum, trade) => sum + (trade.pnlUsd > 0 ? trade.pnlUsd : 0), 0) * 100) / 100,
      grossLossUsd: Math.round(trades.reduce((sum, trade) => sum + (trade.pnlUsd < 0 ? Math.abs(trade.pnlUsd) : 0), 0) * 100) / 100,
      sessionStartBudgetUsd: budget?.initialBudget ?? 0,
      remainingBudgetUsd: budget?.availableBudget ?? 0,
    },
    sessionTrades: [],
    sessionAnalytics: {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      totalPnlUsd: 0,
      grossProfitUsd: 0,
      grossLossUsd: 0,
      sessionStartBudgetUsd: budget?.initialBudget ?? 0,
      remainingBudgetUsd: budget?.availableBudget ?? 0,
    },
    budget,
    logs: [],
    updatedAt: Date.now(),
    lastError: null,
  };
}

function sanitizeConfigOverrides(overrides: Partial<Btc15mAutoBotConfig> | undefined): Partial<Btc15mAutoBotConfig> {
  if (!overrides) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value > 0),
  ) as Partial<Btc15mAutoBotConfig>;
}

function subscribeMarketBook(
  tokenId: string,
  listener: (bestBid: number | null, bestAsk: number | null) => void,
): void {
  const listeners = bookListeners.get(tokenId) ?? new Set();
  listeners.add(listener);
  bookListeners.set(tokenId, listeners);
  ensureMarketWs();
  reconcileMarketWsAssets();
}

function unsubscribeMarketBook(tokenId: string): void {
  bookListeners.delete(tokenId);
  reconcileMarketWsAssets();
}

function ensureMarketWs(): PolymarketMarketWs {
  if (!marketWs) {
    marketWs = new PolymarketMarketWs(handleMarketWsEvent);
  }
  return marketWs;
}

function reconcileMarketWsAssets(): void {
  if (!marketWs && bookListeners.size === 0) {
    return;
  }
  ensureMarketWs().setTrackedAssets(Array.from(bookListeners.keys()));
}

function handleMarketWsEvent(event: PolymarketMarketWsEvent): void {
  if (event.kind !== "book") {
    return;
  }
  const listeners = bookListeners.get(event.assetId);
  if (!listeners) {
    return;
  }
  for (const listener of listeners) {
    listener(event.bestBid, event.bestAsk);
  }
}

async function fetchBtcPrice(atMs: number): Promise<number | null> {
  // "Now" path: caller wants the current spot price. Use ticker (cheapest, no caching weirdness).
  // We treat "within last 5s" as a now-query, otherwise it's a historical lookup.
  if (Date.now() - atMs < 5_000) {
    const url = new URL("https://api.binance.com/api/v3/ticker/price");
    url.searchParams.set("symbol", "BTCUSDT");
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      throw new Error(`Binance ticker failed: ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json()) as { price?: unknown };
    return parseFiniteNumber(payload.price);
  }

  // Historical path: fetch the 1m kline containing atMs and return its OPEN price
  // (price at the start of that minute), which is what Polymarket's "Price To Beat" reflects.
  // Previously this returned CLOSE (row[4]) — the price one minute LATER — which gave a wrong reference.
  // Also: poll a few attempts because Binance may not have the candle indexed yet
  // if we ask within seconds of the minute starting.
  const startTime = Math.floor(atMs / 60_000) * 60_000;
  const url = new URL("https://api.binance.com/api/v3/klines");
  url.searchParams.set("symbol", "BTCUSDT");
  url.searchParams.set("interval", "1m");
  url.searchParams.set("startTime", String(startTime));
  url.searchParams.set("limit", "1");
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`Binance klines failed: ${response.status} ${response.statusText}`);
  }
  const payload = (await response.json()) as unknown;
  const row = Array.isArray(payload) ? payload[0] : null;
  // Kline row: [openTime, open, high, low, close, volume, ...]. We want open = row[1].
  return Array.isArray(row) ? parseFiniteNumber(row[1]) : null;
}

function parseFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}
