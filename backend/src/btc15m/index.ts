import { PolymarketMarketWs, type PolymarketMarketWsEvent } from "../polymarket-market-ws.js";
import { PolymarketService } from "../polymarket-service.js";
import { ScalperUserWs } from "../scalper-user-ws.js";
import { createBudgetManager } from "../scalper/budget-manager.js";
import type { Settings } from "../config.js";

import { resolveCurrentMarket } from "./market-resolver.js";
import { createBtc15mStateStore } from "./state-store.js";
import { Btc15mBot, type Btc15mRuntime } from "./strategy.js";
import type {
  Btc15mBotConfig,
  Btc15mBotStatus,
  Btc15mCompletedTrade,
  Btc15mPersistentState,
} from "./types.js";

export type {
  Btc15mBotConfig,
  Btc15mBotStatus,
  Btc15mCompletedTrade,
} from "./types.js";

export interface StartBtc15mBotOptions {
  configOverrides?: Partial<Btc15mBotConfig>;
}

let activeBot: Btc15mBot | null = null;
let marketWs: PolymarketMarketWs | null = null;
const bookListeners = new Map<string, Set<(bestBid: number | null, bestAsk: number | null) => void>>();

export async function startBtc15mBot(
  settings: Settings,
  options: StartBtc15mBotOptions = {},
): Promise<Btc15mBotStatus> {
  if (activeBot) {
    return activeBot.getStatus();
  }

  const baseConfig = configFromSettings(settings);
  const config: Btc15mBotConfig = { ...baseConfig, ...sanitizeConfigOverrides(options.configOverrides) };
  const store = createBtc15mStateStore({
    filePath: settings.btc15m.stateFile,
    defaultConfig: baseConfig,
  });
  await store.updateConfig(config);
  const persisted = await store.readState();
  if (persisted.budget.initialBudget !== config.workingBudgetUsd) {
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
  const runtime: Btc15mRuntime = {
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
    persistRuntimeState: (state) => store.updateRuntimeState(state),
    getOrder: async (orderId) => {
      try {
        const order = await service.getOrder(orderId);
        return { status: order.status, size_matched: order.size_matched };
      } catch {
        return null;
      }
    },
  };

  const latestPersisted = await store.readState();
  const bot = new Btc15mBot({
    config,
    dryRun: settings.dryRun,
    runtime,
    initialTrades: latestPersisted.completedTrades,
    initialRuntimeState: latestPersisted,
  });
  await bot.start();
  activeBot = bot;
  return bot.getStatus();
}

export function stopBtc15mBot(settings?: Settings): Btc15mBotStatus {
  if (activeBot) {
    activeBot.stop();
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
      buyPrice: 0.25,
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
    cycle: {
      cyclePhase: "waiting_market",
      cycleStartedAt: null,
      buyOrder: null,
      sellOrder: null,
      position: null,
      highWaterMark: null,
    },
    completedTrades: [],
    analytics: {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      totalPnlUsd: 0,
      remainingBudgetUsd: 0,
    },
    budget: null,
    logs: [],
    updatedAt: Date.now(),
    lastError: null,
  };
}

export async function getBtc15mBotStatus(settings: Settings): Promise<Btc15mBotStatus> {
  if (activeBot) {
    return activeBot.getStatus();
  }

  const store = createBtc15mStateStore({
    filePath: settings.btc15m.stateFile,
    defaultConfig: configFromSettings(settings),
  });
  const persisted = await store.readState();
  const status = createIdleStatus(settings, persisted.config, persisted.completedTrades, persisted);
  status.market = persisted.market;
  status.marketStartBtcPrice = persisted.marketStartBtcPrice;
  status.currentBtcPrice = persisted.currentBtcPrice;
  status.cycle = persisted.cycle;
  status.logs = persisted.logs;
  status.lastError = persisted.lastError;
  return status;
}

export function configFromSettings(settings: Settings): Btc15mBotConfig {
  return {
    workingBudgetUsd: settings.btc15m.workingBudgetUsd,
    shares: settings.btc15m.orderSize,
    buyPrice: settings.btc15m.buyPriceLimit,
    trailStep: settings.btc15m.trailStep,
    trailDist: settings.btc15m.trailDist,
    trailUpdateIntervalSec: settings.btc15m.trailUpdateIntervalSec,
    repeatThresholdMin: settings.btc15m.repeatThresholdMin,
    forceSellThresholdMin: settings.btc15m.forceSellThresholdMin,
    neutralZoneUsd: settings.btc15m.neutralZoneUsd,
    tickIntervalSec: settings.btc15m.tickIntervalSec,
  };
}

function createIdleStatus(
  settings: Settings,
  config: Btc15mBotConfig,
  trades: Btc15mCompletedTrade[],
  persisted: Btc15mPersistentState | null,
): Btc15mBotStatus {
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
    cycle: {
      cyclePhase: "waiting_market",
      cycleStartedAt: null,
      buyOrder: null,
      sellOrder: null,
      position: null,
      highWaterMark: null,
    },
    completedTrades: trades,
    analytics: {
      totalTrades: trades.length,
      wins,
      losses: trades.length - wins,
      winRate: trades.length > 0 ? wins / trades.length : 0,
      totalPnlUsd: Math.round(trades.reduce((sum, trade) => sum + trade.pnlUsd, 0) * 100) / 100,
      remainingBudgetUsd: budget?.availableBudget ?? 0,
    },
    budget,
    logs: [],
    updatedAt: Date.now(),
    lastError: null,
  };
}

function sanitizeConfigOverrides(overrides: Partial<Btc15mBotConfig> | undefined): Partial<Btc15mBotConfig> {
  if (!overrides) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value > 0),
  ) as Partial<Btc15mBotConfig>;
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
  if (Date.now() - atMs < 60_000) {
    const url = new URL("https://api.binance.com/api/v3/ticker/price");
    url.searchParams.set("symbol", "BTCUSDT");
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      throw new Error(`Binance ticker failed: ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json()) as { price?: unknown };
    return parseFiniteNumber(payload.price);
  }

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
  return Array.isArray(row) ? parseFiniteNumber(row[4]) : null;
}

function parseFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}
