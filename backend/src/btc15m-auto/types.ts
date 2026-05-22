import type {
  BudgetBalanceCheck,
  BudgetSnapshot,
} from "../budget-manager.js";

export type Btc15mAutoEnginePhase = "stopped" | "running" | "auto_stopped";

export type Btc15mAutoCyclePhase =
  | "waiting_market"
  | "waiting_direction"
  | "buy_pending"
  | "holding"
  | "force_selling"
  | "cycle_done"
  | "market_idle";

export type Btc15mAutoSide = "up" | "down";

export interface Btc15mAutoMarketView {
  slug: string;
  question: string;
  startTimeMs: number;
  endTimeMs: number;
  upTokenId: string;
  downTokenId: string;
}

export interface Btc15mAutoTrackedOrder {
  id: string;
  orderId: string | null;
  side: "buy" | "sell";
  tokenId: string;
  bettingSide: Btc15mAutoSide;
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

export interface Btc15mAutoPosition {
  bettingSide: Btc15mAutoSide;
  tokenId: string;
  shares: number;
  avgEntryPrice: number;
  costBasisUsd: number;
}

export interface Btc15mAutoCompletedTrade {
  id: string;
  marketSlug: string;
  bettingSide: Btc15mAutoSide;
  buyPrice: number;
  sellPrice: number;
  shares: number;
  pnlUsd: number;
  result: "win" | "loss";
  exitReason: "target_sell" | "force_sell" | "resolved_unfilled";
  startedAt: number;
  closedAt: number;
  /** True if this trade was simulated (DRY_RUN). SIM trades are NOT persisted and live only for the session. */
  dryRun?: boolean;
}

export interface Btc15mAutoAnalyticsSummary {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnlUsd: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  sessionStartBudgetUsd: number;
  remainingBudgetUsd: number;
}

export interface Btc15mAutoBotConfig {
  workingBudgetUsd: number;
  shares: number;
  buyPrice: number;
  trailStep: number;            // min bestBid rise above highWaterMark to trigger sell update (default 0.05)
  trailDist: number;            // limit sell placed at highWaterMark - trailDist (default 0.02)
  trailUpdateIntervalSec: number; // LIVE mode throttle in seconds (default 3)
  repeatThresholdMin: number;
  forceSellThresholdMin: number;
  neutralZoneUsd: number;
  tickIntervalSec: number;
}

export interface Btc15mAutoLogEntry {
  timestamp: number;
  message: string;
  type: "info" | "warn" | "error" | "success";
}

export interface Btc15mAutoCycleState {
  cyclePhase: Btc15mAutoCyclePhase;
  cycleStartedAt: number | null;
  buyOrder: Btc15mAutoTrackedOrder | null;
  sellOrder: Btc15mAutoTrackedOrder | null;
  position: Btc15mAutoPosition | null;
  highWaterMark: number | null;
  trailStopPrice: number | null;
}

export interface Btc15mAutoBotStatus {
  enginePhase: Btc15mAutoEnginePhase;
  dryRun: boolean;
  config: Btc15mAutoBotConfig;
  market: Btc15mAutoMarketView | null;
  marketStartBtcPrice: number | null;
  currentBtcPrice: number | null;
  upPrice: number | null;
  downPrice: number | null;
  cycle: Btc15mAutoCycleState;
  /** LIVE trades — persisted across restarts. */
  completedTrades: Btc15mAutoCompletedTrade[];
  analytics: Btc15mAutoAnalyticsSummary;
  /** SIM trades — in-memory only, cleared on bot restart. Populated when dryRun=true. */
  sessionTrades: Btc15mAutoCompletedTrade[];
  sessionAnalytics: Btc15mAutoAnalyticsSummary;
  budget: BudgetSnapshot | null;
  logs: Btc15mAutoLogEntry[];
  updatedAt: number;
  lastError: string | null;
}

export interface Btc15mAutoPersistedBudgetState {
  initialBudget: number;
  availableBudget: number;
  lockedBudget: number;
  updatedAt: number;
  lastBalanceCheck: BudgetBalanceCheck | null;
}

export interface Btc15mAutoRuntimeStateUpdate {
  enginePhase: Btc15mAutoEnginePhase;
  market: Btc15mAutoMarketView | null;
  marketStartBtcPrice: number | null;
  currentBtcPrice: number | null;
  cycle: Btc15mAutoCycleState;
  logs: Btc15mAutoLogEntry[];
  lastError: string | null;
}

export interface Btc15mAutoPersistentState extends Btc15mAutoRuntimeStateUpdate {
  version: 1;
  updatedAt: number;
  config: Btc15mAutoBotConfig;
  completedTrades: Btc15mAutoCompletedTrade[];
  budget: Btc15mAutoPersistedBudgetState;
}

export interface Btc15mAutoStateStoreOptions {
  filePath: string;
  defaultConfig: Btc15mAutoBotConfig;
}
