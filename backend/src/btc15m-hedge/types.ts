import type {
  BudgetBalanceCheck,
  BudgetSnapshot,
} from "../budget-manager.js";

export type Btc15mHedgeEnginePhase = "stopped" | "running" | "auto_stopped";

export type Btc15mHedgeCyclePhase =
  | "waiting_market"
  | "placing_orders"
  | "waiting_fills"
  | "paired_holding"
  | "cycle_done";

export type Btc15mHedgeSide = "up" | "down";

export interface Btc15mHedgeMarketView {
  slug: string;
  question: string;
  startTimeMs: number;
  endTimeMs: number;
  priceToBeat: number | null;
  upTokenId: string;
  downTokenId: string;
}

export interface Btc15mHedgeBotConfig {
  marketUrl: string;
  buyPrice: number;
  shares: number;
}

export interface Btc15mHedgeLegState {
  tokenId: string | null;
  side: Btc15mHedgeSide;
  orderId: string | null;
  orderPrice: number | null;
  orderSize: number;
  orderStatus: string | null;
  filledShares: number;
  filledCostUsd: number;
  avgEntryPrice: number | null;
}

export interface Btc15mHedgeCompletedCycle {
  id: string;
  marketSlug: string;
  buyPrice: number;
  shares: number;
  upFilled: number;
  downFilled: number;
  avgUpPrice: number | null;
  avgDownPrice: number | null;
  totalCostUsd: number;
  result: "paired_hold" | "partial_fill";
  startedAt: number;
  closedAt: number;
}

export interface Btc15mHedgeLogEntry {
  timestamp: number;
  message: string;
  type: "info" | "warn" | "error" | "success";
}

export interface Btc15mHedgeCycleState {
  phase: Btc15mHedgeCyclePhase;
  cycleStartedAt: number | null;
  upLeg: Btc15mHedgeLegState;
  downLeg: Btc15mHedgeLegState;
  pairedShares: number;
}

export interface Btc15mHedgeBotStatus {
  enginePhase: Btc15mHedgeEnginePhase;
  dryRun: boolean;
  config: Btc15mHedgeBotConfig;
  market: Btc15mHedgeMarketView | null;
  cycle: Btc15mHedgeCycleState;
  completedCycles: Btc15mHedgeCompletedCycle[];
  logs: Btc15mHedgeLogEntry[];
  updatedAt: number;
  lastError: string | null;
}

export interface Btc15mHedgePersistedBudgetState {
  initialBudget: number;
  availableBudget: number;
  lockedBudget: number;
  updatedAt: number;
  lastBalanceCheck: BudgetBalanceCheck | null;
  lastProfitResetAt: number | null;
  skimmedProfitUsd: number;
}

export interface Btc15mHedgeRuntimeStateUpdate {
  enginePhase: Btc15mHedgeEnginePhase;
  market: Btc15mHedgeMarketView | null;
  cycle: Btc15mHedgeCycleState;
  logs: Btc15mHedgeLogEntry[];
  lastError: string | null;
}

export interface Btc15mHedgePersistentState extends Btc15mHedgeRuntimeStateUpdate {
  version: 1;
  updatedAt: number;
  config: Btc15mHedgeBotConfig;
  completedCycles: Btc15mHedgeCompletedCycle[];
}

export interface Btc15mHedgeStateStoreOptions {
  filePath: string;
  defaultConfig: Btc15mHedgeBotConfig;
}
