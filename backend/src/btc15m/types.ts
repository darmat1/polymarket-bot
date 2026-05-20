import type {
  BudgetBalanceCheck,
  BudgetSnapshot,
} from "../scalper/types.js";

export type Btc15mEnginePhase = "stopped" | "running" | "auto_stopped";

export type Btc15mCyclePhase =
  | "waiting_market"
  | "waiting_direction"
  | "buy_pending"
  | "holding"
  | "force_selling"
  | "cycle_done"
  | "market_idle";

export type Btc15mSide = "up" | "down";

export interface Btc15mMarketView {
  slug: string;
  question: string;
  startTimeMs: number;
  endTimeMs: number;
  priceToBeat: number | null;
  upTokenId: string;
  downTokenId: string;
}

export interface Btc15mTrackedOrder {
  id: string;
  orderId: string | null;
  side: "buy" | "sell";
  tokenId: string;
  bettingSide: Btc15mSide;
  price: number;
  size: number;
  filledSize: number;
  status:
    | "submitting"
    | "open"
    | "partial"
    | "filled"
    | "cancel_requested"
    | "cancelled"
    | "expired"
    | "failed";
  reservedBudget: number;
  createdAt: number;
  updatedAt: number;
  errorMessage?: string | null;
}

export interface Btc15mPosition {
  bettingSide: Btc15mSide;
  tokenId: string;
  shares: number;
  avgEntryPrice: number;
  costBasisUsd: number;
}

export interface Btc15mCompletedTrade {
  id: string;
  marketSlug: string;
  bettingSide: Btc15mSide;
  buyPrice: number;
  sellPrice: number;
  shares: number;
  pnlUsd: number;
  result: "win" | "loss";
  exitReason: "target_sell" | "force_sell" | "resolved_unfilled";
  startedAt: number;
  closedAt: number;
}

export interface Btc15mAnalyticsSummary {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnlUsd: number;
  remainingBudgetUsd: number;
}

export interface Btc15mBotConfig {
  workingBudgetUsd: number;
  shares: number;
  buyPrice: number;
  targetSellPrice: number;
  fallbackSellPrice: number;
  profitCheckDelayMin: number;
  budgetResetIntervalHours: number;
  repeatThresholdMin: number;
  forceSellThresholdMin: number;
  neutralZoneUsd: number;
  tickIntervalSec: number;
}

export interface Btc15mLogEntry {
  timestamp: number;
  message: string;
  type: "info" | "warn" | "error" | "success";
}

export interface Btc15mCycleState {
  cyclePhase: Btc15mCyclePhase;
  cycleStartedAt: number | null;
  buyOrder: Btc15mTrackedOrder | null;
  sellOrder: Btc15mTrackedOrder | null;
  position: Btc15mPosition | null;
}

export interface Btc15mBotStatus {
  enginePhase: Btc15mEnginePhase;
  dryRun: boolean;
  config: Btc15mBotConfig;
  market: Btc15mMarketView | null;
  marketStartBtcPrice: number | null;
  currentBtcPrice: number | null;
  cycle: Btc15mCycleState;
  completedTrades: Btc15mCompletedTrade[];
  analytics: Btc15mAnalyticsSummary;
  budget: BudgetSnapshot | null;
  logs: Btc15mLogEntry[];
  updatedAt: number;
  lastError: string | null;
}

export interface Btc15mPersistedBudgetState {
  initialBudget: number;
  availableBudget: number;
  lockedBudget: number;
  updatedAt: number;
  lastBalanceCheck: BudgetBalanceCheck | null;
  lastProfitResetAt: number | null;
  skimmedProfitUsd: number;
}

export interface Btc15mRuntimeStateUpdate {
  enginePhase: Btc15mEnginePhase;
  market: Btc15mMarketView | null;
  marketStartBtcPrice: number | null;
  currentBtcPrice: number | null;
  cycle: Btc15mCycleState;
  logs: Btc15mLogEntry[];
  lastError: string | null;
}

export interface Btc15mPersistentState extends Btc15mRuntimeStateUpdate {
  version: 1;
  updatedAt: number;
  config: Btc15mBotConfig;
  completedTrades: Btc15mCompletedTrade[];
  budget: Btc15mPersistedBudgetState;
}

export interface Btc15mStateStoreOptions {
  filePath: string;
  defaultConfig: Btc15mBotConfig;
}
