import { ClobPublicClient } from "../clob.js";
import { PolymarketMarketWs, type PolymarketMarketWsEvent } from "../polymarket-market-ws.js";
import { PolymarketService } from "../polymarket-service.js";
import { ScalperUserWs } from "../scalper-user-ws.js";
import { createBudgetManager } from "../scalper/budget-manager.js";
import type { Settings } from "../config.js";

import { PolymarketChainlinkBtcPriceSource } from "./chainlink-price-source.js";
import { PolymarketCryptoPriceClient } from "./crypto-price-client.js";
import { resolveCurrentMarket } from "./market-resolver.js";
import { createBtc15mStateStore } from "./state-store.js";
import { Btc15mBot, type Btc15mRuntime } from "./strategy.js";
import { emptyCycle } from "./state-store.js";
import type {
  Btc15mBotConfig,
  Btc15mBotStatus,
  Btc15mCompletedTrade,
  Btc15mLogEntry,
  Btc15mPersistentState,
  Btc15mSide,
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
let chainlinkPriceSource: PolymarketChainlinkBtcPriceSource | null = null;
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
      budget.lastProfitResetAt = Date.now();
      budget.skimmedProfitUsd = 0;
      budget.lastBalanceCheck = null;
    });
  }

  const service = PolymarketService.getInstance(settings);
  const clob = new ClobPublicClient(settings.polymarketHost);
  const priceSource = ensureChainlinkPriceSource();
  const cryptoPriceClient = new PolymarketCryptoPriceClient();
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
    fetchBtcPrice: (atMs) => priceSource.getPrice(atMs),
    fetchMarketStartPrice: (market) => cryptoPriceClient.getBtc15mPriceToBeat(market),
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
      resetAvailableBudget: async (maxAvailable, resetAt, reason) => {
        let skimmedProfitUsd = 0;
        const snapshot = await store.updateBudget((budget) => {
          budget.lastProfitResetAt = resetAt;
          const target = roundBudget(maxAvailable);
          if (budget.lockedBudget <= 0 && budget.availableBudget > target) {
            skimmedProfitUsd = roundBudget(budget.availableBudget - target);
            budget.availableBudget = target;
            budget.skimmedProfitUsd = roundBudget((budget.skimmedProfitUsd ?? 0) + skimmedProfitUsd);
          }
        });
        console.log(
          `[BUDGET] Available: ${snapshot.availableBudget.toFixed(2)} | Locked: ${snapshot.lockedBudget.toFixed(2)} | Equity: ${snapshot.equity.toFixed(2)} | ${reason ?? "btc15m-budget-reset"}`,
        );
        return { snapshot, skimmedProfitUsd };
      },
    },
    persistTrade: (trade) => store.appendCompletedTrade(trade),
    persistConfig: (cfg) => store.updateConfig(cfg),
    persistRuntimeState: (state) => store.updateRuntimeState(state),
    getLivePosition: (market) => getLivePosition(service, market),
    getTopOfBook: (tokenId) => clob.getTopOfBook(tokenId),
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

export async function stopBtc15mBot(settings?: Settings): Promise<Btc15mBotStatus> {
  if (activeBot) {
    await activeBot.stop();
    const status = activeBot.getStatus();
    activeBot = null;
    if (bookListeners.size === 0) {
      chainlinkPriceSource?.close();
      chainlinkPriceSource = null;
    }
    return status;
  }

  if (settings) {
    await cleanupPersistedOpenOrders(settings);
    return getBtc15mBotStatus(settings);
  }

  return {
    enginePhase: "stopped",
    dryRun: true,
    config: {
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

function ensureChainlinkPriceSource(): PolymarketChainlinkBtcPriceSource {
  if (!chainlinkPriceSource) {
    chainlinkPriceSource = new PolymarketChainlinkBtcPriceSource();
  }
  return chainlinkPriceSource;
}

async function cleanupPersistedOpenOrders(settings: Settings): Promise<void> {
  const baseConfig = configFromSettings(settings);
  const store = createBtc15mStateStore({
    filePath: settings.btc15m.stateFile,
    defaultConfig: baseConfig,
  });
  const persisted = await store.readState();
  const { buyOrder, sellOrder } = persisted.cycle;
  if (!buyOrder && !sellOrder) {
    return;
  }

  const service = PolymarketService.getInstance(settings);
  await service.initialize();
  for (const order of [buyOrder, sellOrder]) {
    if (!order?.orderId) {
      continue;
    }
    try {
      await service.cancelOrder(order.orderId);
    } catch {
      // Best effort: order may already be filled/cancelled or invisible in UI.
    }
  }

  if (buyOrder?.reservedBudget && buyOrder.reservedBudget > 0) {
    await store.updateBudget((budget) => {
      const release = Math.min(budget.lockedBudget, buyOrder.reservedBudget);
      budget.lockedBudget = Math.max(0, budget.lockedBudget - release);
      budget.availableBudget += release;
    });
  }

  const log: Btc15mLogEntry = {
    timestamp: Date.now(),
    message: "Cleared persisted BTC 15m open-order state while bot was stopped.",
    type: "warn",
  };
  await store.updateRuntimeState({
    enginePhase: "stopped",
    market: null,
    marketStartBtcPrice: null,
    currentBtcPrice: null,
    cycle: emptyCycle(),
    logs: [log, ...persisted.logs].slice(0, 60),
    lastError: null,
  });
}

export async function getBtc15mBotStatus(settings: Settings): Promise<Btc15mBotStatus> {
  if (activeBot) {
    return activeBot.getStatus();
  }

  const store = createBtc15mStateStore({
    filePath: settings.btc15m.stateFile,
    defaultConfig: configFromSettings(settings),
  });
  const persisted = await reconcileStoppedPersistedOpenOrders(settings, store);
  const status = createIdleStatus(settings, persisted.config, persisted.completedTrades, persisted);
  const hasActiveCycle = Boolean(persisted.cycle.buyOrder || persisted.cycle.sellOrder || persisted.cycle.position);
  status.market = hasActiveCycle ? persisted.market : null;
  status.marketStartBtcPrice = hasActiveCycle ? persisted.marketStartBtcPrice : null;
  status.currentBtcPrice = hasActiveCycle ? persisted.currentBtcPrice : null;
  status.cycle = hasActiveCycle ? persisted.cycle : emptyCycle();
  status.logs = persisted.logs;
  status.lastError = persisted.lastError;
  return status;
}

async function reconcileStoppedPersistedOpenOrders(
  settings: Settings,
  store: ReturnType<typeof createBtc15mStateStore>,
): Promise<Btc15mPersistentState> {
  const persisted = await store.readState();
  const { buyOrder, sellOrder, position } = persisted.cycle;
  const savedOrderIds = [buyOrder?.orderId, sellOrder?.orderId].filter((orderId): orderId is string => Boolean(orderId));
  if (savedOrderIds.length === 0 || position) {
    return persisted;
  }

  if (!settings.dryRun) {
    try {
      const service = PolymarketService.getInstance(settings);
      await service.initialize();
      const liveOrders = await service.getOpenOrders();
      const liveOrderIds = new Set(liveOrders.map((order) => order.id));
      if (savedOrderIds.some((orderId) => liveOrderIds.has(orderId))) {
        return persisted;
      }
    } catch {
      return persisted;
    }
  }

  if (buyOrder?.reservedBudget && buyOrder.reservedBudget > 0) {
    await store.updateBudget((budget) => {
      const release = Math.min(budget.lockedBudget, buyOrder.reservedBudget);
      budget.lockedBudget = Math.max(0, budget.lockedBudget - release);
      budget.availableBudget += release;
    });
  }

  const log: Btc15mLogEntry = {
    timestamp: Date.now(),
    message: "Cleared stale BTC 15m order state because no matching live open order exists.",
    type: "warn",
  };
  await store.updateRuntimeState({
    enginePhase: "stopped",
    market: null,
    marketStartBtcPrice: null,
    currentBtcPrice: null,
    cycle: emptyCycle(),
    logs: [log, ...persisted.logs].slice(0, 60),
    lastError: null,
  });
  return store.readState();
}

export function configFromSettings(settings: Settings): Btc15mBotConfig {
  return {
    workingBudgetUsd: settings.btc15m.workingBudgetUsd,
    shares: settings.btc15m.orderSize,
    buyPrice: settings.btc15m.buyPriceLimit,
    targetSellPrice: settings.btc15m.targetSellPriceLimit,
    fallbackSellPrice: settings.btc15m.fallbackSellPriceLimit,
    profitCheckDelayMin: settings.btc15m.profitCheckDelayMin,
    budgetResetIntervalHours: settings.btc15m.budgetResetIntervalHours,
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
        lastProfitResetAt: persisted.budget.lastProfitResetAt,
        skimmedProfitUsd: persisted.budget.skimmedProfitUsd,
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

function roundBudget(value: number): number {
  return Math.round(value * 100) / 100;
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

async function getLivePosition(
  service: PolymarketService,
  market: { upTokenId: string; downTokenId: string },
): Promise<{ bettingSide: Btc15mSide; tokenId: string; shares: number } | null> {
  const [upShares, downShares] = await Promise.all([
    service.getConditionalBalance(market.upTokenId),
    service.getConditionalBalance(market.downTokenId),
  ]);

  if (upShares > 0.000001) {
    return { bettingSide: "up", tokenId: market.upTokenId, shares: upShares };
  }
  if (downShares > 0.000001) {
    return { bettingSide: "down", tokenId: market.downTokenId, shares: downShares };
  }
  return null;
}
