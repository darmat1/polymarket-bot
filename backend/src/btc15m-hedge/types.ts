import type {
  BudgetBalanceCheck,
  BudgetSnapshot,
} from "../budget-manager.js";

export type Btc15mHedgeEnginePhase = "stopped" | "running" | "auto_stopped";

export type Btc15mHedgeCyclePhase =
  | "waiting_market"
  | "building_pair"
  | "paired_holding"
  | "unwinding"
  | "cycle_done"
  | "market_idle";

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
  workingBudgetUsd: number;
  sharesPerSide: number;
  targetCombinedPrice: number | null;
  entryCutoffMin: number;
  forceUnwindThresholdMin: number;
  tickIntervalSec: number;
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
  targetCombinedPrice: number;
  maxSharesPerSide: number;
  pairedShares: number;
  avgUpPrice: number | null;
  avgDownPrice: number | null;
  combinedAverage: number | null;
  unpairedUnwindPnlUsd: number;
  result: "paired_hold" | "partial_unwind" | "failed_to_pair";
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
  unpairedUpShares: number;
  unpairedDownShares: number;
  pairedAvgUp: number | null;
  pairedAvgDown: number | null;
  combinedAverage: number | null;
  pairAssembledAt: number | null;
  completionLocked: boolean;
}

export interface Btc15mHedgeBotStatus {
  enginePhase: Btc15mHedgeEnginePhase;
  dryRun: boolean;
  config: Btc15mHedgeBotConfig;
  market: Btc15mHedgeMarketView | null;
  marketStartBtcPrice: number | null;
  currentBtcPrice: number | null;
  cycle: Btc15mHedgeCycleState;
  completedCycles: Btc15mHedgeCompletedCycle[];
  budget: BudgetSnapshot | null;
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
  marketStartBtcPrice: number | null;
  currentBtcPrice: number | null;
  cycle: Btc15mHedgeCycleState;
  logs: Btc15mHedgeLogEntry[];
  lastError: string | null;
}

export interface Btc15mHedgePersistentState extends Btc15mHedgeRuntimeStateUpdate {
  version: 1;
  updatedAt: number;
  config: Btc15mHedgeBotConfig;
  completedCycles: Btc15mHedgeCompletedCycle[];
  budget: Btc15mHedgePersistedBudgetState;
}

export interface Btc15mHedgeStateStoreOptions {
  filePath: string;
  defaultConfig: Btc15mHedgeBotConfig;
}
