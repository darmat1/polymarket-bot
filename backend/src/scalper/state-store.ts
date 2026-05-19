import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  BudgetBalanceCheck,
  BudgetSnapshot,
  PersistedBudgetState,
  ScalperPersistentState,
  ScalperStateStoreOptions,
  ScalperTrackedOrder,
} from "./types.js";

const PROJECT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export class ScalperStateStore {
  private readonly filePath: string;
  private readonly maxBotBudget: number;
  private updateQueue: Promise<void> = Promise.resolve();

  constructor(options: ScalperStateStoreOptions) {
    this.filePath = isAbsolute(options.filePath)
      ? options.filePath
      : resolve(PROJECT_ROOT, options.filePath);
    this.maxBotBudget = roundBudget(options.maxBotBudget);
  }

  async readState(): Promise<ScalperPersistentState> {
    return this.loadState();
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
    updater: (budget: PersistedBudgetState) => void | Promise<void>,
  ): Promise<BudgetSnapshot> {
    return this.enqueue(async () => {
      const state = await this.loadState();
      await updater(state.budget);
      state.updatedAt = Date.now();
      state.budget.updatedAt = state.updatedAt;
      normalizeBudgetState(state.budget, this.maxBotBudget);
      await this.persistState(state);
      return toBudgetSnapshot(state.budget);
    });
  }

  async setBalanceCheck(result: BudgetBalanceCheck): Promise<BudgetSnapshot> {
    return this.updateBudget((budget) => {
      budget.lastBalanceCheck = result;
    });
  }

  async upsertTrackedOrder(order: ScalperTrackedOrder): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.loadState();
      state.trackedOrders[order.id] = {
        ...state.trackedOrders[order.id],
        ...order,
      };
      state.updatedAt = Date.now();
      await this.persistState(state);
    });
  }

  async removeTrackedOrder(orderId: string): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.loadState();
      delete state.trackedOrders[orderId];
      state.updatedAt = Date.now();
      await this.persistState(state);
    });
  }

  async listTrackedOrders(): Promise<ScalperTrackedOrder[]> {
    const state = await this.loadState();
    return Object.values(state.trackedOrders);
  }

  private async loadState(): Promise<ScalperPersistentState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return normalizeState(JSON.parse(raw) as Partial<ScalperPersistentState>, this.maxBotBudget);
    } catch (error) {
      if (isMissingFileError(error)) {
        return createDefaultState(this.maxBotBudget);
      }

      throw error;
    }
  }

  private async persistState(state: ScalperPersistentState): Promise<void> {
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
}

export function createScalperStateStore(options: ScalperStateStoreOptions) {
  return new ScalperStateStore(options);
}

function createDefaultState(maxBotBudget: number): ScalperPersistentState {
  const now = Date.now();
  return {
    version: 1,
    updatedAt: now,
    budget: {
      initialBudget: roundBudget(maxBotBudget),
      availableBudget: roundBudget(maxBotBudget),
      lockedBudget: 0,
      updatedAt: now,
      lastBalanceCheck: null,
    },
    trackedOrders: {},
  };
}

function normalizeState(
  input: Partial<ScalperPersistentState>,
  maxBotBudget: number,
): ScalperPersistentState {
  const state = createDefaultState(maxBotBudget);
  state.version = 1;
  state.updatedAt =
    typeof input.updatedAt === "number" && Number.isFinite(input.updatedAt)
      ? input.updatedAt
      : state.updatedAt;
  state.trackedOrders = normalizeTrackedOrders(input.trackedOrders);

  if (input.budget && typeof input.budget === "object") {
    state.budget = {
      initialBudget: numberOrFallback(input.budget.initialBudget, state.budget.initialBudget),
      availableBudget: numberOrFallback(
        input.budget.availableBudget,
        state.budget.availableBudget,
      ),
      lockedBudget: numberOrFallback(input.budget.lockedBudget, state.budget.lockedBudget),
      updatedAt: numberOrFallback(input.budget.updatedAt, state.budget.updatedAt),
      lastBalanceCheck: normalizeBalanceCheck(input.budget.lastBalanceCheck),
    };
  }

  normalizeBudgetState(state.budget, maxBotBudget);
  return state;
}

function normalizeTrackedOrders(
  input: Partial<Record<string, ScalperTrackedOrder>> | undefined,
): Record<string, ScalperTrackedOrder> {
  if (!input || typeof input !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, ScalperTrackedOrder] => {
      const [, value] = entry;
      return Boolean(value && typeof value.id === "string" && value.id.length > 0);
    }),
  );
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
    availableBalance:
      typeof check.availableBalance === "number" ? check.availableBalance : null,
    maxBotBudget: roundBudget(check.maxBotBudget),
    passed: check.passed,
    message: check.message,
  };
}

function normalizeBudgetState(
  budget: PersistedBudgetState,
  maxBotBudget: number,
): void {
  const fallback = roundBudget(maxBotBudget);
  budget.initialBudget = Math.max(0, roundBudget(budget.initialBudget || fallback));
  budget.availableBudget = Math.max(0, roundBudget(budget.availableBudget));
  budget.lockedBudget = Math.max(0, roundBudget(budget.lockedBudget));
  budget.updatedAt =
    typeof budget.updatedAt === "number" && Number.isFinite(budget.updatedAt)
      ? budget.updatedAt
      : Date.now();
}

function toBudgetSnapshot(budget: PersistedBudgetState): BudgetSnapshot {
  return {
    initialBudget: budget.initialBudget,
    availableBudget: budget.availableBudget,
    lockedBudget: budget.lockedBudget,
    equity: roundBudget(budget.availableBudget + budget.lockedBudget),
    updatedAt: budget.updatedAt,
    balanceCheck: budget.lastBalanceCheck,
  };
}

function numberOrFallback(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? roundBudget(value) : fallback;
}

function roundBudget(value: number): number {
  return Math.round(value * 100) / 100;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
