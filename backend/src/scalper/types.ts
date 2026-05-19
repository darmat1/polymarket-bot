export type ScalperOrderSide = "buy" | "sell";

export type ScalperOrderStatus =
  | "pending"
  | "open"
  | "partial"
  | "filled"
  | "cancel_requested"
  | "cancelled"
  | "expired"
  | "failed";

export interface ScalperTrackedOrder {
  id: string;
  marketSlug: string;
  marketId?: string | null;
  tokenId: string;
  outcome?: string | null;
  conditionId?: string | null;
  side: ScalperOrderSide;
  status: ScalperOrderStatus;
  price: number;
  size: number;
  reservedBudget: number;
  createdAt: number;
  updatedAt: number;
  orderId?: string | null;
  matchedSize?: number;
  remainingSize?: number | null;
  expiresAt?: number | null;
  endDateIso?: string | null;
  proceedsReceived?: number;
  dryRun?: boolean;
  errorMessage?: string | null;
}

export interface BudgetBalanceCheck {
  checkedAt: number;
  availableBalance: number | null;
  maxBotBudget: number;
  passed: boolean;
  message: string;
}

export interface PersistedBudgetState {
  initialBudget: number;
  availableBudget: number;
  lockedBudget: number;
  updatedAt: number;
  lastBalanceCheck: BudgetBalanceCheck | null;
}

export interface ScalperPersistentState {
  version: 1;
  updatedAt: number;
  budget: PersistedBudgetState;
  trackedOrders: Record<string, ScalperTrackedOrder>;
}

export interface BudgetSnapshot {
  initialBudget: number;
  availableBudget: number;
  lockedBudget: number;
  equity: number;
  updatedAt: number;
  balanceCheck: BudgetBalanceCheck | null;
}

export interface ScalperStateStoreOptions {
  filePath: string;
  maxBotBudget: number;
}

export interface BudgetBalanceProvider {
  getAvailableBalance(): Promise<number>;
}

export interface BudgetManagerOptions {
  store: {
    getBudgetSnapshot(): Promise<BudgetSnapshot>;
    initializeBudget(initialBudget: number): Promise<BudgetSnapshot>;
    updateBudget(
      updater: (budget: PersistedBudgetState) => void | Promise<void>,
    ): Promise<BudgetSnapshot>;
    setBalanceCheck(result: BudgetBalanceCheck): Promise<BudgetSnapshot>;
  };
  maxBotBudget: number;
  balanceProvider?: BudgetBalanceProvider;
  logger?: Pick<Console, "log" | "warn">;
}
