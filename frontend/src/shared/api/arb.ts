import { getJson } from "./http";

export interface ArbBin {
  label: string;
  yesTokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  bestBidSize: number | null;
  bestAskSize: number | null;
  executableDepth: number;
  avgExecutionPrice: number | null;
  executionValue: number | null;
  isLimiting: boolean;
}

export interface ArbExecution {
  executable: boolean;
  executableShares: number;
  maxInvestmentUsd: number;
  maxReturnUsd: number;
  maxProfitUsd: number;
  netProfitUsd: number;
  grossProfitPerDollar: number;
  netProfitPerDollar: number;
  investorInputUsd: number;
  investorGrossReturnUsd: number | null;
  investorGrossProfitUsd: number | null;
  investorNetReturnUsd: number | null;
  investorNetProfitUsd: number | null;
  investorNetReturnPerDollar: number | null;
  investorCostBufferUsd: number | null;
  investorExecutable: boolean;
  avgExecutionSum: number | null;
  limitingBin: string | null;
  unfillableBins: string[];
  gasBufferUsd: number;
  slippageBufferBps: number;
  slippageBufferUsd: number;
}

export interface ArbWatchBin {
  label: string;
  yesTokenId: string;
  heldShares: number;
  currentBid: number | null;
  currentBidSize: number | null;
}

export interface ArbWatchPlan {
  mode: "split_hold" | "none";
  watchable: boolean;
  inputUsd: number;
  immediateReturnUsd: number;
  currentExitValueUsd: number;
  bufferUsd: number;
  currentNetUsd: number;
  breakEvenFutureReturnUsd: number;
  targetFutureReturnUsd: number;
  targetProfitUsd: number;
  requiredAvgFutureBid: number | null;
  targetAvgFutureBid: number | null;
  heldShares: number;
  heldBins: ArbWatchBin[];
  reason: string;
}

export interface ArbOpportunity {
  eventSlug: string;
  eventTitle: string;
  negRiskConditionId: string;
  binCount: number;
  binsWithBid: number;
  binsWithAsk: number;
  sumBids: number;
  sumAsks: number;
  topLineProfitPerDollar: number;
  arbType: "split" | "merge";
  profitPerDollar: number;
  isClean: boolean;
  execution: ArbExecution;
  watchPlan: ArbWatchPlan;
  bins: ArbBin[];
  volume: number;
  liquidity: number;
}

export interface ArbScanResult {
  scannedEvents: number;
  opportunities: ArbOpportunity[];
  scannedAt: string;
}

export type ArbScanStreamEvent =
  | { type: "started"; scannedAt: string }
  | {
      type: "batch";
      processedEvents: number;
      totalEvents: number;
      opportunities: ArbOpportunity[];
      scannedAt: string;
      done: false;
    }
  | {
      type: "done";
      processedEvents: number;
      totalEvents: number;
      opportunities: ArbOpportunity[];
      scannedAt: string;
      done: true;
    }
  | { type: "error"; error: string };

export function scanArb(): Promise<ArbScanResult> {
  return getJson<ArbScanResult>("/api/arb/scan");
}
