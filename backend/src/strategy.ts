import { TopOfBook, TradeDecision } from "./models.js";

export function evaluateBinaryOutcome(params: {
  fairProbability: number;
  topOfBook: TopOfBook;
  minEdgeBps: number;
  maxSpreadBps: number;
}): TradeDecision {
  const { fairProbability, topOfBook, minEdgeBps, maxSpreadBps } = params;

  if (topOfBook.bestAsk === null) {
    return { shouldTrade: false, side: "buy", targetPrice: 0, edgeBps: 0, reason: "no ask available" };
  }
  if (topOfBook.bestBid === null) {
    return { shouldTrade: false, side: "buy", targetPrice: 0, edgeBps: 0, reason: "no bid available" };
  }
  if (topOfBook.spreadBps !== null && topOfBook.spreadBps > maxSpreadBps) {
    return {
      shouldTrade: false,
      side: "buy",
      targetPrice: topOfBook.bestAsk,
      edgeBps: 0,
      reason: "spread too wide",
    };
  }

  const edge = fairProbability - topOfBook.bestAsk;
  const edgeBps = edge * 10_000;
  if (edgeBps < minEdgeBps) {
    return {
      shouldTrade: false,
      side: "buy",
      targetPrice: topOfBook.bestAsk,
      edgeBps,
      reason: "edge below threshold",
    };
  }

  return {
    shouldTrade: true,
    side: "buy",
    targetPrice: topOfBook.bestAsk,
    edgeBps,
    reason: "positive edge on best ask",
  };
}
