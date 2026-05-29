// backend/src/arb-scanner.ts
import { loadSettings } from "./config.js";
import { ClobPublicClient, type OrderBookLevel } from "./clob.js";

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
  /** "split": split $1 → sell all YES at bid → profit = sumBids - $1 */
  arbType: "split" | "merge" | "none";
  /** net executable profit per dollar when depth allows it; otherwise indicative top-line profit */
  profitPerDollar: number;
  /** true = current book depth supports an executable positive-net arb */
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

export interface ArbScanBatch {
  processedEvents: number;
  totalEvents: number;
  opportunities: ArbOpportunity[];
  scannedAt: string;
  done: boolean;
}

const MIN_PROFIT    = 0.005; // 0.5¢ min to surface
const MIN_LIQUIDITY = 500;   // skip events with < $500 liquidity
const PAGE_SIZE     = 100;
const MAX_PAGES     = 20;    // scan up to 2000 events
const EVENT_BATCH   = 10;    // process N events at a time to avoid CLOB rate-limits
const INVESTOR_INPUT_USD = 1;

interface BookBin {
  label: string;
  yesTokenId: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

async function fetchEventPrices(event: any, clob: ClobPublicClient): Promise<ArbOpportunity | null> {
  const markets: any[] = event.markets ?? [];
  const gasBufferUsd = parseEnvNumber("ARB_GAS_BUFFER_USD", 0.02);
  const slippageBufferBps = parseEnvNumber("ARB_SLIPPAGE_BUFFER_BPS", 10);

  const bookBins: BookBin[] = await Promise.all(
    markets.map(async (m: any) => {
      const rawTokenIds = m.clobTokenIds;
      let tokenIds: string[] = [];
      if (Array.isArray(rawTokenIds)) {
        tokenIds = rawTokenIds;
      } else if (typeof rawTokenIds === "string") {
        try { const p = JSON.parse(rawTokenIds); if (Array.isArray(p)) tokenIds = p; } catch { /* */ }
      }
      const yesTokenId = tokenIds[0] ?? "";
      let bids: OrderBookLevel[] = [];
      let asks: OrderBookLevel[] = [];
      if (yesTokenId) {
        try {
          const depth = await clob.getOrderBookDepth(yesTokenId);
          bids = depth.bids;
          asks = depth.asks;
        } catch { /* no liquidity */ }
      }
      return {
        label: m.groupItemTitle ?? m.outcomes?.[0] ?? m.question ?? "?",
        yesTokenId,
        bids,
        asks,
      };
    })
  );

  const sumBids     = bookBins.reduce((s, b) => s + (b.bids[0]?.price ?? 0), 0);
  const sumAsks     = bookBins.reduce((s, b) => s + (b.asks[0]?.price ?? 0), 0);
  const binsWithBid = bookBins.filter(b => b.bids[0]?.price !== undefined && b.bids[0].price > 0).length;
  const binsWithAsk = bookBins.filter(b => b.asks[0]?.price !== undefined && b.asks[0].price < 1).length;

  const splitProfit = sumBids > 1.0 ? sumBids - 1.0 : 0;
  const allHaveAsk  = binsWithAsk === bookBins.length;
  const mergeProfit = (allHaveAsk && sumAsks < 1.0) ? 1.0 - sumAsks : 0;

  let arbType: "split" | "merge" | "none" = "none";
  let profitPerDollar = 0;
  let isClean = false;

  if (splitProfit > mergeProfit && splitProfit > MIN_PROFIT) {
    arbType = "split";
    profitPerDollar = splitProfit;
    isClean = binsWithBid === bookBins.length;
  } else if (mergeProfit > splitProfit && mergeProfit > MIN_PROFIT) {
    arbType = "merge";
    profitPerDollar = mergeProfit;
    isClean = allHaveAsk;
  }

  if (arbType === "none") return null;
  const execution = arbType === "split"
    ? analyzeSplitExecution(bookBins, gasBufferUsd, slippageBufferBps)
    : analyzeMergeExecution(bookBins, gasBufferUsd, slippageBufferBps);
  const watchPlan = arbType === "split"
    ? analyzeSplitWatchPlan(bookBins, gasBufferUsd, slippageBufferBps)
    : noWatchPlan("Watch mode is only defined for split/hold candidates.");
  const topLineProfitPerDollar = arbType === "split" ? splitProfit : mergeProfit;
  profitPerDollar = execution.netProfitPerDollar > 0
    ? execution.netProfitPerDollar
    : topLineProfitPerDollar;
  isClean = execution.executable && execution.netProfitUsd > 0;
  const limitingLabel = execution.limitingBin;
  const bins: ArbBin[] = bookBins.map((bin) => {
    const sideLevels = arbType === "split" ? bin.bids : bin.asks;
    const executableDepth = cumulativeSize(sideLevels);
    const avgExecutionPrice = execution.executable && execution.maxInvestmentUsd > 0
      ? weightedAverageForSide(arbType, sideLevels, execution.executableShares)
      : null;
    const executionValue = avgExecutionPrice !== null
      ? avgExecutionPrice * execution.executableShares
      : null;

    return {
      label: bin.label,
      yesTokenId: bin.yesTokenId,
      bestBid: bin.bids[0]?.price ?? null,
      bestAsk: bin.asks[0]?.price ?? null,
      bestBidSize: bin.bids[0]?.size ?? null,
      bestAskSize: bin.asks[0]?.size ?? null,
      executableDepth: roundShares(executableDepth),
      avgExecutionPrice,
      executionValue: executionValue === null ? null : roundUsd(executionValue),
      isLimiting: limitingLabel === bin.label,
    };
  });

  return {
    eventSlug: event.slug,
    eventTitle: event.title ?? event.slug,
    negRiskConditionId: event.negRiskMarketID,
    binCount: markets.length,
    binsWithBid,
    binsWithAsk,
    sumBids,
    sumAsks,
    topLineProfitPerDollar,
    arbType,
    profitPerDollar,
    isClean,
    execution,
    watchPlan,
    bins,
    volume: parseFloat(event.volume ?? "0"),
    liquidity: parseFloat(event.liquidity ?? "0"),
  };
}

function analyzeSplitExecution(
  bins: BookBin[],
  gasBufferUsd: number,
  slippageBufferBps: number,
): ArbExecution {
  const depths = bins.map((bin) => ({ label: bin.label, depth: cumulativeSize(bin.bids) }));
  const unfillableBins = depths.filter((bin) => bin.depth <= 0).map((bin) => bin.label);
  const limiting = findLimitingDepth(depths);
  const depthLimit = unfillableBins.length === 0 ? limiting.depth : 0;
  const executable = depthLimit > 0;
  const best = executable
    ? findBestSplitExecution(bins, depthLimit, gasBufferUsd, slippageBufferBps)
    : null;
  const executableShares = best?.shares ?? 0;

  const maxInvestmentUsd = best?.investmentUsd ?? 0;
  const slippageBufferUsd = best?.slippageBufferUsd ?? 0;
  const maxReturnUsd = best?.returnUsd ?? 0;
  const maxProfitUsd = best?.grossProfitUsd ?? 0;
  const netProfitUsd = best?.netProfitUsd ?? 0;

  const investorGrossReturnUsd = depthLimit >= INVESTOR_INPUT_USD
    ? sumRequired(bins.map((bin) => sellValue(bin.bids, INVESTOR_INPUT_USD)))
    : null;
  const investorGrossProfitUsd = investorGrossReturnUsd === null ? null : investorGrossReturnUsd - INVESTOR_INPUT_USD;

  return buildExecution({
    executable,
    executableShares,
    maxInvestmentUsd,
    maxReturnUsd,
    maxProfitUsd,
    netProfitUsd,
    investorGrossReturnUsd,
    investorGrossProfitUsd,
    avgExecutionSum: executableShares > 0 ? maxReturnUsd / executableShares : null,
    limitingBin: executable ? limiting.label : null,
    unfillableBins,
    gasBufferUsd,
    slippageBufferBps,
    slippageBufferUsd,
  });
}

function analyzeMergeExecution(
  bins: BookBin[],
  gasBufferUsd: number,
  slippageBufferBps: number,
): ArbExecution {
  const depths = bins.map((bin) => ({ label: bin.label, depth: cumulativeSize(bin.asks) }));
  const unfillableBins = depths.filter((bin) => bin.depth <= 0).map((bin) => bin.label);
  const limiting = findLimitingDepth(depths);
  const depthLimit = unfillableBins.length === 0 ? limiting.depth : 0;
  const executable = depthLimit > 0;
  const best = executable
    ? findBestMergeExecution(bins, depthLimit, gasBufferUsd, slippageBufferBps)
    : null;
  const executableShares = best?.shares ?? 0;
  const maxInvestmentUsd = best?.investmentUsd ?? 0;
  const maxReturnUsd = best?.returnUsd ?? 0;
  const slippageBufferUsd = best?.slippageBufferUsd ?? 0;
  const maxProfitUsd = best?.grossProfitUsd ?? 0;
  const netProfitUsd = best?.netProfitUsd ?? 0;

  const investorShares = executable
    ? findSharesForBudget(bins, INVESTOR_INPUT_USD)
    : null;
  const investorGrossReturnUsd = investorShares === null ? null : investorShares;
  const investorGrossProfitUsd = investorGrossReturnUsd === null ? null : investorGrossReturnUsd - INVESTOR_INPUT_USD;

  return buildExecution({
    executable,
    executableShares,
    maxInvestmentUsd,
    maxReturnUsd,
    maxProfitUsd,
    netProfitUsd,
    investorGrossReturnUsd,
    investorGrossProfitUsd,
    avgExecutionSum: executableShares > 0 ? maxInvestmentUsd / executableShares : null,
    limitingBin: executable ? limiting.label : null,
    unfillableBins,
    gasBufferUsd,
    slippageBufferBps,
    slippageBufferUsd,
  });
}

function analyzeSplitWatchPlan(
  bins: BookBin[],
  gasBufferUsd: number,
  slippageBufferBps: number,
): ArbWatchPlan {
  const targetProfitUsd = parseEnvNumber("ARB_WATCH_TARGET_PROFIT_USD", 0.01);
  const bufferUsd = gasBufferUsd + INVESTOR_INPUT_USD * (slippageBufferBps / 10_000);
  let immediateReturnUsd = 0;
  let currentExitValueUsd = 0;
  const heldBins: ArbWatchBin[] = [];

  for (const bin of bins) {
    const immediateValue = sellValue(bin.bids, INVESTOR_INPUT_USD);
    if (immediateValue !== null) {
      immediateReturnUsd += immediateValue;
      continue;
    }

    const availableBidShares = Math.min(INVESTOR_INPUT_USD, cumulativeSize(bin.bids));
    const partialValue = availableBidShares > 0 ? sellValue(bin.bids, availableBidShares) ?? 0 : 0;
    immediateReturnUsd += partialValue;
    currentExitValueUsd += partialValue;
    const heldShares = INVESTOR_INPUT_USD - availableBidShares;
    if (heldShares > 1e-6) {
      heldBins.push({
        label: bin.label,
        yesTokenId: bin.yesTokenId,
        heldShares: roundShares(heldShares),
        currentBid: bin.bids[0]?.price ?? null,
        currentBidSize: bin.bids[0]?.size ?? null,
      });
    }
  }

  const heldShares = heldBins.reduce((sum, bin) => sum + bin.heldShares, 0);
  if (heldShares <= 0) {
    return noWatchPlan("No residual shares to monitor after immediate sale.");
  }

  const breakEvenFutureReturnUsd = Math.max(0, INVESTOR_INPUT_USD + bufferUsd - immediateReturnUsd);
  const targetFutureReturnUsd = Math.max(0, INVESTOR_INPUT_USD + bufferUsd + targetProfitUsd - immediateReturnUsd);
  const currentNetUsd = immediateReturnUsd - INVESTOR_INPUT_USD - bufferUsd;
  const requiredAvgFutureBid = breakEvenFutureReturnUsd / heldShares;
  const targetAvgFutureBid = targetFutureReturnUsd / heldShares;
  const watchable = targetAvgFutureBid <= 1;

  return {
    mode: "split_hold",
    watchable,
    inputUsd: INVESTOR_INPUT_USD,
    immediateReturnUsd: roundUsd(immediateReturnUsd),
    currentExitValueUsd: roundUsd(currentExitValueUsd),
    bufferUsd: roundUsd(bufferUsd),
    currentNetUsd: roundUsd(currentNetUsd),
    breakEvenFutureReturnUsd: roundUsd(breakEvenFutureReturnUsd),
    targetFutureReturnUsd: roundUsd(targetFutureReturnUsd),
    targetProfitUsd: roundUsd(targetProfitUsd),
    requiredAvgFutureBid: roundRate(requiredAvgFutureBid),
    targetAvgFutureBid: roundRate(targetAvgFutureBid),
    heldShares: roundShares(heldShares),
    heldBins,
    reason: watchable
      ? "Sell liquid bins now, monitor held bins for a profitable exit."
      : "Required future bid is above 100%, so this is not a realistic hold candidate.",
  };
}

function noWatchPlan(reason: string): ArbWatchPlan {
  return {
    mode: "none",
    watchable: false,
    inputUsd: INVESTOR_INPUT_USD,
    immediateReturnUsd: 0,
    currentExitValueUsd: 0,
    bufferUsd: 0,
    currentNetUsd: 0,
    breakEvenFutureReturnUsd: 0,
    targetFutureReturnUsd: 0,
    targetProfitUsd: 0,
    requiredAvgFutureBid: null,
    targetAvgFutureBid: null,
    heldShares: 0,
    heldBins: [],
    reason,
  };
}

function buildExecution(args: {
  executable: boolean;
  executableShares: number;
  maxInvestmentUsd: number;
  maxReturnUsd: number;
  maxProfitUsd: number;
  netProfitUsd: number;
  investorGrossReturnUsd: number | null;
  investorGrossProfitUsd: number | null;
  avgExecutionSum: number | null;
  limitingBin: string | null;
  unfillableBins: string[];
  gasBufferUsd: number;
  slippageBufferBps: number;
  slippageBufferUsd: number;
}): ArbExecution {
  const investorCostBufferUsd = args.investorGrossReturnUsd === null
    ? null
    : args.gasBufferUsd + INVESTOR_INPUT_USD * (args.slippageBufferBps / 10_000);
  const investorNetReturnUsd = args.investorGrossReturnUsd === null || investorCostBufferUsd === null
    ? null
    : args.investorGrossReturnUsd - investorCostBufferUsd;
  const investorNetProfitUsd = investorNetReturnUsd === null
    ? null
    : investorNetReturnUsd - INVESTOR_INPUT_USD;

  return {
    executable: args.executable,
    executableShares: roundShares(args.executableShares),
    maxInvestmentUsd: roundUsd(args.maxInvestmentUsd),
    maxReturnUsd: roundUsd(args.maxReturnUsd),
    maxProfitUsd: roundUsd(args.maxProfitUsd),
    netProfitUsd: roundUsd(args.netProfitUsd),
    grossProfitPerDollar: args.maxInvestmentUsd > 0 ? roundRate(args.maxProfitUsd / args.maxInvestmentUsd) : 0,
    netProfitPerDollar: args.maxInvestmentUsd > 0 ? roundRate(args.netProfitUsd / args.maxInvestmentUsd) : 0,
    investorInputUsd: INVESTOR_INPUT_USD,
    investorGrossReturnUsd: args.investorGrossReturnUsd === null ? null : roundUsd(args.investorGrossReturnUsd),
    investorGrossProfitUsd: args.investorGrossProfitUsd === null ? null : roundUsd(args.investorGrossProfitUsd),
    investorNetReturnUsd: investorNetReturnUsd === null ? null : roundUsd(investorNetReturnUsd),
    investorNetProfitUsd: investorNetProfitUsd === null ? null : roundUsd(investorNetProfitUsd),
    investorNetReturnPerDollar: investorNetReturnUsd === null ? null : roundRate(investorNetReturnUsd / INVESTOR_INPUT_USD),
    investorCostBufferUsd: investorCostBufferUsd === null ? null : roundUsd(investorCostBufferUsd),
    investorExecutable: args.investorGrossReturnUsd !== null,
    avgExecutionSum: args.avgExecutionSum === null ? null : roundRate(args.avgExecutionSum),
    limitingBin: args.limitingBin,
    unfillableBins: args.unfillableBins,
    gasBufferUsd: roundUsd(args.gasBufferUsd),
    slippageBufferBps: args.slippageBufferBps,
    slippageBufferUsd: roundUsd(args.slippageBufferUsd),
  };
}

function cumulativeSize(levels: OrderBookLevel[]): number {
  return levels.reduce((sum, level) => sum + level.size, 0);
}

function findLimitingDepth(depths: Array<{ label: string; depth: number }>): { label: string | null; depth: number } {
  if (depths.length === 0) {
    return { label: null, depth: 0 };
  }
  return depths.reduce<{ label: string | null; depth: number }>(
    (min, bin) => bin.depth < min.depth ? bin : min,
    { label: depths[0].label, depth: depths[0].depth },
  );
}

function sellValue(levels: OrderBookLevel[], shares: number): number | null {
  return walkLevels(levels, shares);
}

function buyCost(levels: OrderBookLevel[], shares: number): number | null {
  return walkLevels(levels, shares);
}

function walkLevels(levels: OrderBookLevel[], shares: number): number | null {
  let remaining = shares;
  let total = 0;
  for (const level of levels) {
    if (remaining <= 1e-9) break;
    const fill = Math.min(remaining, level.size);
    total += fill * level.price;
    remaining -= fill;
  }
  return remaining <= 1e-6 ? total : null;
}

function findBestSplitExecution(
  bins: BookBin[],
  depthLimit: number,
  gasBufferUsd: number,
  slippageBufferBps: number,
): {
  shares: number;
  investmentUsd: number;
  returnUsd: number;
  grossProfitUsd: number;
  netProfitUsd: number;
  slippageBufferUsd: number;
} | null {
  return bestCandidate(candidateShares(bins.map((bin) => bin.bids), depthLimit), (shares) => {
    const returnUsd = sumRequired(bins.map((bin) => sellValue(bin.bids, shares)));
    if (returnUsd === null) return null;
    const investmentUsd = shares;
    const grossProfitUsd = returnUsd - investmentUsd;
    const slippageBufferUsd = returnUsd * (slippageBufferBps / 10_000);
    return {
      shares,
      investmentUsd,
      returnUsd,
      grossProfitUsd,
      netProfitUsd: grossProfitUsd - slippageBufferUsd - gasBufferUsd,
      slippageBufferUsd,
    };
  });
}

function findBestMergeExecution(
  bins: BookBin[],
  depthLimit: number,
  gasBufferUsd: number,
  slippageBufferBps: number,
): {
  shares: number;
  investmentUsd: number;
  returnUsd: number;
  grossProfitUsd: number;
  netProfitUsd: number;
  slippageBufferUsd: number;
} | null {
  return bestCandidate(candidateShares(bins.map((bin) => bin.asks), depthLimit), (shares) => {
    const investmentUsd = sumRequired(bins.map((bin) => buyCost(bin.asks, shares)));
    if (investmentUsd === null) return null;
    const returnUsd = shares;
    const grossProfitUsd = returnUsd - investmentUsd;
    const slippageBufferUsd = investmentUsd * (slippageBufferBps / 10_000);
    return {
      shares,
      investmentUsd,
      returnUsd,
      grossProfitUsd,
      netProfitUsd: grossProfitUsd - slippageBufferUsd - gasBufferUsd,
      slippageBufferUsd,
    };
  });
}

function candidateShares(levelSets: OrderBookLevel[][], depthLimit: number): number[] {
  const values = new Set<number>();
  if (depthLimit >= INVESTOR_INPUT_USD) {
    values.add(INVESTOR_INPUT_USD);
  }
  values.add(depthLimit);

  for (const levels of levelSets) {
    let cumulative = 0;
    for (const level of levels) {
      cumulative += level.size;
      if (cumulative > 0 && cumulative <= depthLimit) {
        values.add(cumulative);
      }
    }
  }

  return [...values].filter((value) => value > 0 && value <= depthLimit).sort((a, b) => a - b);
}

function bestCandidate<T extends { netProfitUsd: number; shares: number }>(
  shares: number[],
  evaluate: (shares: number) => T | null,
): T | null {
  let best: T | null = null;
  for (const shareSize of shares) {
    const candidate = evaluate(shareSize);
    if (!candidate) continue;
    if (
      best === null ||
      candidate.netProfitUsd > best.netProfitUsd ||
      (candidate.netProfitUsd === best.netProfitUsd && candidate.shares < best.shares)
    ) {
      best = candidate;
    }
  }
  return best;
}

function sumRequired(values: Array<number | null>): number | null {
  let sum = 0;
  for (const value of values) {
    if (value === null) {
      return null;
    }
    sum += value;
  }
  return sum;
}

function weightedAverageForSide(
  arbType: "split" | "merge",
  levels: OrderBookLevel[],
  shares: number,
): number | null {
  const value = arbType === "split" ? sellValue(levels, shares) : buyCost(levels, shares);
  return value === null || shares <= 0 ? null : roundRate(value / shares);
}

function findSharesForBudget(bins: BookBin[], budgetUsd: number): number | null {
  const maxShares = Math.min(...bins.map((bin) => cumulativeSize(bin.asks)));
  if (!Number.isFinite(maxShares) || maxShares <= 0) {
    return null;
  }

  const maxCost = sumRequired(bins.map((bin) => buyCost(bin.asks, maxShares)));
  if (maxCost === null || maxCost < budgetUsd) {
    return null;
  }

  let lo = 0;
  let hi = maxShares;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    const cost = sumRequired(bins.map((bin) => buyCost(bin.asks, mid)));
    if (cost !== null && cost <= budgetUsd) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return roundShares(lo);
}

function parseEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function roundShares(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function roundRate(value: number): number {
  return Math.round(value * 100_000) / 100_000;
}

export async function scanArbOpportunities(): Promise<ArbScanResult> {
  const opportunities: ArbOpportunity[] = [];
  let scannedEvents = 0;

  for await (const batch of scanArbOpportunityBatches()) {
    scannedEvents = batch.totalEvents;
    opportunities.push(...batch.opportunities);
  }

  opportunities.sort((a, b) => b.profitPerDollar - a.profitPerDollar);

  return {
    scannedEvents,
    opportunities,
    scannedAt: new Date().toISOString(),
  };
}

export async function* scanArbOpportunityBatches(): AsyncGenerator<ArbScanBatch> {
  const settings = loadSettings();
  const gammaHost = settings.gammaHost;
  const clobHost  = settings.polymarketHost;
  const clob = new ClobPublicClient(clobHost);

  // 1. Paginate Gamma API sorted by liquidity DESC
  const negRiskEvents: any[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL("/events", gammaHost);
    url.searchParams.set("limit", String(PAGE_SIZE));
    url.searchParams.set("closed", "false");
    url.searchParams.set("order", "liquidity");
    url.searchParams.set("ascending", "false");
    url.searchParams.set("offset", String(page * PAGE_SIZE));

    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Gamma API error: ${res.status}`);
    const batch = (await res.json()) as any[];
    if (batch.length === 0) break;

    const batchNeg = batch.filter(
      e => e.negRisk === true && Array.isArray(e.markets) && e.markets.length > 1 && e.negRiskMarketID
    );
    negRiskEvents.push(...batchNeg);

    // Stop once we reach illiquid territory
    const minLiq = Math.min(...batch.map(e => parseFloat(e.liquidity ?? "0")));
    if (minLiq < MIN_LIQUIDITY) break;
  }

  // 2. Fetch CLOB prices in small batches to avoid rate-limiting
  let processedEvents = 0;

  for (let i = 0; i < negRiskEvents.length; i += EVENT_BATCH) {
    const chunk = negRiskEvents.slice(i, i + EVENT_BATCH);
    const chunkResults = await Promise.allSettled(
      chunk.map(event => fetchEventPrices(event, clob))
    );

    processedEvents += chunk.length;

    const opportunities = chunkResults
      .filter((r): r is PromiseFulfilledResult<ArbOpportunity> =>
        r.status === "fulfilled" && r.value !== null
      )
      .map(r => r.value);

    yield {
      processedEvents,
      totalEvents: negRiskEvents.length,
      opportunities,
      scannedAt: new Date().toISOString(),
      done: false,
    };
  }

  yield {
    processedEvents,
    totalEvents: negRiskEvents.length,
    opportunities: [],
    scannedAt: new Date().toISOString(),
    done: true,
  };
}
