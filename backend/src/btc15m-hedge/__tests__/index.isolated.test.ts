import assert from "node:assert/strict";

import { configFromSettings, shouldResetIdleHedgeBudgetOnStartup, shouldRestartActiveHedgeBotOnStart } from "../index.js";
import type { Btc15mHedgePersistentState } from "../types.js";

function makePersistedState(
  overrides: Partial<Btc15mHedgePersistentState> = {},
): Btc15mHedgePersistentState {
  return {
    version: 1,
    updatedAt: 1,
    config: {
      workingBudgetUsd: 3,
      sharesPerSide: 5,
      targetCombinedPrice: null,
      entryCutoffMin: 6,
      forceUnwindThresholdMin: 2,
      tickIntervalSec: 2,
    },
    completedCycles: [],
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
      phase: "waiting_market",
      cycleStartedAt: null,
      upLeg: {
        tokenId: null,
        side: "up",
        orderId: null,
        orderPrice: null,
        orderSize: 0,
        orderStatus: null,
        filledShares: 0,
        filledCostUsd: 0,
        avgEntryPrice: null,
      },
      downLeg: {
        tokenId: null,
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
      unpairedUpShares: 0,
      unpairedDownShares: 0,
      pairedAvgUp: null,
      pairedAvgDown: null,
      combinedAverage: null,
      pairAssembledAt: null,
      completionLocked: false,
      ...overrides.cycle,
    },
    logs: [],
    lastError: null,
    ...overrides,
  };
}

async function main() {
  assert.equal(
    shouldResetIdleHedgeBudgetOnStartup(
      makePersistedState({
        budget: {
          initialBudget: 3,
          availableBudget: 1.2,
          lockedBudget: 0,
          updatedAt: 1,
          lastBalanceCheck: null,
          lastProfitResetAt: 1,
          skimmedProfitUsd: 0,
        },
      }),
      3,
    ),
    true,
  );

  assert.equal(
    shouldResetIdleHedgeBudgetOnStartup(
      makePersistedState({
        cycle: {
          phase: "building_pair",
          cycleStartedAt: 1,
          upLeg: {
            tokenId: "up-token",
            side: "up",
            orderId: "up-order",
            orderPrice: 0.45,
            orderSize: 5,
            orderStatus: "open",
            filledShares: 1,
            filledCostUsd: 0.45,
            avgEntryPrice: 0.45,
          },
          downLeg: {
            tokenId: null,
            side: "down",
            orderId: null,
            orderPrice: null,
            orderSize: 5,
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
        budget: {
          initialBudget: 3,
          availableBudget: 1.2,
          lockedBudget: 1.8,
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

  assert.equal(
    shouldResetIdleHedgeBudgetOnStartup(
      makePersistedState({
        cycle: {
          phase: "market_idle",
          cycleStartedAt: null,
          upLeg: {
            tokenId: null,
            side: "up",
            orderId: null,
            orderPrice: null,
            orderSize: 0,
            orderStatus: null,
            filledShares: 0,
            filledCostUsd: 0,
            avgEntryPrice: null,
          },
          downLeg: {
            tokenId: null,
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
          unpairedUpShares: 0.5,
          unpairedDownShares: 0,
          pairedAvgUp: null,
          pairedAvgDown: null,
          combinedAverage: null,
          pairAssembledAt: null,
          completionLocked: false,
        },
      }),
      3,
    ),
    false,
  );

  assert.equal(shouldResetIdleHedgeBudgetOnStartup(makePersistedState(), 3), false);
  assert.equal(shouldRestartActiveHedgeBotOnStart("auto_stopped"), true);
  assert.equal(shouldRestartActiveHedgeBotOnStart("running"), false);
  assert.equal(shouldRestartActiveHedgeBotOnStart("stopped"), false);

  const config = configFromSettings({
    polymarketHost: "",
    gammaHost: "",
    chainId: 137,
    signatureType: 0,
    maxSpreadBps: 0,
    maxOrderUsdc: 0,
    minEdgeBps: 0,
    dryRun: true,
    enableScalper: false,
    buyPriceLimit: 0.2,
    sellPriceLimit: 0.3,
    orderSize: 5,
    maxBotBudget: 3,
    minLiquidity: 0,
    cancelBuyBeforeSec: 0,
    cancelSellBeforeSec: 0,
    scalperScanIntervalSec: 5,
    scalper: {
      buyPriceLimit: 0.2,
      sellPriceLimit: 0.3,
      orderSize: 5,
      maxBotBudget: 3,
      minLiquidity: 0,
      cancelBuyBeforeSec: 0,
      cancelSellBeforeSec: 0,
      scannerPollIntervalSec: 5,
      stateFile: "data/scalper.json",
    },
    btc5m: {
      buyPriceLimit: 0.6,
      sellPriceLimit: 0.7,
      orderSize: 5,
      marketScanIntervalSec: 5,
    },
    btc15m: {
      buyPriceLimit: 0.25,
      trailStep: 0.05,
      trailDist: 0.02,
      trailUpdateIntervalSec: 3,
      orderSize: 5,
      workingBudgetUsd: 5,
      repeatThresholdMin: 6,
      forceSellThresholdMin: 2,
      neutralZoneUsd: 5,
      tickIntervalSec: 2,
      stateFile: "data/btc15m.json",
    },
    btc15mAuto: {
      buyPriceLimit: 0.25,
      trailStep: 0.05,
      trailDist: 0.02,
      trailUpdateIntervalSec: 3,
      orderSize: 5,
      workingBudgetUsd: 5,
      repeatThresholdMin: 6,
      forceSellThresholdMin: 2,
      neutralZoneUsd: 5,
      tickIntervalSec: 2,
      stateFile: "data/btc15m-auto.json",
    },
    btc15mHedge: {
      workingBudgetUsd: 3,
      orderSize: 5,
      targetCombinedPrice: null,
      entryCutoffMin: 6,
      forceUnwindThresholdMin: 2,
      tickIntervalSec: 2,
      stateFile: "data/btc15m-hedge.json",
    },
  });
  assert.deepEqual(config, {
    workingBudgetUsd: 3,
    sharesPerSide: 5,
    targetCombinedPrice: null,
    entryCutoffMin: 6,
    forceUnwindThresholdMin: 2,
    tickIntervalSec: 2,
  });

  console.log("btc15m hedge index helpers: OK");
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
