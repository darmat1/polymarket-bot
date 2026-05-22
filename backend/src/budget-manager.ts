export interface BudgetBalanceCheck {
  checkedAt: number;
  availableBalance: number | null;
  maxBotBudget: number;
  passed: boolean;
  message: string | null;
}

export interface BudgetSnapshot {
  initialBudget: number;
  availableBudget: number;
  lockedBudget: number;
  equity?: number | null;
  updatedAt: number;
  balanceCheck: BudgetBalanceCheck | null;
  lastProfitResetAt?: number | null;
  skimmedProfitUsd?: number | null;
}

export interface BudgetBalanceProvider {
  getAvailableBalance?(): Promise<number>;
  getAvailableBalanceCents?(): Promise<number>;
}

export interface BudgetStore {
  getBudgetSnapshot(): Promise<BudgetSnapshot>;
  initializeBudget(initialBudget: number): Promise<BudgetSnapshot>;
  updateBudget(updater: (budget: any) => void | Promise<void>): Promise<BudgetSnapshot>;
  setBalanceCheck(result: BudgetBalanceCheck): Promise<BudgetSnapshot>;
}

export interface BudgetManagerOptions {
  store: BudgetStore;
  maxBotBudget: number;
  balanceProvider?: BudgetBalanceProvider;
}

function roundBudget(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export class BudgetManager {
  constructor(private readonly options: BudgetManagerOptions) {}

  async initialize(): Promise<BudgetSnapshot> {
    return this.options.store.initializeBudget(this.options.maxBotBudget);
  }

  async reserve(amount: number, _reason?: string): Promise<BudgetSnapshot> {
    return this.options.store.updateBudget((budget) => {
      const nextAmount = roundBudget(amount);
      if (budget.availableBudget + 1e-9 < nextAmount) {
        throw new Error("Insufficient available budget");
      }
      budget.availableBudget = roundBudget(budget.availableBudget - nextAmount);
      budget.lockedBudget = roundBudget(budget.lockedBudget + nextAmount);
    });
  }

  async release(amount: number, _reason?: string): Promise<BudgetSnapshot> {
    return this.options.store.updateBudget((budget) => {
      const nextAmount = roundBudget(amount);
      budget.lockedBudget = roundBudget(Math.max(0, budget.lockedBudget - nextAmount));
      budget.availableBudget = roundBudget(budget.availableBudget + nextAmount);
    });
  }

  async consume(amount: number, _reason?: string): Promise<BudgetSnapshot> {
    return this.options.store.updateBudget((budget) => {
      const nextAmount = roundBudget(amount);
      budget.lockedBudget = roundBudget(Math.max(0, budget.lockedBudget - nextAmount));
    });
  }

  async addFunds(amount: number, _reason?: string): Promise<BudgetSnapshot> {
    return this.options.store.updateBudget((budget) => {
      budget.availableBudget = roundBudget(budget.availableBudget + roundBudget(amount));
    });
  }

  async checkBalance(requiredAmount: number): Promise<BudgetBalanceCheck> {
    let balance = Number.POSITIVE_INFINITY;
    if (this.options.balanceProvider?.getAvailableBalance) {
      balance = await this.options.balanceProvider.getAvailableBalance();
    } else if (this.options.balanceProvider?.getAvailableBalanceCents) {
      balance = (await this.options.balanceProvider.getAvailableBalanceCents()) / 1_000_000;
    }
    const result: BudgetBalanceCheck = {
      checkedAt: Date.now(),
      availableBalance: balance,
      maxBotBudget: requiredAmount,
      passed: balance >= requiredAmount,
      message: balance >= requiredAmount ? null : "Insufficient balance",
    };
    await this.options.store.setBalanceCheck(result);
    return result;
  }

  async getSnapshot(): Promise<BudgetSnapshot> {
    return this.options.store.getBudgetSnapshot();
  }
}

export function createBudgetManager(options: BudgetManagerOptions) {
  return new BudgetManager(options);
}
