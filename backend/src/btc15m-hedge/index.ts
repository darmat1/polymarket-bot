import type { Settings } from "../config.js";

import { createBtc15mHedgeStateStore, emptyHedgeCycle, type Btc15mHedgeStateStore } from "./state-store.js";
import type {
  Btc15mHedgeBotConfig,
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
