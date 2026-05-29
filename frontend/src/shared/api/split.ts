import { postJson } from "./http";

export interface SplitBin {
  label: string;
  yesTokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
}

export interface SplitAnalysis {
  eventSlug: string;
  eventTitle: string;
  resolutionDate: string;
  isNegRisk: boolean;
  negRiskConditionId: string | null;
  bins: SplitBin[];
  sumYesMid: number;
  arbOpportunity: "split" | "merge" | "none";
  isWeatherMarket: boolean;
}

export interface SplitResult {
  approveTxHash: string | null;
  splitTxHash: string;
  amountUsdc: number;
  binCount: number;
}

export function analyzeEvent(eventUrl: string) {
  return postJson<SplitAnalysis>("/api/split/analyze", { eventUrl });
}

export function executeSplit(conditionId: string, amountUsdc: number, binCount: number) {
  return postJson<SplitResult>("/api/split/execute", { conditionId, amountUsdc, binCount });
}
