import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  BudgetBalanceCheck,
  BudgetSnapshot,
} from "../budget-manager.js";
import type {
  Btc15mHedgeBotConfig,
  Btc15mHedgeCompletedCycle,
  Btc15mHedgeCycleState,
  Btc15mHedgeLegState,
  Btc15mHedgePersistedBudgetState,
  Btc15mHedgePersistentState,
  Btc15mHedgeRuntimeStateUpdate,
  Btc15mHedgeSide,
  Btc15mHedgeStateStoreOptions,
} from "./types.js";

const PROJECT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MAX_COMPLETED_CYCLES = 500;
const MAX_LOGS = 100;

export class Btc15mHedgeStateStore {
  private readonly filePath: string;
  private readonly defaultConfig: Btc15mHedgeBotConfig;
  private updateQueue: Promise<void> = Promise.resolve();

  constructor(options: Btc15mHedgeStateStoreOptions) {
    this.filePath = isAbsolute(options.filePath)
      ? options.filePath
      : resolve(PROJECT_ROOT, options.filePath);
    this.defaultConfig = options.defaultConfig;
  }

  async readState(): Promise<Btc15mHedgePersistentState> {
    return this.loadState();
  }

  async updateConfig(config: Btc15mHedgeBotConfig): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.loadState();
      state.config = config;
      state.updatedAt = Date.now();
      await this.persistState(state);
    });
  }

  async updateRuntimeState(update: Btc15mHedgeRuntimeStateUpdate): Promise<void> {
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

  async appendCompletedCycle(cycle: Btc15mHedgeCompletedCycle): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.loadState();
      state.completedCycles = dedupeCompletedCycles([...state.completedCycles, cycle]).slice(-MAX_COMPLETED_CYCLES);
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
    updater: (budget: Btc15mHedgePersistedBudgetState) => void | Promise<void>,
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

  private async loadState(): Promise<Btc15mHedgePersistentState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return this.normalize(JSON.parse(raw) as Partial<Btc15mHedgePersistentState>);
    } catch (error) {
      if (isMissingFileError(error)) {
        return this.createDefaultState();
      }
      throw error;
    }
  }

  private async persistState(state: Btc15mHedgePersistentState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}
`, "utf8");
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

  private normalize(input: Partial<Btc15mHedgePersistentState>): Btc15mHedgePersistentState {
    const fallback = this.createDefaultState();
    const state: Btc15mHedgePersistentState = {
      version: 1,
      updatedAt: numberOr(input.updatedAt, fallback.updatedAt),
      config: normalizeConfig(input.config, fallback.config),
      completedCycles: dedupeCompletedCycles(
        Array.isArray(input.completedCycles)
          ? input.completedCycles
              .map((cycle) => normalizeCompletedCycle(cycle))
              .filter((cycle): cycle is Btc15mHedgeCompletedCycle => cycle !== null)
          : [],
      ),
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

  private createDefaultState(): Btc15mHedgePersistentState {
    const now = Date.now();
    return {
      version: 1,
      updatedAt: now,
      config: this.defaultConfig,
      completedCycles: [],
      budget: {
        initialBudget: roundBudget(this.defaultConfig.workingBudgetUsd),
        availableBudget: roundBudget(this.defaultConfig.workingBudgetUsd),
        lockedBudget: 0,
        updatedAt: now,
        lastBalanceCheck: null,
        lastProfitResetAt: now,
        skimmedProfitUsd: 0,
      },
      enginePhase: "stopped",
      market: null,
      marketStartBtcPrice: null,
      currentBtcPrice: null,
      cycle: emptyHedgeCycle(),
      logs: [],
      lastError: null,
    };
  }
}

export function createBtc15mHedgeStateStore(
  options: Btc15mHedgeStateStoreOptions,
): Btc15mHedgeStateStore {
  return new Btc15mHedgeStateStore(options);
}

export function emptyHedgeCycle(): Btc15mHedgeCycleState {
  return {
    phase: "waiting_market",
    cycleStartedAt: null,
    upLeg: emptyLeg("up"),
    downLeg: emptyLeg("down"),
    pairedShares: 0,
    unpairedUpShares: 0,
    unpairedDownShares: 0,
    pairedAvgUp: null,
    pairedAvgDown: null,
    combinedAverage: null,
    pairAssembledAt: null,
    completionLocked: false,
  };
}

function emptyLeg(side: Btc15mHedgeSide): Btc15mHedgeLegState {
  return {
    tokenId: null,
    side,
    orderId: null,
    orderPrice: null,
    orderSize: 0,
    orderStatus: null,
    filledShares: 0,
    filledCostUsd: 0,
    avgEntryPrice: null,
  };
}

function normalizeConfig(
  input: Partial<Btc15mHedgeBotConfig> | undefined,
  fallback: Btc15mHedgeBotConfig,
): Btc15mHedgeBotConfig {
  return {
    workingBudgetUsd: numberOr(input?.workingBudgetUsd, fallback.workingBudgetUsd),
    sharesPerSide: numberOr(input?.sharesPerSide, fallback.sharesPerSide),
    targetCombinedPrice: nullableNumber(input?.targetCombinedPrice) ?? fallback.targetCombinedPrice,
    entryCutoffMin: numberOr(input?.entryCutoffMin, fallback.entryCutoffMin),
    forceUnwindThresholdMin: numberOr(input?.forceUnwindThresholdMin, fallback.forceUnwindThresholdMin),
    tickIntervalSec: numberOr(input?.tickIntervalSec, fallback.tickIntervalSec),
  };
}

function normalizeBudgetInput(
  input: Partial<Btc15mHedgePersistedBudgetState> | undefined,
  fallback: Btc15mHedgePersistedBudgetState,
  maxBudget: number,
): Btc15mHedgePersistedBudgetState {
  const budget = {
    initialBudget: numberOr(input?.initialBudget, fallback.initialBudget),
    availableBudget: numberOr(input?.availableBudget, fallback.availableBudget),
    lockedBudget: numberOr(input?.lockedBudget, fallback.lockedBudget),
    updatedAt: numberOr(input?.updatedAt, fallback.updatedAt),
    lastBalanceCheck: normalizeBalanceCheck(input?.lastBalanceCheck),
    lastProfitResetAt: nullableNumber(input?.lastProfitResetAt) ?? numberOr(input?.updatedAt, fallback.lastProfitResetAt ?? Date.now()),
    skimmedProfitUsd: numberOr(input?.skimmedProfitUsd, fallback.skimmedProfitUsd),
  };
  normalizeBudget(budget, maxBudget);
  return budget;
}

function normalizeBudget(budget: Btc15mHedgePersistedBudgetState, maxBudget: number): void {
  budget.initialBudget = Math.max(0, roundBudget(budget.initialBudget || maxBudget));
  budget.availableBudget = Math.max(0, roundBudget(budget.availableBudget));
  budget.lockedBudget = Math.max(0, roundBudget(budget.lockedBudget));
  budget.updatedAt = Number.isFinite(budget.updatedAt) ? budget.updatedAt : Date.now();
}

function toBudgetSnapshot(budget: Btc15mHedgePersistedBudgetState): BudgetSnapshot {
  return {
    initialBudget: budget.initialBudget,
    availableBudget: budget.availableBudget,
    lockedBudget: budget.lockedBudget,
    equity: roundBudget(budget.availableBudget + budget.lockedBudget),
    updatedAt: budget.updatedAt,
    balanceCheck: budget.lastBalanceCheck,
    lastProfitResetAt: budget.lastProfitResetAt,
    skimmedProfitUsd: budget.skimmedProfitUsd,
  };
}

function normalizeMarket(value: unknown): Btc15mHedgePersistentState["market"] {
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

function normalizeCycle(value: unknown): Btc15mHedgeCycleState {
  if (!value || typeof value !== "object") {
    return emptyHedgeCycle();
  }
  const cycle = value as Partial<Btc15mHedgeCycleState>;
  return {
    phase: normalizeCyclePhase(cycle.phase),
    cycleStartedAt: nullableNumber(cycle.cycleStartedAt),
    upLeg: normalizeLeg("up", cycle.upLeg),
    downLeg: normalizeLeg("down", cycle.downLeg),
    pairedShares: numberOr(cycle.pairedShares, 0),
    unpairedUpShares: numberOr(cycle.unpairedUpShares, 0),
    unpairedDownShares: numberOr(cycle.unpairedDownShares, 0),
    pairedAvgUp: nullableNumber(cycle.pairedAvgUp),
    pairedAvgDown: nullableNumber(cycle.pairedAvgDown),
    combinedAverage: nullableNumber(cycle.combinedAverage),
    pairAssembledAt: nullableNumber(cycle.pairAssembledAt),
    completionLocked: cycle.completionLocked === true,
  };
}

function normalizeCyclePhase(value: unknown): Btc15mHedgeCycleState["phase"] {
  switch (value) {
    case "building_pair":
    case "paired_holding":
    case "unwinding":
    case "cycle_done":
    case "market_idle":
      return value;
    default:
      return "waiting_market";
  }
}

function normalizeLeg(side: Btc15mHedgeSide, value: unknown): Btc15mHedgeLegState {
  if (!value || typeof value !== "object") {
    return emptyLeg(side);
  }
  const leg = value as Partial<Btc15mHedgeLegState>;
  return {
    tokenId: typeof leg.tokenId === "string" ? leg.tokenId : null,
    side,
    orderId: typeof leg.orderId === "string" ? leg.orderId : null,
    orderPrice: nullableNumber(leg.orderPrice),
    orderSize: numberOr(leg.orderSize, 0),
    orderStatus: typeof leg.orderStatus === "string" ? leg.orderStatus : null,
    filledShares: numberOr(leg.filledShares, 0),
    filledCostUsd: numberOr(leg.filledCostUsd, 0),
    avgEntryPrice: nullableNumber(leg.avgEntryPrice),
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

function dedupeCompletedCycles(
  cycles: Btc15mHedgeCompletedCycle[],
): Btc15mHedgeCompletedCycle[] {
  const byCycle = new Map<string, Btc15mHedgeCompletedCycle>();
  for (const cycle of cycles) {
    const key = completedCycleKey(cycle);
    const existing = byCycle.get(key);
    if (!existing) {
      byCycle.set(key, cycle);
      continue;
    }
    if (
      cycle.pairedShares > existing.pairedShares ||
      (cycle.pairedShares === existing.pairedShares && cycle.closedAt > existing.closedAt) ||
      (cycle.pairedShares === existing.pairedShares &&
        cycle.closedAt === existing.closedAt &&
        cycle.unpairedUnwindPnlUsd !== existing.unpairedUnwindPnlUsd)
    ) {
      byCycle.set(key, cycle);
    }
  }
  return Array.from(byCycle.values()).sort((left, right) => left.closedAt - right.closedAt);
}

function completedCycleKey(cycle: Btc15mHedgeCompletedCycle): string {
  return [
    cycle.id,
    cycle.marketSlug,
    cycle.startedAt,
  ].join("|");
}

function normalizeCompletedCycle(value: unknown): Btc15mHedgeCompletedCycle | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const cycle = value as Partial<Btc15mHedgeCompletedCycle>;
  if (
    typeof cycle.id !== "string" ||
    typeof cycle.marketSlug !== "string" ||
    typeof cycle.startedAt !== "number" ||
    typeof cycle.closedAt !== "number"
  ) {
    return null;
  }

  const result = normalizeCompletedCycleResult(cycle.result);
  if (!result) {
    return null;
  }

  return {
    id: cycle.id,
    marketSlug: cycle.marketSlug,
    targetCombinedPrice: numberOr(cycle.targetCombinedPrice, 0),
    maxSharesPerSide: numberOr(cycle.maxSharesPerSide, 0),
    pairedShares: numberOr(cycle.pairedShares, 0),
    avgUpPrice: nullableNumber(cycle.avgUpPrice),
    avgDownPrice: nullableNumber(cycle.avgDownPrice),
    combinedAverage: nullableNumber(cycle.combinedAverage),
    unpairedUnwindPnlUsd: numberOr(cycle.unpairedUnwindPnlUsd, 0),
    result,
    startedAt: cycle.startedAt,
    closedAt: cycle.closedAt,
  };
}

function normalizeCompletedCycleResult(
  value: unknown,
): Btc15mHedgeCompletedCycle["result"] | null {
  switch (value) {
    case "paired_hold":
    case "partial_unwind":
    case "failed_to_pair":
      return value;
    default:
      return null;
  }
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
