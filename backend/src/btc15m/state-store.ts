import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  BudgetBalanceCheck,
  BudgetSnapshot,
} from "../scalper/types.js";
import type {
  Btc15mBotConfig,
  Btc15mCompletedTrade,
  Btc15mCycleState,
  Btc15mPersistedBudgetState,
  Btc15mPersistentState,
  Btc15mRuntimeStateUpdate,
  Btc15mStateStoreOptions,
} from "./types.js";

const PROJECT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MAX_TRADES = 500;
const MAX_LOGS = 100;

export class Btc15mStateStore {
  private readonly filePath: string;
  private readonly defaultConfig: Btc15mBotConfig;
  private updateQueue: Promise<void> = Promise.resolve();

  constructor(options: Btc15mStateStoreOptions) {
    this.filePath = isAbsolute(options.filePath)
      ? options.filePath
      : resolve(PROJECT_ROOT, options.filePath);
    this.defaultConfig = options.defaultConfig;
  }

  async readState(): Promise<Btc15mPersistentState> {
    return this.loadState();
  }

  async updateConfig(config: Btc15mBotConfig): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.loadState();
      state.config = config;
      state.updatedAt = Date.now();
      await this.persistState(state);
    });
  }

  async updateRuntimeState(update: Btc15mRuntimeStateUpdate): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.loadState();
      state.enginePhase = update.enginePhase;
      state.market = update.market;
      state.marketStartBtcPrice = update.marketStartBtcPrice;
      state.currentBtcPrice = update.currentBtcPrice;
      state.cycle = update.cycle;
      state.logs = update.logs.slice(0, MAX_LOGS);
      state.lastError = update.lastError;
      state.updatedAt = Date.now();
      await this.persistState(state);
    });
  }

  async appendCompletedTrade(trade: Btc15mCompletedTrade): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.loadState();
      state.completedTrades = dedupeCompletedTrades([...state.completedTrades, trade]).slice(-MAX_TRADES);
      state.updatedAt = Date.now();
      await this.persistState(state);
    });
  }

  async getBudgetSnapshot(): Promise<BudgetSnapshot> {
    const state = await this.loadState();
    return toBudgetSnapshot(state.budget);
  }

  async initializeBudget(initialBudget: number): Promise<BudgetSnapshot> {
    return this.updateBudget((budget) => {
      if (budget.initialBudget > 0) {
        return;
      }
      budget.initialBudget = roundBudget(initialBudget);
      budget.availableBudget = roundBudget(initialBudget);
      budget.lockedBudget = 0;
      budget.updatedAt = Date.now();
    });
  }

  async updateBudget(
    updater: (budget: Btc15mPersistedBudgetState) => void | Promise<void>,
  ): Promise<BudgetSnapshot> {
    return this.enqueue(async () => {
      const state = await this.loadState();
      await updater(state.budget);
      state.updatedAt = Date.now();
      state.budget.updatedAt = state.updatedAt;
      normalizeBudget(state.budget, this.defaultConfig.workingBudgetUsd);
      await this.persistState(state);
      return toBudgetSnapshot(state.budget);
    });
  }

  async setBalanceCheck(result: BudgetBalanceCheck): Promise<BudgetSnapshot> {
    return this.updateBudget((budget) => {
      budget.lastBalanceCheck = result;
    });
  }

  private async loadState(): Promise<Btc15mPersistentState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return this.normalize(JSON.parse(raw) as Partial<Btc15mPersistentState>);
    } catch (error) {
      if (isMissingFileError(error)) {
        return this.createDefaultState();
      }
      throw error;
    }
  }

  private async persistState(state: Btc15mPersistentState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.updateQueue.then(operation);
    this.updateQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private normalize(input: Partial<Btc15mPersistentState>): Btc15mPersistentState {
    const fallback = this.createDefaultState();
    const state: Btc15mPersistentState = {
      version: 1,
      updatedAt: numberOr(input.updatedAt, fallback.updatedAt),
      config: normalizeConfig(input.config, fallback.config),
      completedTrades: dedupeCompletedTrades(Array.isArray(input.completedTrades) ? input.completedTrades : []),
      budget: normalizeBudgetInput(input.budget, fallback.budget, this.defaultConfig.workingBudgetUsd),
      enginePhase: input.enginePhase === "running" || input.enginePhase === "auto_stopped"
        ? input.enginePhase
        : "stopped",
      market: normalizeMarket(input.market),
      marketStartBtcPrice: nullableNumber(input.marketStartBtcPrice),
      currentBtcPrice: nullableNumber(input.currentBtcPrice),
      cycle: normalizeCycle(input.cycle),
      logs: Array.isArray(input.logs) ? input.logs.slice(0, MAX_LOGS) : [],
      lastError: typeof input.lastError === "string" ? input.lastError : null,
    };

    if (state.enginePhase === "running") {
      state.enginePhase = "stopped";
    }
    return state;
  }

  private createDefaultState(): Btc15mPersistentState {
    const now = Date.now();
    return {
      version: 1,
      updatedAt: now,
      config: this.defaultConfig,
      completedTrades: [],
      budget: {
        initialBudget: roundBudget(this.defaultConfig.workingBudgetUsd),
        availableBudget: roundBudget(this.defaultConfig.workingBudgetUsd),
        lockedBudget: 0,
        updatedAt: now,
        lastBalanceCheck: null,
      },
      enginePhase: "stopped",
      market: null,
      marketStartBtcPrice: null,
      currentBtcPrice: null,
      cycle: emptyCycle(),
      logs: [],
      lastError: null,
    };
  }
}

export function createBtc15mStateStore(options: Btc15mStateStoreOptions): Btc15mStateStore {
  return new Btc15mStateStore(options);
}

export function emptyCycle(): Btc15mCycleState {
  return {
    cyclePhase: "waiting_market",
    cycleStartedAt: null,
    buyOrder: null,
    sellOrder: null,
    position: null,
  };
}

function normalizeConfig(
  input: Partial<Btc15mBotConfig> | undefined,
  fallback: Btc15mBotConfig,
): Btc15mBotConfig {
  return {
    workingBudgetUsd: numberOr(input?.workingBudgetUsd, fallback.workingBudgetUsd),
    shares: numberOr(input?.shares, fallback.shares),
    buyPrice: numberOr(input?.buyPrice, fallback.buyPrice),
    sellPrice: numberOr(input?.sellPrice, fallback.sellPrice),
    repeatThresholdMin: numberOr(input?.repeatThresholdMin, fallback.repeatThresholdMin),
    forceSellThresholdMin: numberOr(input?.forceSellThresholdMin, fallback.forceSellThresholdMin),
    neutralZoneUsd: numberOr(input?.neutralZoneUsd, fallback.neutralZoneUsd),
    tickIntervalSec: numberOr(input?.tickIntervalSec, fallback.tickIntervalSec),
  };
}

function normalizeBudgetInput(
  input: Partial<Btc15mPersistedBudgetState> | undefined,
  fallback: Btc15mPersistedBudgetState,
  maxBudget: number,
): Btc15mPersistedBudgetState {
  const budget = {
    initialBudget: numberOr(input?.initialBudget, fallback.initialBudget),
    availableBudget: numberOr(input?.availableBudget, fallback.availableBudget),
    lockedBudget: numberOr(input?.lockedBudget, fallback.lockedBudget),
    updatedAt: numberOr(input?.updatedAt, fallback.updatedAt),
    lastBalanceCheck: normalizeBalanceCheck(input?.lastBalanceCheck),
  };
  normalizeBudget(budget, maxBudget);
  return budget;
}

function normalizeBudget(budget: Btc15mPersistedBudgetState, maxBudget: number): void {
  budget.initialBudget = Math.max(0, roundBudget(budget.initialBudget || maxBudget));
  budget.availableBudget = Math.max(0, roundBudget(budget.availableBudget));
  budget.lockedBudget = Math.max(0, roundBudget(budget.lockedBudget));
  budget.updatedAt = Number.isFinite(budget.updatedAt) ? budget.updatedAt : Date.now();
}

function toBudgetSnapshot(budget: Btc15mPersistedBudgetState): BudgetSnapshot {
  return {
    initialBudget: budget.initialBudget,
    availableBudget: budget.availableBudget,
    lockedBudget: budget.lockedBudget,
    equity: roundBudget(budget.availableBudget + budget.lockedBudget),
    updatedAt: budget.updatedAt,
    balanceCheck: budget.lastBalanceCheck,
  };
}

function normalizeMarket(value: unknown): Btc15mPersistentState["market"] {
  if (!value || typeof value !== "object") {
    return null;
  }
  const market = value as Record<string, unknown>;
  if (
    typeof market.slug !== "string" ||
    typeof market.question !== "string" ||
    typeof market.upTokenId !== "string" ||
    typeof market.downTokenId !== "string" ||
    typeof market.startTimeMs !== "number" ||
    typeof market.endTimeMs !== "number"
  ) {
    return null;
  }
  return {
    slug: market.slug,
    question: market.question,
    startTimeMs: market.startTimeMs,
    endTimeMs: market.endTimeMs,
    priceToBeat: nullableNumber(market.priceToBeat),
    upTokenId: market.upTokenId,
    downTokenId: market.downTokenId,
  };
}

function normalizeCycle(value: unknown): Btc15mCycleState {
  if (!value || typeof value !== "object") {
    return emptyCycle();
  }
  const cycle = value as Partial<Btc15mCycleState>;
  return {
    cyclePhase: typeof cycle.cyclePhase === "string"
      ? cycle.cyclePhase as Btc15mCycleState["cyclePhase"]
      : "waiting_market",
    cycleStartedAt: nullableNumber(cycle.cycleStartedAt),
    buyOrder: cycle.buyOrder ?? null,
    sellOrder: cycle.sellOrder ?? null,
    position: cycle.position ?? null,
  };
}

function normalizeBalanceCheck(value: unknown): BudgetBalanceCheck | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const check = value as Partial<BudgetBalanceCheck>;
  if (
    typeof check.checkedAt !== "number" ||
    typeof check.maxBotBudget !== "number" ||
    typeof check.passed !== "boolean" ||
    typeof check.message !== "string"
  ) {
    return null;
  }
  return {
    checkedAt: check.checkedAt,
    availableBalance: typeof check.availableBalance === "number" ? check.availableBalance : null,
    maxBotBudget: roundBudget(check.maxBotBudget),
    passed: check.passed,
    message: check.message,
  };
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dedupeCompletedTrades(trades: Btc15mCompletedTrade[]): Btc15mCompletedTrade[] {
  const seen = new Set<string>();
  const result: Btc15mCompletedTrade[] = [];
  for (const trade of trades) {
    const key = completedTradeKey(trade);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(trade);
  }
  return result;
}

function completedTradeKey(trade: Btc15mCompletedTrade): string {
  return [
    trade.marketSlug,
    trade.bettingSide,
    trade.buyPrice,
    trade.sellPrice,
    trade.shares,
    trade.exitReason,
    trade.startedAt,
  ].join("|");
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? roundBudget(value) : fallback;
}

function roundBudget(value: number): number {
  return Math.round(value * 100) / 100;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
