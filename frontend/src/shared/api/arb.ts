import { getJson, postJson } from "./http";

export interface ArbBin {
  label: string;
  yesTokenId: string;
  noTokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  bestBidSize: number | null;
  bestAskSize: number | null;
  bestNoBid: number | null;
  bestNoAsk: number | null;
  bestNoBidSize: number | null;
  bestNoAskSize: number | null;
  executableDepth: number;
  avgExecutionPrice: number | null;
  executionValue: number | null;
  isLimiting: boolean;
  isConvertInput: boolean;
  isConvertOutput: boolean;
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

export interface ArbWatchPosition {
  id: string;
  eventSlug: string;
  eventTitle: string;
  polymarketUrl: string;
  status: "watching" | "breakeven_hit" | "target_hit" | "stopped";
  createdAt: string;
  updatedAt: string;
  inputUsd: number;
  immediateReturnUsd: number;
  bufferUsd: number;
  targetProfitUsd: number;
  breakEvenFutureReturnUsd: number;
  targetFutureReturnUsd: number;
  requiredAvgFutureBid: number | null;
  targetAvgFutureBid: number | null;
  heldShares: number;
  currentHeldValueUsd: number;
  currentExitValueUsd: number;
  currentNetUsd: number;
  maxNetUsd: number;
  minNetUsd: number;
  maxNetAt: string;
  minNetAt: string;
  lastEvent: string;
  bins: Array<{
    label: string;
    yesTokenId: string;
    heldShares: number;
    currentBid: number | null;
    currentAsk: number | null;
    lastUpdateAt: string | null;
  }>;
  logs: Array<{ at: string; message: string; netUsd: number }>;
}

export interface ArbConvertPlan {
  mode: "no_to_yes_complement" | "none";
  selectedBin: string | null;
  selectedIndex: number | null;
  indexSet: string | null;
  indexSetHex: string | null;
  marketId: string | null;
  inputNoTokenId: string | null;
  inputNoAsk: number | null;
  outputYesBidSum: number | null;
  rawProfitPerShare: number | null;
  outputBinCount: number;
  missingOutputBins: string[];
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
  arbType: "split" | "merge" | "convert";
  profitPerDollar: number;
  isClean: boolean;
  execution: ArbExecution;
  watchPlan: ArbWatchPlan;
  convertPlan: ArbConvertPlan;
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

export function listArbWatchPositions(): Promise<{ positions: ArbWatchPosition[] }> {
  return getJson<{ positions: ArbWatchPosition[] }>("/api/arb/watch");
}

export function createArbWatchPosition(opp: ArbOpportunity): Promise<{ position: ArbWatchPosition }> {
  return postJson<{ position: ArbWatchPosition }>("/api/arb/watch", {
    eventSlug: opp.eventSlug,
    eventTitle: opp.eventTitle,
    inputUsd: opp.watchPlan.inputUsd,
    immediateReturnUsd: opp.watchPlan.immediateReturnUsd,
    bufferUsd: opp.watchPlan.bufferUsd,
    targetProfitUsd: opp.watchPlan.targetProfitUsd,
    breakEvenFutureReturnUsd: opp.watchPlan.breakEvenFutureReturnUsd,
    targetFutureReturnUsd: opp.watchPlan.targetFutureReturnUsd,
    requiredAvgFutureBid: opp.watchPlan.requiredAvgFutureBid,
    targetAvgFutureBid: opp.watchPlan.targetAvgFutureBid,
    heldShares: opp.watchPlan.heldShares,
    heldBins: opp.watchPlan.heldBins,
  });
}

export function stopArbWatchPosition(id: string): Promise<{ position: ArbWatchPosition }> {
  return postJson<{ position: ArbWatchPosition }>("/api/arb/watch/stop", { id });
}
