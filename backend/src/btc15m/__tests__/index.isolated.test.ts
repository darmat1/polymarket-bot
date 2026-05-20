import assert from "node:assert/strict";

import { shouldResetIdleBudgetOnStartup, shouldRestartActiveBotOnStart } from "../index.js";
import type { Btc15mPersistentState } from "../types.js";

function makePersistedState(overrides: Partial<Btc15mPersistentState> = {}): Btc15mPersistentState {
  return {
    version: 1,
    updatedAt: 1,
    config: {
      workingBudgetUsd: 3,
      shares: 5,
      buyPrice: 0.25,
      targetSellPrice: 0.6,
      fallbackSellPrice: 0.3,
      profitCheckDelayMin: 3,
      budgetResetIntervalHours: 3,
      repeatThresholdMin: 6,
      forceSellThresholdMin: 3,
      neutralZoneUsd: 5,
      tickIntervalSec: 2,
    },
    completedTrades: [],
    budget: {
      initialBudget: 3,
      availableBudget: 3,
      lockedBudget: 0,
      updatedAt: 1,
      lastBalanceCheck: null,
      lastProfitResetAt: 1,
      skimmedProfitUsd: 0,
      ...overrides.budget,
    },
    enginePhase: "stopped",
    market: null,
    marketStartBtcPrice: null,
    currentBtcPrice: null,
    cycle: {
      cyclePhase: "waiting_market",
      cycleStartedAt: null,
      buyOrder: null,
      sellOrder: null,
      position: null,
      ...overrides.cycle,
    },
    logs: [],
    lastError: null,
    ...overrides,
  };
}

async function main() {
  assert.equal(
    shouldResetIdleBudgetOnStartup(
      makePersistedState({
        budget: {
          initialBudget: 3,
          availableBudget: 6.4,
          lockedBudget: 0,
          updatedAt: 1,
          lastBalanceCheck: null,
          lastProfitResetAt: 1,
          skimmedProfitUsd: 2.9,
        },
      }),
      3,
    ),
    true,
  );

  assert.equal(
    shouldResetIdleBudgetOnStartup(
      makePersistedState({
        cycle: {
          cyclePhase: "buy_pending",
          cycleStartedAt: 1,
          buyOrder: {
            id: "buy",
            orderId: "buy-order",
            side: "buy",
            tokenId: "tok",
            bettingSide: "up",
            price: 0.25,
            size: 5,
            filledSize: 0,
            status: "open",
            reservedBudget: 1.25,
            createdAt: 1,
            updatedAt: 1,
          },
          sellOrder: null,
          position: null,
        },
        budget: {
          initialBudget: 3,
          availableBudget: 1.75,
          lockedBudget: 1.25,
          updatedAt: 1,
          lastBalanceCheck: null,
          lastProfitResetAt: 1,
          skimmedProfitUsd: 0,
        },
      }),
      3,
    ),
    false,
  );

  assert.equal(shouldResetIdleBudgetOnStartup(makePersistedState(), 3), false);
  assert.equal(shouldRestartActiveBotOnStart("auto_stopped"), true);
  assert.equal(shouldRestartActiveBotOnStart("running"), false);
  assert.equal(shouldRestartActiveBotOnStart("stopped"), false);
  console.log("btc15m startup budget reset: OK");
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
