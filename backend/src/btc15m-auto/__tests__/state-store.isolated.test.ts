import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBtc15mAutoStateStore } from "../state-store.js";
import type {
  Btc15mAutoBotConfig,
  Btc15mAutoCompletedTrade,
  Btc15mAutoCycleState,
  Btc15mAutoMarketView,
} from "../types.js";

const defaultConfig: Btc15mAutoBotConfig = {
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
};

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "btc15mAuto-store-"));
  try {
    const filePath = join(dir, "state.json");
    const store = createBtc15mAutoStateStore({ filePath, defaultConfig });

    const initial = await store.readState();
    assert.equal(initial.version, 1);
    assert.equal(initial.budget.initialBudget, 5);
    assert.equal(initial.budget.availableBudget, 5);
    assert.equal(initial.budget.lockedBudget, 0);
    assert.equal(initial.enginePhase, "stopped");
    assert.deepEqual(initial.completedTrades, []);
    assert.equal(initial.market, null);
    assert.equal(initial.cycle.position, null);

    await store.updateConfig({ ...defaultConfig, workingBudgetUsd: 10 });
    const reloaded = await store.readState();
    assert.equal(reloaded.config.workingBudgetUsd, 10);

    const market: Btc15mAutoMarketView = {
      slug: "btc-updown-15m-1779220800",
      question: "BTC up/down 15m",
      startTimeMs: 1_779_220_800_000,
      endTimeMs: 1_779_221_700_000,
      upTokenId: "tok-up",
      downTokenId: "tok-down",
    };
    const cycle: Btc15mAutoCycleState = {
      cyclePhase: "holding",
      cycleStartedAt: 1,
      buyOrder: null,
      sellOrder: null,
      position: {
        bettingSide: "down",
        tokenId: "tok-down",
        shares: 5,
        avgEntryPrice: 0.25,
        costBasisUsd: 1.25,
      },
      highWaterMark: 0.25,
      trailStopPrice: 0.2,
    };
    await store.updateRuntimeState({
      enginePhase: "running",
      market,
      marketStartBtcPrice: 100_000,
      currentBtcPrice: 100_100,
      cycle,
      logs: [{ timestamp: 1, message: "test", type: "info" }],
      lastError: null,
    });
    const runtime = await store.readState();
    assert.equal(runtime.enginePhase, "stopped");
    assert.equal(runtime.market?.slug, market.slug);
    assert.equal(runtime.cycle.position?.tokenId, "tok-down");
    assert.equal(runtime.logs.length, 1);

    const trade: Btc15mAutoCompletedTrade = {
      id: "t1",
      marketSlug: "btc-updown-15m-1779220800",
      bettingSide: "down",
      buyPrice: 0.25,
      sellPrice: 0.4,
      shares: 5,
      pnlUsd: 0.75,
      result: "win",
      exitReason: "target_sell",
      startedAt: 1,
      closedAt: 2,
    };
    await store.appendCompletedTrade(trade);
    const afterTrade = await store.readState();
    assert.equal(afterTrade.completedTrades.length, 1);
    assert.equal(afterTrade.completedTrades[0].id, "t1");

    await Promise.all([
      store.updateBudget((b) => {
        b.availableBudget = 9;
      }),
      store.updateBudget((b) => {
        b.lockedBudget = 1;
      }),
    ]);
    const afterConcurrent = await store.readState();
    assert.equal(afterConcurrent.budget.availableBudget, 9);
    assert.equal(afterConcurrent.budget.lockedBudget, 1);

    console.log("state-store: OK");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
