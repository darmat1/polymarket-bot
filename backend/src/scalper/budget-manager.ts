import type {
  BudgetBalanceCheck,
  BudgetManagerOptions,
  BudgetSnapshot,
} from "./types.js";

export class BudgetManager {
  private readonly store: BudgetManagerOptions["store"];
  private readonly maxBotBudget: number;
  private readonly balanceProvider?: BudgetManagerOptions["balanceProvider"];
  private readonly logger: Pick<Console, "log" | "warn">;

  constructor(options: BudgetManagerOptions) {
    this.store = options.store;
    this.maxBotBudget = roundBudget(options.maxBotBudget);
    this.balanceProvider = options.balanceProvider;
    this.logger = options.logger ?? console;
  }

  async initialize(): Promise<BudgetSnapshot> {
    await this.store.initializeBudget(this.maxBotBudget);
    const balanceCheck = await this.verifyStartupBalance();
    const snapshot = await this.store.getBudgetSnapshot();
    const nextSnapshot = {
      ...snapshot,
      balanceCheck: balanceCheck ?? snapshot.balanceCheck,
    };
    this.logBudget(nextSnapshot, "initialized");
    return nextSnapshot;
  }

  async verifyStartupBalance(): Promise<BudgetBalanceCheck | null> {
    if (!this.balanceProvider) {
      return null;
    }

    try {
      const availableBalance = roundBudget(
        await this.balanceProvider.getAvailableBalance(),
      );
      const passed = availableBalance + 0.000001 >= this.maxBotBudget;
      const result: BudgetBalanceCheck = {
        checkedAt: Date.now(),
        availableBalance,
        maxBotBudget: this.maxBotBudget,
        passed,
        message: passed
          ? "Real balance covers MAX_BOT_BUDGET."
          : `Real balance ${availableBalance.toFixed(2)} is below MAX_BOT_BUDGET ${this.maxBotBudget.toFixed(2)}.`,
      };

      await this.store.setBalanceCheck(result);
      if (!passed) {
        this.logger.warn(`[BUDGET] Startup balance check failed | ${result.message}`);
      }
      return result;
    } catch (error) {
      const result: BudgetBalanceCheck = {
        checkedAt: Date.now(),
        availableBalance: null,
        maxBotBudget: this.maxBotBudget,
        passed: false,
        message:
          error instanceof Error
            ? error.message
            : "Failed to fetch startup balance.",
      };

      await this.store.setBalanceCheck(result);
      this.logger.warn(`[BUDGET] Startup balance check unavailable | ${result.message}`);
      return result;
    }
  }

  async reserve(amount: number, reason = "reserve"): Promise<BudgetSnapshot> {
    const roundedAmount = normalizeAmount(amount);
    const snapshot = await this.store.updateBudget((budget) => {
      if (budget.availableBudget + 0.000001 < roundedAmount) {
        throw new Error(
          `Insufficient available budget: ${budget.availableBudget.toFixed(2)} < ${roundedAmount.toFixed(2)}`,
        );
      }

      budget.availableBudget = roundBudget(budget.availableBudget - roundedAmount);
      budget.lockedBudget = roundBudget(budget.lockedBudget + roundedAmount);
    });
    this.logBudget(snapshot, reason);
    return snapshot;
  }

  async release(amount: number, reason = "release"): Promise<BudgetSnapshot> {
    const roundedAmount = normalizeAmount(amount);
    const snapshot = await this.store.updateBudget((budget) => {
      if (budget.lockedBudget + 0.000001 < roundedAmount) {
        throw new Error(
          `Insufficient locked budget: ${budget.lockedBudget.toFixed(2)} < ${roundedAmount.toFixed(2)}`,
        );
      }

      budget.lockedBudget = roundBudget(budget.lockedBudget - roundedAmount);
      budget.availableBudget = roundBudget(budget.availableBudget + roundedAmount);
    });
    this.logBudget(snapshot, reason);
    return snapshot;
  }

  async addFunds(amount: number, reason = "add funds"): Promise<BudgetSnapshot> {
    const roundedAmount = normalizeAmount(amount);
    const snapshot = await this.store.updateBudget((budget) => {
      budget.availableBudget = roundBudget(budget.availableBudget + roundedAmount);
    });
    this.logBudget(snapshot, reason);
    return snapshot;
  }

  async consume(amount: number, reason = "consume"): Promise<BudgetSnapshot> {
    const roundedAmount = normalizeAmount(amount);
    const snapshot = await this.store.updateBudget((budget) => {
      if (budget.lockedBudget + 0.000001 < roundedAmount) {
        throw new Error(
          `Insufficient locked budget: ${budget.lockedBudget.toFixed(2)} < ${roundedAmount.toFixed(2)}`,
        );
      }

      budget.lockedBudget = roundBudget(budget.lockedBudget - roundedAmount);
    });
    this.logBudget(snapshot, reason);
    return snapshot;
  }

  async getSnapshot(): Promise<BudgetSnapshot> {
    return this.store.getBudgetSnapshot();
  }

  private logBudget(snapshot: BudgetSnapshot, reason: string) {
    this.logger.log(
      `[BUDGET] Available: ${snapshot.availableBudget.toFixed(2)} | Locked: ${snapshot.lockedBudget.toFixed(2)} | Equity: ${snapshot.equity.toFixed(2)} | ${reason}`,
    );
  }
}

export function createBudgetManager(options: BudgetManagerOptions) {
  return new BudgetManager(options);
}

function normalizeAmount(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Budget amount must be greater than zero. Received: ${amount}`);
  }

  return roundBudget(amount);
}

function roundBudget(value: number): number {
  return Math.round(value * 100) / 100;
}
