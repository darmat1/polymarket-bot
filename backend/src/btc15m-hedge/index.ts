import { PolymarketMarketWs, type PolymarketMarketWsEvent } from "../polymarket-market-ws.js";
import { PolymarketService } from "../polymarket-service.js";
import { ScalperUserWs } from "../scalper-user-ws.js";
import { createBudgetManager } from "../budget-manager.js";
import type { Settings } from "../config.js";
import { resolveCurrentMarket } from "../btc15m/market-resolver.js";

import { createBtc15mHedgeStateStore, emptyHedgeCycle, type Btc15mHedgeStateStore } from "./state-store.js";
import { Btc15mHedgeBot, type Btc15mHedgeBotOptions } from "./strategy.js";
import type {
  Btc15mHedgeBotConfig,
  Btc15mHedgeBotStatus,
  Btc15mHedgeCompletedCycle,
  Btc15mHedgeCycleState,
  Btc15mHedgeEnginePhase,
  Btc15mHedgePersistentState,
} from "./types.js";

export type {
  Btc15mHedgeBotConfig,
  Btc15mHedgeBotStatus,
  Btc15mHedgeCompletedCycle,
  Btc15mHedgeCycleState,
  Btc15mHedgeEnginePhase,
  Btc15mHedgePersistentState,
} from "./types.js";

export {
  createBtc15mHedgeStateStore,
  emptyHedgeCycle,
};

export interface StartBtc15mHedgeBotOptions {
  configOverrides?: Partial<Btc15mHedgeBotConfig>;
}

export interface Btc15mHedgeStatusPayload extends Btc15mHedgeBotStatus {
  analytics: {
    totalCycles: number;
    pairedHolds: number;
    partialUnwinds: number;
    failedToPair: number;
    totalUnpairedUnwindPnlUsd: number;
    remainingBudgetUsd: number;
  };
}

let activeBot: Btc15mHedgeBot | null = null;
let activeStore: Btc15mHedgeStateStore | null = null;
let marketWs: PolymarketMarketWs | null = null;
let userWs: ScalperUserWs | null = null;

export async function startBtc15mHedgeBot(
  settings: Settings,
  options: StartBtc15mHedgeBotOptions = {},
): Promise<Btc15mHedgeStatusPayload> {
  if (activeBot) {
    const phase = activeBot.getStatus().enginePhase;
    if (!shouldRestartActiveHedgeBotOnStart(phase)) {
      return withAnalytics(activeBot.getStatus());
    }
    await shutdownActiveBot();
  }

  const baseConfig = configFromSettings(settings);
  const config: Btc15mHedgeBotConfig = {
    ...baseConfig,
    ...sanitizeConfigOverrides(options.configOverrides),
  };
  const store = createBtc15mHedgeStateStore({
    filePath: settings.btc15mHedge.stateFile,
    defaultConfig: baseConfig,
  });
  activeStore = store;
  await store.updateConfig(config);

  const persistedBeforeReset = await store.readState();
  const persisted = shouldResetIdleHedgeBudgetOnStartup(persistedBeforeReset, config.workingBudgetUsd)
    ? await reconcileStoppedPersistedHedgeBudget(store, config.workingBudgetUsd, persistedBeforeReset)
    : persistedBeforeReset;

  const service = PolymarketService.getInstance(settings);
  await service.initialize();
  const budgetManager = createBudgetManager({
    store,
    maxBotBudget: config.workingBudgetUsd,
    balanceProvider: settings.dryRun ? undefined : service,
  });
  await budgetManager.initialize();

  const bot = new Btc15mHedgeBot({
    config,
    dryRun: settings.dryRun,
    runtime: {
      now: () => Date.now(),
      resolveMarket: async () => {
        const market = await resolveCurrentMarket(settings.gammaHost);
        if (!market) {
          return null;
        }
        return {
          slug: market.slug,
          question: market.question,
          startTimeMs: market.startTimeMs,
          endTimeMs: market.endTimeMs,
          priceToBeat: null,
          upTokenId: market.upTokenId,
          downTokenId: market.downTokenId,
        };
      },
      placeLimitOrder: (args) => service.placeLimitOrder({ ...args, tickSize: "0.01" }),
      cancelOrder: (orderId) => service.cancelOrder(orderId),
      appendCompletedCycle: (cycle) => store.appendCompletedCycle(cycle),
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
        snapshot: () => budgetManager.getSnapshot(),
      },
      persistRuntimeState: async (state) => {
        await store.updateRuntimeState(state);
        syncTrackedAssets(bot.getStatus());
      },
    },
    initialCompletedCycles: persisted.completedCycles,
    initialRuntimeState: persisted,
  });

  activeBot = bot;
  await startUserWs(bot);
  await bot.start();
  syncTrackedAssets(bot.getStatus());
  return withAnalytics(bot.getStatus());
}

export async function stopBtc15mHedgeBot(settings?: Settings): Promise<Btc15mHedgeStatusPayload> {
  if (activeBot) {
    activeBot.stop();
    const status = activeBot.getStatus();
    await shutdownActiveResources();
    activeBot = null;
    activeStore = null;
    return withAnalytics(status);
  }

  if (!settings) {
    return withAnalytics(createBareStoppedStatus());
  }

  const store = createBtc15mHedgeStateStore({
    filePath: settings.btc15mHedge.stateFile,
    defaultConfig: configFromSettings(settings),
  });
  const persisted = await store.readState();
  return withAnalytics(buildStatusFromPersisted(settings, persisted, "stopped"));
}

export async function getBtc15mHedgeBotStatus(settings: Settings): Promise<Btc15mHedgeStatusPayload> {
  if (activeBot) {
    const status = activeBot.getStatus();
    syncTrackedAssets(status);
    return withAnalytics(status);
  }

  const store = createBtc15mHedgeStateStore({
    filePath: settings.btc15mHedge.stateFile,
    defaultConfig: configFromSettings(settings),
  });
  const persisted = await store.readState();
  return withAnalytics(buildStatusFromPersisted(settings, persisted, persisted.enginePhase));
}

export async function reconcileStoppedPersistedHedgeBudget(
  store: Btc15mHedgeStateStore,
  workingBudgetUsd: number,
  persistedState?: Btc15mHedgePersistentState,
): Promise<Btc15mHedgePersistentState> {
  const persisted = persistedState ?? await store.readState();
  if (!shouldResetIdleHedgeBudgetOnStartup(persisted, workingBudgetUsd)) {
    return persisted;
  }

  const resetAt = Date.now();
  await store.updateBudget((budget) => {
    budget.initialBudget = roundBudget(workingBudgetUsd);
    budget.availableBudget = roundBudget(workingBudgetUsd);
    budget.lockedBudget = 0;
    budget.updatedAt = resetAt;
    budget.lastProfitResetAt = resetAt;
    budget.lastBalanceCheck = null;
  });
  return store.readState();
}

export function shouldResetIdleHedgeBudgetOnStartup(
  persisted: Pick<Btc15mHedgePersistentState, "cycle" | "budget">,
  workingBudgetUsd: number,
): boolean {
  const target = roundBudget(workingBudgetUsd);
  if (hasActiveHedgeCycle(persisted.cycle)) {
    return false;
  }
  return persisted.budget.initialBudget !== target ||
    persisted.budget.availableBudget !== target ||
    persisted.budget.lockedBudget !== 0;
}

export function shouldRestartActiveHedgeBotOnStart(
  phase: Btc15mHedgeEnginePhase,
): boolean {
  return phase === "auto_stopped";
}

export function configFromSettings(settings: Settings): Btc15mHedgeBotConfig {
  return {
    workingBudgetUsd: settings.btc15mHedge.workingBudgetUsd,
    sharesPerSide: settings.btc15mHedge.orderSize,
    targetCombinedPrice: settings.btc15mHedge.targetCombinedPrice,
    entryCutoffMin: settings.btc15mHedge.entryCutoffMin,
    forceUnwindThresholdMin: settings.btc15mHedge.forceUnwindThresholdMin,
    tickIntervalSec: settings.btc15mHedge.tickIntervalSec,
  };
}

function sanitizeConfigOverrides(overrides: Partial<Btc15mHedgeBotConfig> | undefined): Partial<Btc15mHedgeBotConfig> {
  if (!overrides) {
    return {};
  }

  const next: Partial<Btc15mHedgeBotConfig> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (key === "targetCombinedPrice") {
      if (value === null) {
        next.targetCombinedPrice = null;
      } else if (typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1) {
        next.targetCombinedPrice = value;
      }
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      switch (key) {
        case "workingBudgetUsd":
        case "sharesPerSide":
        case "entryCutoffMin":
        case "forceUnwindThresholdMin":
        case "tickIntervalSec":
          next[key] = value;
          break;
        default:
          break;
      }
    }
  }
  return next;
}

function buildStatusFromPersisted(
  settings: Settings,
  persisted: Btc15mHedgePersistentState,
  enginePhase: Btc15mHedgeEnginePhase,
): Btc15mHedgeBotStatus {
  return {
    enginePhase,
    dryRun: settings.dryRun,
    config: persisted.config,
    market: persisted.market,
    marketStartBtcPrice: persisted.marketStartBtcPrice,
    currentBtcPrice: persisted.currentBtcPrice,
    cycle: persisted.cycle,
    completedCycles: persisted.completedCycles,
    budget: {
      initialBudget: persisted.budget.initialBudget,
      availableBudget: persisted.budget.availableBudget,
      lockedBudget: persisted.budget.lockedBudget,
      equity: roundBudget(persisted.budget.availableBudget + persisted.budget.lockedBudget),
      updatedAt: persisted.budget.updatedAt,
      balanceCheck: persisted.budget.lastBalanceCheck,
      lastProfitResetAt: persisted.budget.lastProfitResetAt,
      skimmedProfitUsd: persisted.budget.skimmedProfitUsd,
    },
    logs: persisted.logs,
    updatedAt: persisted.updatedAt,
    lastError: persisted.lastError,
  };
}

function createBareStoppedStatus(): Btc15mHedgeBotStatus {
  return {
    enginePhase: "stopped",
    dryRun: true,
    config: {
      workingBudgetUsd: 3,
      sharesPerSide: 5,
      targetCombinedPrice: null,
      entryCutoffMin: 6,
      forceUnwindThresholdMin: 2,
      tickIntervalSec: 2,
    },
    market: null,
    marketStartBtcPrice: null,
    currentBtcPrice: null,
    cycle: emptyHedgeCycle(),
    completedCycles: [],
    budget: null,
    logs: [],
    updatedAt: Date.now(),
    lastError: null,
  };
}

function withAnalytics(status: Btc15mHedgeBotStatus): Btc15mHedgeStatusPayload {
  const pairedHolds = status.completedCycles.filter((cycle) => cycle.result === "paired_hold").length;
  const partialUnwinds = status.completedCycles.filter((cycle) => cycle.result === "partial_unwind").length;
  const failedToPair = status.completedCycles.filter((cycle) => cycle.result === "failed_to_pair").length;
  const totalUnpairedUnwindPnlUsd = roundBudget(
    status.completedCycles.reduce((sum, cycle) => sum + cycle.unpairedUnwindPnlUsd, 0),
  );
  return {
    ...status,
    analytics: {
      totalCycles: status.completedCycles.length,
      pairedHolds,
      partialUnwinds,
      failedToPair,
      totalUnpairedUnwindPnlUsd,
      remainingBudgetUsd: status.budget?.availableBudget ?? 0,
    },
  };
}

async function startUserWs(bot: Btc15mHedgeBot): Promise<void> {
  if (userWs) {
    userWs.stop();
  }
  userWs = new ScalperUserWs((message) => {
    void bot.handleUserWsMessage(message).then(() => {
      syncTrackedAssets(bot.getStatus());
    });
  });
  await userWs.start();
}

async function shutdownActiveBot(): Promise<void> {
  if (activeBot) {
    activeBot.stop();
  }
  await shutdownActiveResources();
  activeBot = null;
  activeStore = null;
}

async function shutdownActiveResources(): Promise<void> {
  userWs?.stop();
  userWs = null;
  if (marketWs) {
    marketWs.setTrackedAssets([]);
  }
}

function syncTrackedAssets(status: Btc15mHedgeBotStatus): void {
  const market = status.market;
  if (!market) {
    if (marketWs) {
      marketWs.setTrackedAssets([]);
    }
    return;
  }
  ensureMarketWs().setTrackedAssets([market.upTokenId, market.downTokenId]);
}

function ensureMarketWs(): PolymarketMarketWs {
  if (!marketWs) {
    marketWs = new PolymarketMarketWs(handleMarketWsEvent);
  }
  return marketWs;
}

function handleMarketWsEvent(event: PolymarketMarketWsEvent): void {
  if (event.kind !== "book" || !activeBot) {
    return;
  }
  activeBot.updateBook(event.assetId, {
    bestBid: event.bestBid,
    bestAsk: event.bestAsk,
  });
}

function hasActiveHedgeCycle(cycle: Btc15mHedgeCycleState): boolean {
  return cycle.phase !== "waiting_market" &&
    cycle.phase !== "market_idle" ||
    cycle.cycleStartedAt !== null ||
    hasActiveHedgeLeg(cycle.upLeg) ||
    hasActiveHedgeLeg(cycle.downLeg) ||
    cycle.pairedShares > 0 ||
    cycle.unpairedUpShares > 0 ||
    cycle.unpairedDownShares > 0 ||
    cycle.pairedAvgUp !== null ||
    cycle.pairedAvgDown !== null ||
    cycle.combinedAverage !== null ||
    cycle.pairAssembledAt !== null ||
    cycle.completionLocked;
}

function hasActiveHedgeLeg(leg: Btc15mHedgeCycleState["upLeg"]): boolean {
  return leg.tokenId !== null ||
    leg.orderId !== null ||
    leg.orderPrice !== null ||
    leg.orderSize > 0 ||
    leg.orderStatus !== null ||
    leg.filledShares > 0 ||
    leg.filledCostUsd > 0 ||
    leg.avgEntryPrice !== null;
}

function roundBudget(value: number): number {
  return Math.round(value * 100) / 100;
}
