/**
 * ISOLATED Unit Test for scalper index
 * Target: /Users/andrew/Projects/PM/backend/src/scalper/index.ts
 * Session: ses_1
 *
 * **WARNING**: THIS FILE WILL BE DELETED AFTER TEST PASSES
 * Test code preserved in: .opencode/unit-tests/
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createBudgetManager,
  createScalperStateStore,
} from "../index.js";

async function main() {
  const tempDir = await mkdtemp(join(tmpdir(), "scalper-budget-"));

  try {
    const stateFile = join(tempDir, "state.json");
    const store = createScalperStateStore({
      filePath: stateFile,
      maxBotBudget: 3,
    });
    const manager = createBudgetManager({
      store,
      maxBotBudget: 3,
      balanceProvider: {
        async getAvailableBalance() {
          return 5;
        },
      },
    });

    const initial = await manager.initialize();
    assert.equal(initial.availableBudget, 3);
    assert.equal(initial.lockedBudget, 0);
    assert.equal(initial.equity, 3);
    assert.equal(initial.balanceCheck?.passed, true);

    const reserved = await manager.reserve(1.25, "open buy");
    assert.equal(reserved.availableBudget, 1.75);
    assert.equal(reserved.lockedBudget, 1.25);

    const consumed = await manager.consume(0.75, "partial fill");
    assert.equal(consumed.availableBudget, 1.75);
    assert.equal(consumed.lockedBudget, 0.5);
    assert.equal(consumed.equity, 2.25);

    const released = await manager.release(0.25, "cancel remainder");
    assert.equal(released.availableBudget, 2);
    assert.equal(released.lockedBudget, 0.25);

    const added = await manager.addFunds(0.4, "sell fill");
    assert.equal(added.availableBudget, 2.4);
    assert.equal(added.lockedBudget, 0.25);
    assert.equal(added.equity, 2.65);

    await store.upsertTrackedOrder({
      id: "order-1",
      marketSlug: "market-a",
      tokenId: "token-1",
      side: "buy",
      status: "open",
      price: 0.25,
      size: 5,
      reservedBudget: 1.25,
      createdAt: 1,
      updatedAt: 2,
    });

    const persisted = JSON.parse(await readFile(stateFile, "utf8")) as {
      trackedOrders: Record<string, { reservedBudget: number }>;
      budget: { availableBudget: number; lockedBudget: number };
    };

    assert.equal(persisted.trackedOrders["order-1"]?.reservedBudget, 1.25);
    assert.equal(persisted.budget.availableBudget, 2.4);
    assert.equal(persisted.budget.lockedBudget, 0.25);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

void main();
