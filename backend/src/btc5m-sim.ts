import { WebSocket, WebSocketServer } from "ws";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getBtc5mMarketSnapshotBySlug, getCurrentBtc5mMarketSnapshot, type Btc5mMarketSnapshotPayload } from "./app.js";
import { logEvent } from "./event-log.js";
import { TopOfBook } from "./models.js";
import { PolymarketMarketWs, type PolymarketMarketWsEvent } from "./polymarket-market-ws.js";

type SimLogType = "info" | "warn" | "error" | "success";
type SimSide = "up" | "down";
type StrategyId = "momentum_book_v1";
type ExitReason = "take_profit" | "stop_loss" | "reversal" | "time_stop" | "settlement" | "forced_flatten";
type TimeBucket = "early" | "mid" | "late";
type SpreadBucket = "lt_150" | "150_300" | "300_500" | "gte_500" | "unknown";

type SimLogEntry = {
  timestamp: number;
  message: string;
  type: SimLogType;
};

type EntrySignals = {
  btcMove1mPct: number | null;
  btcMove3mPct: number | null;
  btcMove5mPct: number | null;
  bookMoveBps: number | null;
  spreadBps: number | null;
  timeToExpiryMs: number | null;
  predictionDirection: "up" | "down" | "neutral";
  predictionConfidence: number | null;
  bookMidpoint: number | null;
  liveBestAsk: number | null;
  liveBestBid: number | null;
};

type ExitSnapshot = {
  exitPrice: number;
  grossProceedsUsd: number;
  netProceedsUsd: number;
  netPnlUsd: number;
  btcMove1mPct: number | null;
  btcMove3mPct: number | null;
  btcMove5mPct: number | null;
  bookMoveBps: number | null;
  spreadBps: number | null;
  timeToExpiryMs: number | null;
};

type SimPosition = {
  strategyId: StrategyId;
  side: SimSide;
  marketSlug: string;
  assetId: string | null;
  stakeUsd: number;
  entryFeeUsd: number;
  totalEntryCostUsd: number;
  shares: number;
  entryPrice: number;
  openedAt: number;
  currentPrice: number | null;
  grossExitProceedsUsd: number | null;
  netExitProceedsUsd: number | null;
  grossPnlUsd: number | null;
  unrealizedPnlUsd: number | null;
  toWinUsd: number;
  enteredAtTimeToExpiryMs: number | null;
  spreadBpsAtEntry: number | null;
  spreadBucket: SpreadBucket;
  timeBucket: TimeBucket;
  entrySignals: EntrySignals;
  targetProfitUsd: number;
  maxLossUsd: number;
};

type ClosedSimTrade = {
  strategyId: StrategyId;
  side: SimSide;
  marketSlug: string;
  stakeUsd: number;
  entryFeeUsd: number;
  totalEntryCostUsd: number;
  shares: number;
  entryPrice: number;
  exitPrice: number;
  grossProceedsUsd: number;
  proceedsUsd: number;
  grossPnlUsd: number;
  pnlUsd: number;
  openedAt: number;
  closedAt: number;
  holdTimeMs: number;
  result: "win" | "loss";
  note: string;
  exitReason: ExitReason;
  spreadBpsAtEntry: number | null;
  spreadBpsAtExit: number | null;
  spreadBucket: SpreadBucket;
  timeToExpiryMsAtEntry: number | null;
  timeToExpiryMsAtExit: number | null;
  timeBucket: TimeBucket;
  entrySignals: EntrySignals;
  exitSignals: Omit<ExitSnapshot, "exitPrice" | "grossProceedsUsd" | "netProceedsUsd" | "netPnlUsd">;
};

type StrategyAggregate = {
  trades: number;
  wins: number;
  losses: number;
  grossPnlUsd: number;
  netPnlUsd: number;
  totalHoldTimeMs: number;
};

type SimulationAnalytics = {
  avgHoldTimeMs: number;
  maxDrawdownUsd: number;
  peakEquityUsd: number;
  pnlByStrategy: Record<StrategyId, StrategyAggregate>;
  pnlByDirection: Record<SimSide, StrategyAggregate>;
  pnlBySpreadBucket: Record<SpreadBucket, StrategyAggregate>;
  pnlByTimeBucket: Record<TimeBucket, StrategyAggregate>;
};

export type Btc5mSimulationState = {
  active: boolean;
  bankrollUsd: number;
  availableUsd: number;
  minStakeUsd: number;
  realizedPnlUsd: number;
  grossRealizedPnlUsd: number;
  totalStakedUsd: number;
  wins: number;
  losses: number;
  trades: number;
  winRate: number;
  sessionEquityUsd: number;
  unrealizedPnlUsd: number;
  grossUnrealizedPnlUsd: number;
  lastUpdateAt: number | null;
  lastMarketSlug: string | null;
  strategyId: StrategyId;
  openPosition: SimPosition | null;
  closedTrades: ClosedSimTrade[];
  analytics: SimulationAnalytics;
  logs: SimLogEntry[];
};

type EntryDecision = {
  shouldSkip: boolean;
  reason: string;
  side: SimSide | null;
  strategyId: StrategyId;
  entrySignals: EntrySignals | null;
};

const MIN_STAKE_USD = 1;
const ENTRY_STAKE_USD = 1;
const MIN_ENTRY_PRICE = 0.5;
const MAX_ENTRY_PRICE = 0.8;
const MAX_ENTRY_SPREAD_BPS = 300;
const TAKE_PROFIT_USD = 0.04;
const STOP_LOSS_USD = 0.06;
const MOMENTUM_REVERSAL_PCT = 0.03;
const MOMENTUM_ENTRY_PCT = 0.04;
const BOOK_CONFIRMATION_BPS = 12;
const MAX_HOLD_MS = 75_000;
const FINAL_ENTRY_CUTOFF_MS = 90_000;
const FINAL_FLATTEN_CUTOFF_MS = 20_000;
const ENTRY_FEE_RATE = 0.02;
const EXIT_FEE_RATE = 0.02;
const MAX_LOGS = 120;
const MAX_CLOSED_TRADES = 200;
const SIM_STEP_INTERVAL_MS = 15_000;
const SIM_STATE_FILE = resolve(process.cwd(), "data", "btc5m-sim-state.json");

const lastObservedQuotes = new Map<string, { up: number | null; down: number | null }>();
const marketOutcomeAssetIds = new Map<string, { up: string | null; down: string | null }>();
const liveBooks = new Map<string, TopOfBook>();

let wss: WebSocketServer | null = null;
const marketWs = new PolymarketMarketWs(handleMarketWsEvent);
let state: Btc5mSimulationState = createInitialState(0);

let loopPromise: Promise<void> | null = null;
let restorePromise: Promise<void> | null = null;
let persistPromise: Promise<void> | null = null;

export function initBtc5mSim(serverWss: WebSocketServer) {
  wss = serverWss;
  void restoreBtc5mSimulationState();
}

export function getBtc5mSimulationState(): Btc5mSimulationState {
  return {
    ...state,
    logs: [...state.logs],
    closedTrades: state.closedTrades.map((trade) => ({
      ...trade,
      entrySignals: { ...trade.entrySignals },
      exitSignals: { ...trade.exitSignals },
    })),
    analytics: cloneAnalytics(state.analytics),
    openPosition: state.openPosition
      ? {
          ...state.openPosition,
          entrySignals: { ...state.openPosition.entrySignals },
        }
      : null,
  };
}

export function activateBtc5mSimulation(bankrollUsd: number) {
  const normalized = Math.max(MIN_STAKE_USD, roundUsd(bankrollUsd));
  lastObservedQuotes.clear();
  marketOutcomeAssetIds.clear();
  liveBooks.clear();
  state = createInitialState(normalized);
  state.active = true;
  state.availableUsd = normalized;
  state.sessionEquityUsd = normalized;
  state.analytics.peakEquityUsd = normalized;
  state.lastUpdateAt = Date.now();

  addLog(`BTC sim activated with virtual bankroll $${normalized.toFixed(2)} using strategy ${state.strategyId}.`, "success");
  void persistState();
  ensureLoop();
}

export function deactivateBtc5mSimulation() {
  if (!state.active) {
    return;
  }

  state.active = false;
  state.lastUpdateAt = Date.now();
  addLog("BTC sim deactivated.", "info");
  syncMarketSubscription();
  void persistState();
}

export async function flushBtc5mSimulationState() {
  await persistState();
}

async function ensureLoop() {
  if (restorePromise) {
    await restorePromise;
  }

  if (loopPromise) {
    return loopPromise;
  }

  loopPromise = (async () => {
    while (state.active) {
      try {
        await stepSimulation();
      } catch (error) {
        addLog(`Simulation step failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }

      if (!state.active) {
        break;
      }

      await delay(SIM_STEP_INTERVAL_MS);
    }

    loopPromise = null;
  })();

  return loopPromise;
}

async function stepSimulation() {
  state.lastUpdateAt = Date.now();

  if (state.openPosition) {
    await maybeCloseOpenPosition();
  }

  recalculateSessionMetrics();

  if (!state.active || state.openPosition) {
    broadcastState();
    return;
  }

  if (state.availableUsd < MIN_STAKE_USD) {
    addLog("Virtual bankroll is below $1.00. Simulation stops taking new entries.", "warn");
    state.active = false;
    broadcastState();
    void persistState();
    return;
  }

  const snapshot = await getCurrentBtc5mMarketSnapshot();
  state.lastMarketSlug = snapshot.market.slug;
  rememberMarketAssets(snapshot);
  syncMarketSubscription();

  const decision = evaluateEntry(snapshot);
  rememberQuotes(snapshot);
  if (!decision.side || !decision.entrySignals) {
    addLog(`No entry for ${snapshot.market.slug}: ${decision.reason}`, decision.shouldSkip ? "warn" : "info");
    broadcastState();
    return;
  }

  const assetId = getSnapshotAssetId(snapshot, decision.side);
  const price = getLiveEntryPrice(snapshot, decision.side);
  if (price === null || price <= 0 || price >= 1) {
    addLog(`Skip ${decision.side.toUpperCase()} entry for ${snapshot.market.slug}: quote unavailable.`, "warn");
    broadcastState();
    return;
  }

  const stakeUsd = roundUsd(Math.min(state.availableUsd, ENTRY_STAKE_USD));
  if (stakeUsd < MIN_STAKE_USD) {
    addLog("Available virtual bankroll is below the minimum $1.00 stake.", "warn");
    state.active = false;
    broadcastState();
    void persistState();
    return;
  }

  const entryFeeUsd = roundUsd(stakeUsd * ENTRY_FEE_RATE);
  const totalEntryCostUsd = roundUsd(stakeUsd + entryFeeUsd);
  if (totalEntryCostUsd > state.availableUsd) {
    addLog(`Skip ${decision.side.toUpperCase()} entry for ${snapshot.market.slug}: insufficient balance for modeled fees.`, "warn");
    broadcastState();
    return;
  }

  const shares = roundShares(stakeUsd / price);
  state.availableUsd = roundUsd(state.availableUsd - totalEntryCostUsd);
  state.totalStakedUsd = roundUsd(state.totalStakedUsd + totalEntryCostUsd);
  state.trades += 1;
  state.openPosition = {
    strategyId: decision.strategyId,
    side: decision.side,
    marketSlug: snapshot.market.slug,
    assetId,
    stakeUsd,
    entryFeeUsd,
    totalEntryCostUsd,
    shares,
    entryPrice: price,
    openedAt: Date.now(),
    currentPrice: price,
    grossExitProceedsUsd: stakeUsd,
    netExitProceedsUsd: roundUsd(stakeUsd * (1 - EXIT_FEE_RATE)),
    grossPnlUsd: 0,
    unrealizedPnlUsd: roundUsd(stakeUsd * (1 - EXIT_FEE_RATE) - totalEntryCostUsd),
    toWinUsd: roundUsd(shares),
    enteredAtTimeToExpiryMs: decision.entrySignals.timeToExpiryMs,
    spreadBpsAtEntry: decision.entrySignals.spreadBps,
    spreadBucket: getSpreadBucket(decision.entrySignals.spreadBps),
    timeBucket: getTimeBucket(decision.entrySignals.timeToExpiryMs),
    entrySignals: decision.entrySignals,
    targetProfitUsd: TAKE_PROFIT_USD,
    maxLossUsd: STOP_LOSS_USD,
  };

  const message = [
    `SIM BUY ${decision.side.toUpperCase()} ${shares.toFixed(4)} sh @ ${(price * 100).toFixed(1)}c`,
    `stake $${stakeUsd.toFixed(2)} + fee $${entryFeeUsd.toFixed(2)}`,
    `btc1m ${formatPct(decision.entrySignals.btcMove1mPct)}`,
    `book ${formatBps(decision.entrySignals.bookMoveBps)}`,
    `spread ${formatBps(decision.entrySignals.spreadBps)}`,
    `tte ${formatDuration(decision.entrySignals.timeToExpiryMs)}`,
    `on ${snapshot.market.slug}`,
  ].join(" | ");
  addLog(message, "success");
  logEvent(snapshot.market.slug, message, "success", "auto");
  broadcastState();
  syncMarketSubscription();
  void persistState();
}

async function maybeCloseOpenPosition() {
  const position = state.openPosition;
  if (!position) {
    return;
  }

  const snapshot = await getBtc5mMarketSnapshotBySlug(position.marketSlug);
  state.lastMarketSlug = snapshot.market.slug;
  rememberMarketAssets(snapshot);
  syncMarketSubscription();
  const exitSnapshot = getExitSnapshot(position, snapshot);
  rememberQuotes(snapshot);

  if (exitSnapshot) {
    position.currentPrice = exitSnapshot.exitPrice;
    position.grossExitProceedsUsd = exitSnapshot.grossProceedsUsd;
    position.netExitProceedsUsd = exitSnapshot.netProceedsUsd;
    position.grossPnlUsd = roundUsd(exitSnapshot.grossProceedsUsd - position.stakeUsd);
    position.unrealizedPnlUsd = exitSnapshot.netPnlUsd;
  }

  if (snapshot.market.status === "recent") {
    const won = didPositionWin(position.side, snapshot);
    const settlementPrice = won ? 1 : 0;
    const grossProceedsUsd = roundUsd(position.shares * settlementPrice);
    const netProceedsUsd = roundUsd(grossProceedsUsd * (1 - EXIT_FEE_RATE));
    settlePosition(
      position,
      {
        exitPrice: settlementPrice,
        grossProceedsUsd,
        netProceedsUsd,
        netPnlUsd: roundUsd(netProceedsUsd - position.totalEntryCostUsd),
        btcMove1mPct: exitSnapshot?.btcMove1mPct ?? null,
        btcMove3mPct: exitSnapshot?.btcMove3mPct ?? null,
        btcMove5mPct: exitSnapshot?.btcMove5mPct ?? null,
        bookMoveBps: exitSnapshot?.bookMoveBps ?? null,
        spreadBps: exitSnapshot?.spreadBps ?? null,
        timeToExpiryMs: 0,
      },
      won ? "win" : "loss",
      "settlement",
      won ? "Market settled in favor." : "Market settled against position.",
    );
    return;
  }

  if (!exitSnapshot) {
    addLog(`Holding ${position.side.toUpperCase()} on ${position.marketSlug}: live quote unavailable.`, "info");
    void persistState();
    return;
  }

  const holdTimeMs = Date.now() - position.openedAt;
  const reversalTriggered = isMomentumReversal(position.side, exitSnapshot.btcMove1mPct, exitSnapshot.btcMove3mPct);
  const forcedFlattenTriggered = exitSnapshot.timeToExpiryMs !== null && exitSnapshot.timeToExpiryMs <= FINAL_FLATTEN_CUTOFF_MS;
  const takeProfitTriggered = exitSnapshot.netPnlUsd >= position.targetProfitUsd;
  const stopLossTriggered = exitSnapshot.netPnlUsd <= -position.maxLossUsd;
  const timeStopTriggered = holdTimeMs >= MAX_HOLD_MS && exitSnapshot.netPnlUsd <= 0;

  if (takeProfitTriggered) {
    settlePosition(
      position,
      exitSnapshot,
      "win",
      "take_profit",
      `Net take profit reached ${formatUsd(exitSnapshot.netPnlUsd)} at ${(exitSnapshot.exitPrice * 100).toFixed(1)}c.`,
    );
    return;
  }

  if (reversalTriggered) {
    settlePosition(
      position,
      exitSnapshot,
      exitSnapshot.netPnlUsd >= 0 ? "win" : "loss",
      "reversal",
      `BTC momentum reversed (${formatPct(exitSnapshot.btcMove1mPct)} / ${formatPct(exitSnapshot.btcMove3mPct)}).`,
    );
    return;
  }

  if (stopLossTriggered) {
    settlePosition(
      position,
      exitSnapshot,
      "loss",
      "stop_loss",
      `Net stop-loss hit at ${formatUsd(exitSnapshot.netPnlUsd)}.`,
    );
    return;
  }

  if (timeStopTriggered) {
    settlePosition(
      position,
      exitSnapshot,
      exitSnapshot.netPnlUsd >= 0 ? "win" : "loss",
      "time_stop",
      `Time stop after ${formatDuration(holdTimeMs)} with net ${formatUsd(exitSnapshot.netPnlUsd)}.`,
    );
    return;
  }

  if (forcedFlattenTriggered) {
    settlePosition(
      position,
      exitSnapshot,
      exitSnapshot.netPnlUsd >= 0 ? "win" : "loss",
      "forced_flatten",
      `Forced flatten with ${formatDuration(exitSnapshot.timeToExpiryMs)} to expiry.`,
    );
    return;
  }

  addLog(
    [
      `Holding ${position.side.toUpperCase()} on ${position.marketSlug}`,
      `entry ${(position.entryPrice * 100).toFixed(1)}c`,
      `live ${(exitSnapshot.exitPrice * 100).toFixed(1)}c`,
      `net ${formatUsd(exitSnapshot.netPnlUsd)}`,
      `tte ${formatDuration(exitSnapshot.timeToExpiryMs)}`,
    ].join(" | "),
    "info",
  );
  void persistState();
}

function settlePosition(
  position: SimPosition,
  exitSnapshot: ExitSnapshot,
  result: "win" | "loss",
  exitReason: ExitReason,
  note: string,
) {
  const grossPnlUsd = roundUsd(exitSnapshot.grossProceedsUsd - position.stakeUsd);
  const pnlUsd = roundUsd(exitSnapshot.netProceedsUsd - position.totalEntryCostUsd);
  const holdTimeMs = Date.now() - position.openedAt;

  state.availableUsd = roundUsd(state.availableUsd + exitSnapshot.netProceedsUsd);
  state.realizedPnlUsd = roundUsd(state.realizedPnlUsd + pnlUsd);
  state.grossRealizedPnlUsd = roundUsd(state.grossRealizedPnlUsd + grossPnlUsd);
  state.wins += result === "win" ? 1 : 0;
  state.losses += result === "loss" ? 1 : 0;
  state.closedTrades.unshift({
    strategyId: position.strategyId,
    side: position.side,
    marketSlug: position.marketSlug,
    stakeUsd: position.stakeUsd,
    entryFeeUsd: position.entryFeeUsd,
    totalEntryCostUsd: position.totalEntryCostUsd,
    shares: position.shares,
    entryPrice: position.entryPrice,
    exitPrice: exitSnapshot.exitPrice,
    grossProceedsUsd: exitSnapshot.grossProceedsUsd,
    proceedsUsd: roundUsd(exitSnapshot.netProceedsUsd),
    grossPnlUsd,
    pnlUsd,
    openedAt: position.openedAt,
    closedAt: Date.now(),
    holdTimeMs,
    result,
    note,
    exitReason,
    spreadBpsAtEntry: position.spreadBpsAtEntry,
    spreadBpsAtExit: exitSnapshot.spreadBps,
    spreadBucket: position.spreadBucket,
    timeToExpiryMsAtEntry: position.enteredAtTimeToExpiryMs,
    timeToExpiryMsAtExit: exitSnapshot.timeToExpiryMs,
    timeBucket: position.timeBucket,
    entrySignals: { ...position.entrySignals },
    exitSignals: {
      btcMove1mPct: exitSnapshot.btcMove1mPct,
      btcMove3mPct: exitSnapshot.btcMove3mPct,
      btcMove5mPct: exitSnapshot.btcMove5mPct,
      bookMoveBps: exitSnapshot.bookMoveBps,
      spreadBps: exitSnapshot.spreadBps,
      timeToExpiryMs: exitSnapshot.timeToExpiryMs,
    },
  });
  if (state.closedTrades.length > MAX_CLOSED_TRADES) {
    state.closedTrades.length = MAX_CLOSED_TRADES;
  }
  updateAggregate(state.analytics.pnlByStrategy[position.strategyId], pnlUsd, grossPnlUsd, holdTimeMs, result);
  updateAggregate(state.analytics.pnlByDirection[position.side], pnlUsd, grossPnlUsd, holdTimeMs, result);
  updateAggregate(state.analytics.pnlBySpreadBucket[position.spreadBucket], pnlUsd, grossPnlUsd, holdTimeMs, result);
  updateAggregate(state.analytics.pnlByTimeBucket[position.timeBucket], pnlUsd, grossPnlUsd, holdTimeMs, result);

  state.openPosition = null;
  state.unrealizedPnlUsd = 0;
  state.grossUnrealizedPnlUsd = 0;

  const message = [
    `SIM SELL ${position.side.toUpperCase()} on ${position.marketSlug}`,
    `gross ${formatUsd(exitSnapshot.grossProceedsUsd)}`,
    `net ${formatUsd(exitSnapshot.netProceedsUsd)}`,
    `pnl ${formatUsd(pnlUsd)}`,
    exitReason,
    note,
  ].join(" | ");
  addLog(message, pnlUsd >= 0 ? "success" : "warn");
  logEvent(position.marketSlug, message, pnlUsd >= 0 ? "success" : "warn", "auto");

  if (state.availableUsd < MIN_STAKE_USD) {
    addLog("Virtual bankroll is exhausted. Simulation will not place new entries.", "warn");
    state.active = false;
  }

  recalculateSessionMetrics();
  broadcastState();
  syncMarketSubscription();
  void persistState();
}

function evaluateEntry(snapshot: Btc5mMarketSnapshotPayload): EntryDecision {
  const strategyId: StrategyId = "momentum_book_v1";
  if (snapshot.market.status !== "live") {
    return { shouldSkip: true, reason: `market is ${snapshot.market.status}`, side: null, strategyId, entrySignals: null };
  }

  const previous = lastObservedQuotes.get(snapshot.market.slug);
  if (!previous) {
    return { shouldSkip: true, reason: "waiting for previous quote sample", side: null, strategyId, entrySignals: null };
  }

  const timeToExpiryMs = getTimeToExpiryMs(snapshot);
  if (timeToExpiryMs !== null && timeToExpiryMs <= FINAL_ENTRY_CUTOFF_MS) {
    return { shouldSkip: true, reason: `too close to expiry (${formatDuration(timeToExpiryMs)})`, side: null, strategyId, entrySignals: null };
  }

  const upSignals = buildEntrySignals(snapshot, "up", previous.up);
  const downSignals = buildEntrySignals(snapshot, "down", previous.down);
  const upDecision = scoreEntry(snapshot, "up", upSignals);
  const downDecision = scoreEntry(snapshot, "down", downSignals);
  const preferred = chooseBetterDecision(upDecision, downDecision);

  if (!preferred.side || !preferred.entrySignals) {
    return {
      shouldSkip: true,
      reason: `no qualified entry (up: ${upDecision.reason}; down: ${downDecision.reason})`,
      side: null,
      strategyId,
      entrySignals: null,
    };
  }

  return preferred;
}

function buildEntrySignals(snapshot: Btc5mMarketSnapshotPayload, side: SimSide, previousQuote: number | null | undefined): EntrySignals {
  const book = side === "up" ? snapshot.book.yes : snapshot.book.no;
  const liveBestAsk = side === "up" ? snapshot.book.yes?.bestAsk ?? snapshot.quotes.up : snapshot.book.no?.bestAsk ?? snapshot.quotes.down;
  const liveBestBid = side === "up" ? snapshot.book.yes?.bestBid ?? snapshot.quotes.up : snapshot.book.no?.bestBid ?? snapshot.quotes.down;
  const bookMidpoint = book?.midpoint ?? liveBestAsk ?? null;
  const currentQuote = liveBestAsk;
  const bookMoveBps =
    currentQuote !== null && previousQuote !== null && previousQuote !== undefined && previousQuote > 0
      ? ((currentQuote - previousQuote) / previousQuote) * 10_000
      : null;

  return {
    btcMove1mPct: getDirectionalBtcMove(snapshot, 1),
    btcMove3mPct: getDirectionalBtcMove(snapshot, 3),
    btcMove5mPct: getDirectionalBtcMove(snapshot, 5),
    bookMoveBps,
    spreadBps: book?.spreadBps ?? null,
    timeToExpiryMs: getTimeToExpiryMs(snapshot),
    predictionDirection: snapshot.prediction.direction,
    predictionConfidence: snapshot.prediction.confidence ?? null,
    bookMidpoint,
    liveBestAsk,
    liveBestBid,
  };
}

function scoreEntry(snapshot: Btc5mMarketSnapshotPayload, side: SimSide, entrySignals: EntrySignals): EntryDecision {
  const strategyId: StrategyId = "momentum_book_v1";
  const momentum = entrySignals.btcMove1mPct;
  const bookMove = entrySignals.bookMoveBps;
  const spreadBps = entrySignals.spreadBps;
  const liveBestAsk = entrySignals.liveBestAsk;

  if (liveBestAsk === null || liveBestAsk <= 0 || liveBestAsk >= 1) {
    return { shouldSkip: true, reason: "no valid ask", side: null, strategyId, entrySignals: null };
  }
  if (liveBestAsk < MIN_ENTRY_PRICE || liveBestAsk > MAX_ENTRY_PRICE) {
    return { shouldSkip: true, reason: `${Math.round(liveBestAsk * 100)}c out of entry band`, side: null, strategyId, entrySignals: null };
  }
  if (spreadBps === null) {
    return { shouldSkip: true, reason: "spread unavailable", side: null, strategyId, entrySignals: null };
  }
  if (spreadBps > MAX_ENTRY_SPREAD_BPS) {
    return { shouldSkip: true, reason: `spread ${Math.round(spreadBps)} bps too wide`, side: null, strategyId, entrySignals: null };
  }
  if (momentum === null || Math.abs(momentum) < MOMENTUM_ENTRY_PCT) {
    return { shouldSkip: true, reason: `btc momentum too weak (${formatPct(momentum)})`, side: null, strategyId, entrySignals: null };
  }
  if ((side === "up" && momentum <= 0) || (side === "down" && momentum >= 0)) {
    return { shouldSkip: true, reason: `btc momentum wrong-way (${formatPct(momentum)})`, side: null, strategyId, entrySignals: null };
  }
  if (bookMove === null || Math.abs(bookMove) < BOOK_CONFIRMATION_BPS) {
    return { shouldSkip: true, reason: `book move too weak (${formatBps(bookMove)})`, side: null, strategyId, entrySignals: null };
  }
  if ((side === "up" && bookMove <= 0) || (side === "down" && bookMove <= 0)) {
    return { shouldSkip: true, reason: `book not rising for ${side}`, side: null, strategyId, entrySignals: null };
  }
  if (snapshot.prediction.direction !== "neutral" && snapshot.prediction.direction !== side) {
    return { shouldSkip: true, reason: `prediction points ${snapshot.prediction.direction}`, side: null, strategyId, entrySignals: null };
  }

  return {
    shouldSkip: false,
    reason: `btc ${formatPct(momentum)} + book ${formatBps(bookMove)} with ${Math.round(spreadBps)} bps spread`,
    side,
    strategyId,
    entrySignals,
  };
}

function chooseBetterDecision(upDecision: EntryDecision, downDecision: EntryDecision): EntryDecision {
  if (upDecision.side && !downDecision.side) {
    return upDecision;
  }
  if (downDecision.side && !upDecision.side) {
    return downDecision;
  }
  if (!upDecision.side && !downDecision.side) {
    return upDecision;
  }

  const upScore = scoreSignals(upDecision.entrySignals);
  const downScore = scoreSignals(downDecision.entrySignals);
  return upScore >= downScore ? upDecision : downDecision;
}

function scoreSignals(entrySignals: EntrySignals | null) {
  if (!entrySignals) {
    return Number.NEGATIVE_INFINITY;
  }

  return (Math.abs(entrySignals.btcMove1mPct ?? 0) * 100) + Math.abs(entrySignals.bookMoveBps ?? 0) - (entrySignals.spreadBps ?? 1_000);
}

function didPositionWin(side: SimSide, snapshot: Btc5mMarketSnapshotPayload) {
  const start = snapshot.pricing.marketStartPrice;
  const end = snapshot.pricing.marketEndPrice;
  if (start === null || end === null) {
    return false;
  }

  const upWon = end >= start;
  return side === "up" ? upWon : !upWon;
}

function addLog(message: string, type: SimLogType = "info") {
  const entry = {
    timestamp: Date.now(),
    message,
    type,
  } satisfies SimLogEntry;

  state.logs.unshift(entry);
  if (state.logs.length > MAX_LOGS) {
    state.logs.length = MAX_LOGS;
  }

  broadcast({
    type: "btc5m_sim_log",
    log: entry,
    state: getBtc5mSimulationState(),
  });
}

function rememberQuotes(snapshot: Btc5mMarketSnapshotPayload) {
  lastObservedQuotes.set(snapshot.market.slug, {
    up: getLiveEntryPrice(snapshot, "up"),
    down: getLiveEntryPrice(snapshot, "down"),
  });
}

function rememberMarketAssets(snapshot: Btc5mMarketSnapshotPayload) {
  marketOutcomeAssetIds.set(snapshot.market.slug, {
    up: snapshot.market.yesOutcome?.tokenId ?? null,
    down: snapshot.market.noOutcome?.tokenId ?? null,
  });
}

function recalculateSessionMetrics() {
  state.unrealizedPnlUsd = roundUsd(state.openPosition?.unrealizedPnlUsd ?? 0);
  state.grossUnrealizedPnlUsd = roundUsd(state.openPosition?.grossPnlUsd ?? 0);
  state.sessionEquityUsd = roundUsd(state.availableUsd + (state.openPosition?.totalEntryCostUsd ?? 0) + state.unrealizedPnlUsd);
  state.winRate = state.trades > 0 ? roundPct((state.wins / state.trades) * 100) : 0;
  state.analytics.avgHoldTimeMs = computeAverageHoldTimeMs();
  state.analytics.peakEquityUsd = Math.max(state.analytics.peakEquityUsd, state.sessionEquityUsd);
  state.analytics.maxDrawdownUsd = roundUsd(Math.max(state.analytics.maxDrawdownUsd, state.analytics.peakEquityUsd - state.sessionEquityUsd));
}

async function restoreBtc5mSimulationState() {
  if (restorePromise) {
    return restorePromise;
  }

  restorePromise = (async () => {
    try {
      const raw = await readFile(SIM_STATE_FILE, "utf8");
      const parsed = JSON.parse(raw) as Partial<Btc5mSimulationState>;
      state = restoreState(parsed);

      recalculateSessionMetrics();
      if (state.active) {
        addLog("BTC sim state restored from disk.", "info");
        syncMarketSubscription();
        ensureLoop();
      }
    } catch {
      // No saved state yet.
    }
  })();

  return restorePromise;
}

function persistState() {
  persistPromise = (async () => {
    try {
      await mkdir(dirname(SIM_STATE_FILE), { recursive: true });
      await writeFile(SIM_STATE_FILE, JSON.stringify(getBtc5mSimulationState(), null, 2), "utf8");
    } catch (error) {
      console.error("Failed to persist BTC sim state:", error);
    }
  })();

  return persistPromise;
}

function broadcastState() {
  broadcast({
    type: "btc5m_sim_state",
    state: getBtc5mSimulationState(),
  });
}

function handleMarketWsEvent(event: PolymarketMarketWsEvent) {
  if (event.kind === "book") {
    liveBooks.set(event.assetId, new TopOfBook(event.bestBid, event.bestAsk));
    if (applyLiveBookToOpenPosition(event.assetId)) {
      state.lastUpdateAt = Date.now();
      recalculateSessionMetrics();
      broadcastState();
      void persistState();
    }
    return;
  }

  if (event.kind === "resolved" && state.openPosition) {
    void maybeCloseOpenPosition();
  }
}

function applyLiveBookToOpenPosition(assetId: string) {
  const position = state.openPosition;
  if (!position) {
    return false;
  }

  const expectedAssetId = position.assetId;
  if (!expectedAssetId || expectedAssetId !== assetId) {
    return false;
  }

  const livePrice = getLiveExitPrice(position);
  if (livePrice === null || livePrice <= 0) {
    return false;
  }

  position.currentPrice = livePrice;
  position.grossExitProceedsUsd = roundUsd(position.shares * livePrice);
  position.netExitProceedsUsd = roundUsd(position.grossExitProceedsUsd * (1 - EXIT_FEE_RATE));
  position.grossPnlUsd = roundUsd(position.grossExitProceedsUsd - position.stakeUsd);
  position.unrealizedPnlUsd = roundUsd((position.netExitProceedsUsd ?? 0) - position.totalEntryCostUsd);
  return true;
}

function syncMarketSubscription() {
  const assetIds = new Set<string>();
  const currentMarket = state.openPosition?.marketSlug ?? state.lastMarketSlug;
  if (currentMarket) {
    const tracked = getTrackedAssetIdsForSlug(currentMarket);
    for (const assetId of tracked) {
      assetIds.add(assetId);
    }
  }

  marketWs.setTrackedAssets(Array.from(assetIds));
}

function getTrackedAssetIdsForSlug(slug: string) {
  const tracked = new Set<string>();
  const openPosition = state.openPosition;
  if (openPosition && openPosition.marketSlug === slug) {
    const assetId = openPosition.assetId;
    if (assetId) {
      tracked.add(assetId);
    }
  }

  const quoted = getMarketOutcomeIdsBySlug(slug);
  if (quoted.up) {
    tracked.add(quoted.up);
  }
  if (quoted.down) {
    tracked.add(quoted.down);
  }

  return tracked;
}

function getMarketOutcomeIdsBySlug(slug: string) {
  return marketOutcomeAssetIds.get(slug) ?? { up: null, down: null };
}

function getSnapshotAssetId(snapshot: Btc5mMarketSnapshotPayload, side: SimSide) {
  return side === "up" ? snapshot.market.yesOutcome?.tokenId ?? null : snapshot.market.noOutcome?.tokenId ?? null;
}

function getLiveEntryPrice(snapshot: Btc5mMarketSnapshotPayload, side: SimSide) {
  const assetId = getSnapshotAssetId(snapshot, side);
  const livePrice = assetId ? liveBooks.get(assetId)?.bestAsk ?? null : null;
  if (livePrice !== null && livePrice > 0 && livePrice < 1) {
    return livePrice;
  }

  return getFallbackSnapshotQuote(snapshot, side);
}

function getLiveExitPrice(position: SimPosition) {
  if (!position.assetId) {
    return null;
  }

  return liveBooks.get(position.assetId)?.bestBid ?? null;
}

function getFallbackSnapshotQuote(snapshot: Btc5mMarketSnapshotPayload, side: SimSide) {
  return side === "up" ? snapshot.quotes.up : snapshot.quotes.down;
}

function getExitSnapshot(position: SimPosition, snapshot: Btc5mMarketSnapshotPayload): ExitSnapshot | null {
  const exitPrice = getLiveExitPrice(position) ?? getFallbackSnapshotQuote(snapshot, position.side);
  if (exitPrice === null || exitPrice <= 0) {
    return null;
  }

  const grossProceedsUsd = roundUsd(position.shares * exitPrice);
  const netProceedsUsd = roundUsd(grossProceedsUsd * (1 - EXIT_FEE_RATE));
  return {
    exitPrice,
    grossProceedsUsd,
    netProceedsUsd,
    netPnlUsd: roundUsd(netProceedsUsd - position.totalEntryCostUsd),
    btcMove1mPct: getDirectionalBtcMove(snapshot, 1),
    btcMove3mPct: getDirectionalBtcMove(snapshot, 3),
    btcMove5mPct: getDirectionalBtcMove(snapshot, 5),
    bookMoveBps: getBookMoveBps(snapshot, position.side),
    spreadBps: (position.side === "up" ? snapshot.book.yes : snapshot.book.no)?.spreadBps ?? null,
    timeToExpiryMs: getTimeToExpiryMs(snapshot),
  };
}

function getDirectionalBtcMove(snapshot: Btc5mMarketSnapshotPayload, minutes: 1 | 3 | 5) {
  const move = minutes === 5 ? snapshot.pricing.marketPriceChangePct : estimateShortWindowMovePct(snapshot, minutes);
  if (move === null) {
    return null;
  }

  return snapshot.prediction.direction === "down" ? -Math.abs(move) : move;
}

function estimateShortWindowMovePct(snapshot: Btc5mMarketSnapshotPayload, minutes: 1 | 3) {
  const currentBtcPrice = snapshot.pricing.currentBtcPrice;
  const marketStartPrice = snapshot.pricing.marketStartPrice;
  const marketMove = snapshot.pricing.marketPriceChangePct;
  if (currentBtcPrice === null || marketStartPrice === null || marketMove === null) {
    return null;
  }

  const elapsedMs = getElapsedMarketMs(snapshot);
  if (elapsedMs === null || elapsedMs <= 0) {
    return null;
  }

  const ratio = Math.min(1, (minutes * 60_000) / elapsedMs);
  return marketMove * ratio;
}

function getBookMoveBps(snapshot: Btc5mMarketSnapshotPayload, side: SimSide) {
  const previous = lastObservedQuotes.get(snapshot.market.slug);
  const current = getLiveEntryPrice(snapshot, side);
  const prior = side === "up" ? previous?.up : previous?.down;
  if (current === null || prior === null || prior === undefined || prior <= 0) {
    return null;
  }

  return ((current - prior) / prior) * 10_000;
}

function getTimeToExpiryMs(snapshot: Btc5mMarketSnapshotPayload) {
  if (!snapshot.market.endTime) {
    return null;
  }
  return Math.max(0, snapshot.market.endTime - Date.now());
}

function getElapsedMarketMs(snapshot: Btc5mMarketSnapshotPayload) {
  if (!snapshot.market.startTime) {
    return null;
  }
  return Math.max(0, Date.now() - snapshot.market.startTime);
}

function isMomentumReversal(side: SimSide, move1mPct: number | null, move3mPct: number | null) {
  if (move1mPct === null && move3mPct === null) {
    return false;
  }

  if (side === "up") {
    return (move1mPct ?? 0) <= -MOMENTUM_REVERSAL_PCT || (move3mPct ?? 0) <= -MOMENTUM_REVERSAL_PCT;
  }

  return (move1mPct ?? 0) >= MOMENTUM_REVERSAL_PCT || (move3mPct ?? 0) >= MOMENTUM_REVERSAL_PCT;
}

function createInitialState(bankrollUsd: number): Btc5mSimulationState {
  return {
    active: false,
    bankrollUsd,
    availableUsd: bankrollUsd,
    minStakeUsd: MIN_STAKE_USD,
    realizedPnlUsd: 0,
    grossRealizedPnlUsd: 0,
    totalStakedUsd: 0,
    wins: 0,
    losses: 0,
    trades: 0,
    winRate: 0,
    sessionEquityUsd: bankrollUsd,
    unrealizedPnlUsd: 0,
    grossUnrealizedPnlUsd: 0,
    lastUpdateAt: null,
    lastMarketSlug: null,
    strategyId: "momentum_book_v1",
    openPosition: null,
    closedTrades: [],
    analytics: createAnalytics(bankrollUsd),
    logs: [],
  };
}

function createAnalytics(bankrollUsd: number): SimulationAnalytics {
  return {
    avgHoldTimeMs: 0,
    maxDrawdownUsd: 0,
    peakEquityUsd: bankrollUsd,
    pnlByStrategy: {
      momentum_book_v1: createAggregate(),
    },
    pnlByDirection: {
      up: createAggregate(),
      down: createAggregate(),
    },
    pnlBySpreadBucket: {
      lt_150: createAggregate(),
      "150_300": createAggregate(),
      "300_500": createAggregate(),
      gte_500: createAggregate(),
      unknown: createAggregate(),
    },
    pnlByTimeBucket: {
      early: createAggregate(),
      mid: createAggregate(),
      late: createAggregate(),
    },
  };
}

function createAggregate(): StrategyAggregate {
  return {
    trades: 0,
    wins: 0,
    losses: 0,
    grossPnlUsd: 0,
    netPnlUsd: 0,
    totalHoldTimeMs: 0,
  };
}

function cloneAnalytics(analytics: SimulationAnalytics): SimulationAnalytics {
  return {
    avgHoldTimeMs: analytics.avgHoldTimeMs,
    maxDrawdownUsd: analytics.maxDrawdownUsd,
    peakEquityUsd: analytics.peakEquityUsd,
    pnlByStrategy: {
      momentum_book_v1: { ...analytics.pnlByStrategy.momentum_book_v1 },
    },
    pnlByDirection: {
      up: { ...analytics.pnlByDirection.up },
      down: { ...analytics.pnlByDirection.down },
    },
    pnlBySpreadBucket: {
      lt_150: { ...analytics.pnlBySpreadBucket.lt_150 },
      "150_300": { ...analytics.pnlBySpreadBucket["150_300"] },
      "300_500": { ...analytics.pnlBySpreadBucket["300_500"] },
      gte_500: { ...analytics.pnlBySpreadBucket.gte_500 },
      unknown: { ...analytics.pnlBySpreadBucket.unknown },
    },
    pnlByTimeBucket: {
      early: { ...analytics.pnlByTimeBucket.early },
      mid: { ...analytics.pnlByTimeBucket.mid },
      late: { ...analytics.pnlByTimeBucket.late },
    },
  };
}

function restoreState(parsed: Partial<Btc5mSimulationState>) {
  const bankrollUsd = roundUsd(Number(parsed.bankrollUsd ?? 0));
  const restored = createInitialState(bankrollUsd);
  restored.active = Boolean(parsed.active);
  restored.availableUsd = roundUsd(Number(parsed.availableUsd ?? bankrollUsd));
  restored.realizedPnlUsd = roundUsd(Number(parsed.realizedPnlUsd ?? 0));
  restored.grossRealizedPnlUsd = roundUsd(Number((parsed as { grossRealizedPnlUsd?: number }).grossRealizedPnlUsd ?? 0));
  restored.totalStakedUsd = roundUsd(Number(parsed.totalStakedUsd ?? 0));
  restored.wins = Number(parsed.wins ?? 0);
  restored.losses = Number(parsed.losses ?? 0);
  restored.trades = Number(parsed.trades ?? 0);
  restored.winRate = Number(parsed.winRate ?? 0);
  restored.sessionEquityUsd = roundUsd(Number(parsed.sessionEquityUsd ?? bankrollUsd));
  restored.unrealizedPnlUsd = roundUsd(Number(parsed.unrealizedPnlUsd ?? 0));
  restored.grossUnrealizedPnlUsd = roundUsd(Number((parsed as { grossUnrealizedPnlUsd?: number }).grossUnrealizedPnlUsd ?? 0));
  restored.lastUpdateAt = typeof parsed.lastUpdateAt === "number" ? parsed.lastUpdateAt : null;
  restored.lastMarketSlug = typeof parsed.lastMarketSlug === "string" ? parsed.lastMarketSlug : null;
  restored.strategyId = parsed.strategyId === "momentum_book_v1" ? parsed.strategyId : "momentum_book_v1";
  restored.analytics = restoreAnalytics(parsed.analytics, bankrollUsd);
  restored.openPosition = restoreOpenPosition(parsed.openPosition);
  restored.closedTrades = Array.isArray(parsed.closedTrades)
    ? parsed.closedTrades.slice(0, MAX_CLOSED_TRADES).map(restoreClosedTrade)
    : [];
  restored.logs = Array.isArray(parsed.logs)
    ? parsed.logs.slice(0, MAX_LOGS).map((log) => ({
        timestamp: Number(log.timestamp ?? Date.now()),
        message: String(log.message ?? ""),
        type: log.type === "warn" || log.type === "error" || log.type === "success" ? log.type : "info",
      }))
    : [];
  rebuildDerivedState(restored);
  return restored;
}

function restoreAnalytics(parsed: Partial<SimulationAnalytics> | undefined, bankrollUsd: number) {
  const analytics = createAnalytics(bankrollUsd);
  if (!parsed) {
    return analytics;
  }

  analytics.avgHoldTimeMs = Number(parsed.avgHoldTimeMs ?? 0);
  analytics.maxDrawdownUsd = roundUsd(Number(parsed.maxDrawdownUsd ?? 0));
  analytics.peakEquityUsd = roundUsd(Number(parsed.peakEquityUsd ?? bankrollUsd));
  restoreAggregateInto(analytics.pnlByStrategy.momentum_book_v1, parsed.pnlByStrategy?.momentum_book_v1);
  restoreAggregateInto(analytics.pnlByDirection.up, parsed.pnlByDirection?.up);
  restoreAggregateInto(analytics.pnlByDirection.down, parsed.pnlByDirection?.down);
  restoreAggregateInto(analytics.pnlBySpreadBucket.lt_150, parsed.pnlBySpreadBucket?.lt_150);
  restoreAggregateInto(analytics.pnlBySpreadBucket["150_300"], parsed.pnlBySpreadBucket?.["150_300"]);
  restoreAggregateInto(analytics.pnlBySpreadBucket["300_500"], parsed.pnlBySpreadBucket?.["300_500"]);
  restoreAggregateInto(analytics.pnlBySpreadBucket.gte_500, parsed.pnlBySpreadBucket?.gte_500);
  restoreAggregateInto(analytics.pnlBySpreadBucket.unknown, parsed.pnlBySpreadBucket?.unknown);
  restoreAggregateInto(analytics.pnlByTimeBucket.early, parsed.pnlByTimeBucket?.early);
  restoreAggregateInto(analytics.pnlByTimeBucket.mid, parsed.pnlByTimeBucket?.mid);
  restoreAggregateInto(analytics.pnlByTimeBucket.late, parsed.pnlByTimeBucket?.late);
  return analytics;
}

function restoreAggregateInto(target: StrategyAggregate, parsed: Partial<StrategyAggregate> | undefined) {
  if (!parsed) {
    return;
  }
  target.trades = Number(parsed.trades ?? 0);
  target.wins = Number(parsed.wins ?? 0);
  target.losses = Number(parsed.losses ?? 0);
  target.grossPnlUsd = roundUsd(Number(parsed.grossPnlUsd ?? 0));
  target.netPnlUsd = roundUsd(Number(parsed.netPnlUsd ?? 0));
  target.totalHoldTimeMs = Number(parsed.totalHoldTimeMs ?? 0);
}

function restoreOpenPosition(parsed: Partial<SimPosition> | null | undefined): SimPosition | null {
  if (!parsed) {
    return null;
  }

  return {
    strategyId: parsed.strategyId === "momentum_book_v1" ? parsed.strategyId : "momentum_book_v1",
    side: parsed.side === "down" ? "down" : "up",
    marketSlug: String(parsed.marketSlug ?? ""),
    assetId: parsed.assetId === null || parsed.assetId === undefined ? null : String(parsed.assetId),
    stakeUsd: roundUsd(Number(parsed.stakeUsd ?? 0)),
    entryFeeUsd: roundUsd(Number(parsed.entryFeeUsd ?? 0)),
    totalEntryCostUsd: roundUsd(Number(parsed.totalEntryCostUsd ?? parsed.stakeUsd ?? 0)),
    shares: roundShares(Number(parsed.shares ?? 0)),
    entryPrice: Number(parsed.entryPrice ?? 0),
    openedAt: Number(parsed.openedAt ?? Date.now()),
    currentPrice: parsed.currentPrice === null || parsed.currentPrice === undefined ? null : Number(parsed.currentPrice),
    grossExitProceedsUsd: parsed.grossExitProceedsUsd === null || parsed.grossExitProceedsUsd === undefined ? null : roundUsd(Number(parsed.grossExitProceedsUsd)),
    netExitProceedsUsd: parsed.netExitProceedsUsd === null || parsed.netExitProceedsUsd === undefined ? null : roundUsd(Number(parsed.netExitProceedsUsd)),
    grossPnlUsd: parsed.grossPnlUsd === null || parsed.grossPnlUsd === undefined ? null : roundUsd(Number(parsed.grossPnlUsd)),
    unrealizedPnlUsd: parsed.unrealizedPnlUsd === null || parsed.unrealizedPnlUsd === undefined ? null : roundUsd(Number(parsed.unrealizedPnlUsd)),
    toWinUsd: roundUsd(Number(parsed.toWinUsd ?? 0)),
    enteredAtTimeToExpiryMs: parsed.enteredAtTimeToExpiryMs === null || parsed.enteredAtTimeToExpiryMs === undefined ? null : Number(parsed.enteredAtTimeToExpiryMs),
    spreadBpsAtEntry: parsed.spreadBpsAtEntry === null || parsed.spreadBpsAtEntry === undefined ? null : Number(parsed.spreadBpsAtEntry),
    spreadBucket: isSpreadBucket(parsed.spreadBucket) ? parsed.spreadBucket : "unknown",
    timeBucket: isTimeBucket(parsed.timeBucket) ? parsed.timeBucket : "mid",
    entrySignals: restoreEntrySignals(parsed.entrySignals),
    targetProfitUsd: roundUsd(Number(parsed.targetProfitUsd ?? TAKE_PROFIT_USD)),
    maxLossUsd: roundUsd(Number(parsed.maxLossUsd ?? STOP_LOSS_USD)),
  };
}

function restoreClosedTrade(parsed: Partial<ClosedSimTrade>): ClosedSimTrade {
  const openedAt = Number(parsed.openedAt ?? Date.now());
  const closedAt = Number(parsed.closedAt ?? Date.now());
  return {
    strategyId: parsed.strategyId === "momentum_book_v1" ? parsed.strategyId : "momentum_book_v1",
    side: parsed.side === "down" ? "down" : "up",
    marketSlug: String(parsed.marketSlug ?? ""),
    stakeUsd: roundUsd(Number(parsed.stakeUsd ?? 0)),
    entryFeeUsd: roundUsd(Number(parsed.entryFeeUsd ?? 0)),
    totalEntryCostUsd: roundUsd(Number(parsed.totalEntryCostUsd ?? parsed.stakeUsd ?? 0)),
    shares: roundShares(Number(parsed.shares ?? 0)),
    entryPrice: Number(parsed.entryPrice ?? 0),
    exitPrice: Number(parsed.exitPrice ?? 0),
    grossProceedsUsd: roundUsd(Number(parsed.grossProceedsUsd ?? parsed.proceedsUsd ?? 0)),
    proceedsUsd: roundUsd(Number(parsed.proceedsUsd ?? 0)),
    grossPnlUsd: roundUsd(Number(parsed.grossPnlUsd ?? 0)),
    pnlUsd: roundUsd(Number(parsed.pnlUsd ?? 0)),
    openedAt,
    closedAt,
    holdTimeMs: Number(parsed.holdTimeMs ?? Math.max(0, closedAt - openedAt)),
    result: parsed.result === "loss" ? "loss" : "win",
    note: String(parsed.note ?? ""),
    exitReason: isExitReason(parsed.exitReason) ? parsed.exitReason : "settlement",
    spreadBpsAtEntry: parsed.spreadBpsAtEntry === null || parsed.spreadBpsAtEntry === undefined ? null : Number(parsed.spreadBpsAtEntry),
    spreadBpsAtExit: parsed.spreadBpsAtExit === null || parsed.spreadBpsAtExit === undefined ? null : Number(parsed.spreadBpsAtExit),
    spreadBucket: isSpreadBucket(parsed.spreadBucket) ? parsed.spreadBucket : "unknown",
    timeToExpiryMsAtEntry: parsed.timeToExpiryMsAtEntry === null || parsed.timeToExpiryMsAtEntry === undefined ? null : Number(parsed.timeToExpiryMsAtEntry),
    timeToExpiryMsAtExit: parsed.timeToExpiryMsAtExit === null || parsed.timeToExpiryMsAtExit === undefined ? null : Number(parsed.timeToExpiryMsAtExit),
    timeBucket: isTimeBucket(parsed.timeBucket) ? parsed.timeBucket : "mid",
    entrySignals: restoreEntrySignals(parsed.entrySignals),
    exitSignals: {
      btcMove1mPct: parsed.exitSignals?.btcMove1mPct === null || parsed.exitSignals?.btcMove1mPct === undefined ? null : Number(parsed.exitSignals.btcMove1mPct),
      btcMove3mPct: parsed.exitSignals?.btcMove3mPct === null || parsed.exitSignals?.btcMove3mPct === undefined ? null : Number(parsed.exitSignals.btcMove3mPct),
      btcMove5mPct: parsed.exitSignals?.btcMove5mPct === null || parsed.exitSignals?.btcMove5mPct === undefined ? null : Number(parsed.exitSignals.btcMove5mPct),
      bookMoveBps: parsed.exitSignals?.bookMoveBps === null || parsed.exitSignals?.bookMoveBps === undefined ? null : Number(parsed.exitSignals.bookMoveBps),
      spreadBps: parsed.exitSignals?.spreadBps === null || parsed.exitSignals?.spreadBps === undefined ? null : Number(parsed.exitSignals.spreadBps),
      timeToExpiryMs: parsed.exitSignals?.timeToExpiryMs === null || parsed.exitSignals?.timeToExpiryMs === undefined ? null : Number(parsed.exitSignals.timeToExpiryMs),
    },
  };
}

function rebuildDerivedState(target: Btc5mSimulationState) {
  target.analytics = createAnalytics(target.bankrollUsd);
  target.realizedPnlUsd = 0;
  target.grossRealizedPnlUsd = 0;
  target.totalStakedUsd = 0;
  target.wins = 0;
  target.losses = 0;

  for (const trade of target.closedTrades) {
    target.realizedPnlUsd = roundUsd(target.realizedPnlUsd + trade.pnlUsd);
    target.grossRealizedPnlUsd = roundUsd(target.grossRealizedPnlUsd + trade.grossPnlUsd);
    target.totalStakedUsd = roundUsd(target.totalStakedUsd + trade.totalEntryCostUsd);
    target.wins += trade.result === "win" ? 1 : 0;
    target.losses += trade.result === "loss" ? 1 : 0;
    updateAggregate(target.analytics.pnlByStrategy[trade.strategyId], trade.pnlUsd, trade.grossPnlUsd, trade.holdTimeMs, trade.result);
    updateAggregate(target.analytics.pnlByDirection[trade.side], trade.pnlUsd, trade.grossPnlUsd, trade.holdTimeMs, trade.result);
    updateAggregate(target.analytics.pnlBySpreadBucket[trade.spreadBucket], trade.pnlUsd, trade.grossPnlUsd, trade.holdTimeMs, trade.result);
    updateAggregate(target.analytics.pnlByTimeBucket[trade.timeBucket], trade.pnlUsd, trade.grossPnlUsd, trade.holdTimeMs, trade.result);
  }

  if (target.openPosition) {
    target.totalStakedUsd = roundUsd(target.totalStakedUsd + target.openPosition.totalEntryCostUsd);
  }

  target.trades = target.closedTrades.length + (target.openPosition ? 1 : 0);
  target.winRate = target.trades > 0 ? roundPct((target.wins / target.trades) * 100) : 0;
  target.analytics.avgHoldTimeMs = target.closedTrades.length > 0
    ? Math.round(target.closedTrades.reduce((sum, trade) => sum + trade.holdTimeMs, 0) / target.closedTrades.length)
    : 0;
  const peakFromSession = Math.max(target.bankrollUsd, target.sessionEquityUsd, target.availableUsd + target.realizedPnlUsd + (target.openPosition?.totalEntryCostUsd ?? 0));
  target.analytics.peakEquityUsd = Math.max(target.analytics.peakEquityUsd, peakFromSession);
}

function restoreEntrySignals(parsed: Partial<EntrySignals> | undefined): EntrySignals {
  return {
    btcMove1mPct: parsed?.btcMove1mPct === null || parsed?.btcMove1mPct === undefined ? null : Number(parsed.btcMove1mPct),
    btcMove3mPct: parsed?.btcMove3mPct === null || parsed?.btcMove3mPct === undefined ? null : Number(parsed.btcMove3mPct),
    btcMove5mPct: parsed?.btcMove5mPct === null || parsed?.btcMove5mPct === undefined ? null : Number(parsed.btcMove5mPct),
    bookMoveBps: parsed?.bookMoveBps === null || parsed?.bookMoveBps === undefined ? null : Number(parsed.bookMoveBps),
    spreadBps: parsed?.spreadBps === null || parsed?.spreadBps === undefined ? null : Number(parsed.spreadBps),
    timeToExpiryMs: parsed?.timeToExpiryMs === null || parsed?.timeToExpiryMs === undefined ? null : Number(parsed.timeToExpiryMs),
    predictionDirection: parsed?.predictionDirection === "up" || parsed?.predictionDirection === "down" || parsed?.predictionDirection === "neutral" ? parsed.predictionDirection : "neutral",
    predictionConfidence: parsed?.predictionConfidence === null || parsed?.predictionConfidence === undefined ? null : Number(parsed.predictionConfidence),
    bookMidpoint: parsed?.bookMidpoint === null || parsed?.bookMidpoint === undefined ? null : Number(parsed.bookMidpoint),
    liveBestAsk: parsed?.liveBestAsk === null || parsed?.liveBestAsk === undefined ? null : Number(parsed.liveBestAsk),
    liveBestBid: parsed?.liveBestBid === null || parsed?.liveBestBid === undefined ? null : Number(parsed.liveBestBid),
  };
}

function updateAggregate(aggregate: StrategyAggregate, netPnlUsd: number, grossPnlUsd: number, holdTimeMs: number, result: "win" | "loss") {
  aggregate.trades += 1;
  aggregate.wins += result === "win" ? 1 : 0;
  aggregate.losses += result === "loss" ? 1 : 0;
  aggregate.netPnlUsd = roundUsd(aggregate.netPnlUsd + netPnlUsd);
  aggregate.grossPnlUsd = roundUsd(aggregate.grossPnlUsd + grossPnlUsd);
  aggregate.totalHoldTimeMs += holdTimeMs;
}

function computeAverageHoldTimeMs() {
  if (state.closedTrades.length === 0) {
    return 0;
  }
  const total = state.closedTrades.reduce((sum, trade) => sum + trade.holdTimeMs, 0);
  return Math.round(total / state.closedTrades.length);
}

function getSpreadBucket(spreadBps: number | null): SpreadBucket {
  if (spreadBps === null) {
    return "unknown";
  }
  if (spreadBps < 150) {
    return "lt_150";
  }
  if (spreadBps < 300) {
    return "150_300";
  }
  if (spreadBps < 500) {
    return "300_500";
  }
  return "gte_500";
}

function getTimeBucket(timeToExpiryMs: number | null): TimeBucket {
  if (timeToExpiryMs === null) {
    return "mid";
  }
  if (timeToExpiryMs > 180_000) {
    return "early";
  }
  if (timeToExpiryMs > 60_000) {
    return "mid";
  }
  return "late";
}

function isSpreadBucket(value: unknown): value is SpreadBucket {
  return value === "lt_150" || value === "150_300" || value === "300_500" || value === "gte_500" || value === "unknown";
}

function isTimeBucket(value: unknown): value is TimeBucket {
  return value === "early" || value === "mid" || value === "late";
}

function isExitReason(value: unknown): value is ExitReason {
  return value === "take_profit" || value === "stop_loss" || value === "reversal" || value === "time_stop" || value === "settlement" || value === "forced_flatten";
}

function broadcast(message: unknown) {
  if (!wss) {
    return;
  }

  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function roundUsd(value: number) {
  return Math.round(value * 100) / 100;
}

function roundPct(value: number) {
  return Math.round(value * 100) / 100;
}

function roundShares(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function formatUsd(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;
}

function formatPct(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  return `${value >= 0 ? "+" : ""}${value.toFixed(3)}%`;
}

function formatBps(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  return `${value >= 0 ? "+" : ""}${Math.round(value)}bps`;
}

function formatDuration(ms: number | null | undefined) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    return "n/a";
  }
  if (ms < 1_000) {
    return `${Math.max(0, Math.round(ms))}ms`;
  }
  return `${(ms / 1_000).toFixed(1)}s`;
}
