import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBtc15mHedgeStateStore, emptyHedgeCycle } from "../state-store.js";
import type { Btc15mHedgeBotConfig, Btc15mHedgeCycleState } from "../types.js";

const defaultConfig: Btc15mHedgeBotConfig = {
  workingBudgetUsd: 3,
  sharesPerSide: 5,
  targetCombinedPrice: null,
  entryCutoffMin: 6,
  forceUnwindThresholdMin: 2,
  tickIntervalSec: 2,
};

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "btc15m-hedge-store-"));
  try {
    const filePath = join(dir, "state.json");
    const store = createBtc15mHedgeStateStore({ filePath, defaultConfig });

    const initial = await store.readState();
    assert.equal(initial.version, 1);
    assert.equal(initial.config.targetCombinedPrice, null);
    assert.equal(initial.budget.initialBudget, 3);
    assert.equal(initial.budget.availableBudget, 3);
    assert.equal(initial.enginePhase, "stopped");
    assert.equal(initial.cycle.phase, "waiting_market");
    assert.equal(initial.cycle.upLeg.filledShares, 0);
    assert.equal(initial.cycle.downLeg.filledShares, 0);
    assert.equal(initial.cycle.unpairedUpShares, 0);
    assert.equal(initial.cycle.unpairedDownShares, 0);
    assert.deepEqual(initial.completedCycles, []);

    await store.updateConfig({ ...defaultConfig, workingBudgetUsd: 4, targetCombinedPrice: 0.88 });
    const reloadedConfig = await store.readState();
    assert.equal(reloadedConfig.config.workingBudgetUsd, 4);
    assert.equal(reloadedConfig.config.targetCombinedPrice, 0.88);

    const cycle: Btc15mHedgeCycleState = {
      ...emptyHedgeCycle(),
      phase: "paired_holding",
      cycleStartedAt: 10,
      pairedShares: 2.3,
      unpairedUpShares: 0,
      unpairedDownShares: 0,
      pairedAvgUp: 0.46,
      pairedAvgDown: 0.45,
      combinedAverage: 0.91,
      pairAssembledAt: 20,
      upLeg: {
        tokenId: "up-token",
        side: "up",
        orderId: "up-order",
        orderPrice: 0.46,
        orderSize: 5,
        orderStatus: "filled",
        filledShares: 2.3,
        filledCostUsd: 1.06,
        avgEntryPrice: 0.46,
      },
      downLeg: {
        tokenId: "down-token",
        side: "down",
        orderId: "down-order",
        orderPrice: 0.45,
        orderSize: 5,
        orderStatus: "filled",
        filledShares: 2.3,
        filledCostUsd: 1.04,
        avgEntryPrice: 0.45,
      },
    };
    await store.updateRuntimeState({
      enginePhase: "running",
      market: null,
      marketStartBtcPrice: 100_000,
      currentBtcPrice: 100_100,
      cycle,
      logs: [{ timestamp: 1, message: "paired", type: "info" }],
      lastError: null,
    });
    const runtime = await store.readState();
    assert.equal(runtime.enginePhase, "stopped");
    assert.equal(runtime.cycle.phase, "paired_holding");
    assert.equal(runtime.cycle.pairedShares, 2.3);
    assert.equal(runtime.cycle.pairedAvgUp, 0.46);
    assert.equal(runtime.cycle.pairedAvgDown, 0.45);
    assert.equal(runtime.cycle.combinedAverage, 0.91);
    assert.equal(runtime.cycle.upLeg.orderId, "up-order");
    assert.equal(runtime.logs.length, 1);

    await Promise.all([
      store.updateBudget((budget) => {
        budget.availableBudget = 2;
      }),
      store.updateBudget((budget) => {
        budget.lockedBudget = 1;
      }),
    ]);
    const afterBudget = await store.readState();
    assert.equal(afterBudget.budget.availableBudget, 2);
    assert.equal(afterBudget.budget.lockedBudget, 1);

    await store.appendCompletedCycle({
      id: "cycle-1",
      marketSlug: "btc-updown-15m-1",
      targetCombinedPrice: 0.9,
      maxSharesPerSide: 5,
      pairedShares: 2,
      avgUpPrice: 0.45,
      avgDownPrice: 0.44,
      combinedAverage: 0.89,
      unpairedUnwindPnlUsd: 0,
      result: "paired_hold",
      startedAt: 100,
      closedAt: 200,
    });
    await store.appendCompletedCycle({
      id: "cycle-1",
      marketSlug: "btc-updown-15m-1",
      targetCombinedPrice: 0.92,
      maxSharesPerSide: 5,
      pairedShares: 2,
      avgUpPrice: 0.45,
      avgDownPrice: 0.44,
      combinedAverage: 0.89,
      unpairedUnwindPnlUsd: 0.1,
      result: "paired_hold",
      startedAt: 100,
      closedAt: 210,
    });
    const deduped = await store.readState();
    assert.equal(deduped.completedCycles.length, 1);
    assert.equal(deduped.completedCycles[0]?.targetCombinedPrice, 0.92);
    assert.equal(deduped.completedCycles[0]?.closedAt, 210);

    const malformedRaw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    const malformedState = {
      ...malformedRaw,
      config: {
        ...(malformedRaw.config as Record<string, unknown>),
        targetCombinedPrice: "bad-data",
      },
      cycle: {
        ...(malformedRaw.cycle as Record<string, unknown>),
        pairedShares: "bad-data",
        unpairedUpShares: "bad-data",
      },
    };
    await writeFile(filePath, `${JSON.stringify(malformedState, null, 2)}\n`, "utf8");
    const normalized = await store.readState();
    assert.equal(normalized.config.targetCombinedPrice, null);
    assert.equal(normalized.cycle.pairedShares, 0);
    assert.equal(normalized.cycle.unpairedUpShares, 0);

    console.log("btc15m hedge state store: OK");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
