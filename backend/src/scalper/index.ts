import { loadSettings } from "../config.js";
import { PolymarketService } from "../polymarket-service.js";

import { BudgetManager, createBudgetManager } from "./budget-manager.js";
import {
  createScalperStateStore,
  ScalperStateStore,
} from "./state-store.js";

export {
  BudgetManager,
  createBudgetManager,
  createScalperStateStore,
  ScalperStateStore,
};
export type {
  BudgetBalanceCheck,
  BudgetBalanceProvider,
  BudgetManagerOptions,
  BudgetSnapshot,
  ScalperPersistentState,
  ScalperTrackedOrder,
} from "./types.js";

export function createDefaultScalperStateStore() {
  const settings = loadSettings();
  return createScalperStateStore({
    filePath: settings.scalper.stateFile,
    maxBotBudget: settings.scalper.maxBotBudget,
  });
}

export function createDefaultBudgetManager() {
  const settings = loadSettings();
  const store = createDefaultScalperStateStore();
  const service = PolymarketService.getInstance(settings);

  return createBudgetManager({
    store,
    maxBotBudget: settings.scalper.maxBotBudget,
    balanceProvider: service,
  });
}
