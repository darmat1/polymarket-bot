import { randomUUID } from "node:crypto";

import type { ScalperUserWsMessage } from "../scalper-user-ws.js";
import type { BudgetSnapshot } from "../budget-manager.js";
import { emptyCycle } from "./state-store.js";
import type {
  Btc15mAutoAnalyticsSummary,
  Btc15mAutoBotConfig,
  Btc15mAutoBotStatus,
  Btc15mAutoCompletedTrade,
  Btc15mAutoCycleState,
  Btc15mAutoLogEntry,
  Btc15mAutoMarketView,
  Btc15mAutoRuntimeStateUpdate,
  Btc15mAutoSide,
  Btc15mAutoTrackedOrder,
} from "./types.js";

export interface Btc15mAutoBudgetPort {
  reserve(amount: number, reason?: string): Promise<void>;
  release(amount: number, reason?: string): Promise<void>;
  consume(amount: number, reason?: string): Promise<void>;
  addFunds(amount: number, reason?: string): Promise<void>;
  snapshot(): Promise<BudgetSnapshot>;
}

export interface PlaceOrderArgs {
  tokenId: string;
  side: "buy" | "sell";
  price: number;
  size: number;
}

export interface Btc15mAutoRuntime {
  now: () => number;
  resolveMarket: () => Promise<Btc15mAutoMarketView | null>;
  fetchBtcPrice: (atMs: number) => Promise<number | null>;
  placeLimitOrder: (args: PlaceOrderArgs) => Promise<unknown>;
  cancelOrder: (orderId: string) => Promise<unknown>;
  onMarketBookSubscribe: (
    tokenId: string,
    listener: (bestBid: number | null, bestAsk: number | null) => void,
  ) => void;
  onMarketBookUnsubscribe: (tokenId: string) => void;
  startUserWs: (handler: (msg: ScalperUserWsMessage) => void) => Promise<void>;
  stopUserWs: () => void;
  budget: Btc15mAutoBudgetPort;
  persistTrade: (trade: Btc15mAutoCompletedTrade) => Promise<void>;
  persistConfig: (config: Btc15mAutoBotConfig) => Promise<void>;
  persistRuntimeState?: (state: Btc15mAutoRuntimeStateUpdate) => Promise<void>;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  getOrder?: (orderId: string) => Promise<{ status: string; size_matched: string; original_size?: string } | null>;
  getOrderBook?: (tokenId: string) => Promise<{ bestBid: number | null; bestAsk: number | null }>;
  /**
   * Fetch the actual settled trades for an order. A single limit order on Polymarket can match
   * across multiple counterparties at different prices — we aggregate these to compute the TRUE
   * avg fill price and total fees (instead of trusting the limit price).
   */
  getTradesForOrder?: (orderId: string) => Promise<Array<{ price: number; size: number; feeRateBps: number; side: string }>>;
  /**
   * Reconcile target — fetch the live open orders + position Polymarket actually has for this
   * token. LIVE-mode reconcile each tick treats this as the source of truth, not local state.
   */
  getLiveStateForAsset?: (tokenId: string) => Promise<{
    openOrders: Array<{ id: string; side: "buy" | "sell"; price: number; originalSize: number; matchedSize: number; status: string }>;
    position: { size: number; avgPrice: number } | null;
  }>;
  getRecentAccountTrades?: () => Promise<Array<{
    id: string;
    asset_id: string;
    side: string;
    size: string;
    fee_rate_bps: string;
    price: string;
    match_time: string;
    outcome: string;
  }>>;
}

export interface Btc15mAutoBotStartOptions {
  runImmediateTick?: boolean;
  scheduleLoop?: boolean;
}

export interface Btc15mAutoBotOptions {
  config: Btc15mAutoBotConfig;
  dryRun: boolean;
  runtime: Btc15mAutoRuntime;
  initialTrades?: Btc15mAutoCompletedTrade[];
  initialRuntimeState?: Partial<Btc15mAutoRuntimeStateUpdate>;
}

const MAX_LOG_ENTRIES = 60;
const BOOK_STALE_MS = 10_000;

export class Btc15mAutoBot {
  private readonly runtime: Btc15mAutoRuntime;
  private readonly config: Btc15mAutoBotConfig;
  private readonly dryRun: boolean;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickInProgress = false;
  private pendingActions: Promise<void>[] = [];
  private readonly bookSnapshots = new Map<string, { bestBid: number | null; bestAsk: number | null; updatedAt: number }>();
  private readonly subscribedTokens = new Set<string>();
  // Per-side trail/poll throttles — UP and DOWN run as independent parallel cycles.
  private readonly lastTrailUpdateMs: Record<Btc15mAutoSide, number> = { up: 0, down: 0 };
  private readonly lastOrderPollMs: Record<Btc15mAutoSide, number> = { up: 0, down: 0 };
  // Poll every tick (effectively ~1-2s) — Polymarket WS misses fills, so we need fast polling
  // for instant phase transitions. The API call is cheap (single REST GET).
  private readonly orderPollIntervalMs = 1000;
  private static readonly SIDES: readonly Btc15mAutoSide[] = ["up", "down"];
  private state: Btc15mAutoBotStatus;

  constructor(options: Btc15mAutoBotOptions) {
    this.runtime = options.runtime;
    this.config = options.config;
    this.dryRun = options.dryRun;
    this.state = this.buildIdleStatus(options.initialTrades ?? []);
    if (options.initialRuntimeState) {
      this.state.market = options.initialRuntimeState.market ?? null;
      this.state.marketStartBtcPrice = options.initialRuntimeState.marketStartBtcPrice ?? null;
      this.state.currentBtcPrice = options.initialRuntimeState.currentBtcPrice ?? null;
      this.state.upPrice = null;
      this.state.downPrice = null;
      this.state.upCycle = options.initialRuntimeState.upCycle ?? this.state.upCycle;
      this.state.downCycle = options.initialRuntimeState.downCycle ?? this.state.downCycle;
      this.state.logs = options.initialRuntimeState.logs ?? [];
      this.state.lastError = options.initialRuntimeState.lastError ?? null;
      this.state.enginePhase = "stopped";
    }
  }

  getStatus(): Btc15mAutoBotStatus {
    return cloneStatus(this.state);
  }

  // --- Per-side accessors. UP and DOWN are fully independent parallel cycles sharing one budget. ---
  private cycleFor(side: Btc15mAutoSide): Btc15mAutoCycleState {
    return side === "up" ? this.state.upCycle : this.state.downCycle;
  }

  private setCycleFor(side: Btc15mAutoSide, cycle: Btc15mAutoCycleState): void {
    if (side === "up") {
      this.state.upCycle = cycle;
    } else {
      this.state.downCycle = cycle;
    }
  }

  private priceFor(side: Btc15mAutoSide): number | null {
    return side === "up" ? this.state.upPrice : this.state.downPrice;
  }

  private tokenFor(side: Btc15mAutoSide, market: Btc15mAutoMarketView): string {
    return side === "up" ? market.upTokenId : market.downTokenId;
  }

  private sideForToken(tokenId: string): Btc15mAutoSide | null {
    const market = this.state.market;
    if (!market) return null;
    if (tokenId === market.upTokenId) return "up";
    if (tokenId === market.downTokenId) return "down";
    return null;
  }

  /**
   * Full reconciliation of one side's cycle against Polymarket reality (LIVE only).
   *
   * Polymarket is the source of truth for execution state (orders + position). Strategy state
   * (plannedBuyPrice, trail levels, highWaterMark) is preserved locally because it cannot be
   * inferred from Polymarket data.
   *
   * Per-tick algorithm:
   *  1. Fetch live open orders + position for this side's token.
   *  2. If PM has a position the bot didn't track → adopt it as cycle.position, fetch trades to
   *     get the true avg entry, recompute trail levels.
   *  3. If PM has buy/sell orders the bot didn't track → adopt them (sync orderId/price/size).
   *  4. If the bot's tracked order is GONE on PM AND no position appeared → it was cancelled
   *     externally or fully filled (without us noticing). For a vanished buy with a new
   *     position: filled. For a vanished sell with no position remaining: filled → record trade.
   *  5. Cancel any orphan orders on PM that don't match strategy intent (e.g. multiple stale
   *     buys from prior session — keep newest, cancel rest).
   *  6. Recompute cycle.cyclePhase from the synced state.
   */
  private async reconcileWithPolymarket(side: Btc15mAutoSide): Promise<void> {
    const market = this.state.market;
    if (!market || !this.runtime.getLiveStateForAsset) return;
    const tokenId = this.tokenFor(side, market);
    const tag = side.toUpperCase();
    const cycle = this.cycleFor(side);

    let live: Awaited<ReturnType<NonNullable<typeof this.runtime.getLiveStateForAsset>>>;
    try {
      live = await this.runtime.getLiveStateForAsset(tokenId);
    } catch (error) {
      this.pushLog(`[${tag}] Reconcile: failed to fetch live state: ${error instanceof Error ? error.message : String(error)}`, "warn");
      return;
    }

    const livePosition = live.position;
    const liveBuys = live.openOrders.filter((o) => o.side === "buy");
    const liveSells = live.openOrders.filter((o) => o.side === "sell");

    // ---- 1. POSITION reconcile ----
    if (livePosition && livePosition.size > 0) {
      if (!cycle.position) {
        const avgEntryPrice = this.estimatePositionAvgPrice(side, livePosition.avgPrice, this.priceFor(side) ?? this.config.minBuyPrice);
        // Adopt unknown position. If PM doesn't provide avgPrice, use the current side price
        // instead of zero so trailing stop / PnL logic doesn't operate on nonsense.
        cycle.position = {
          bettingSide: side,
          tokenId,
          shares: livePosition.size,
          avgEntryPrice,
          costBasisUsd: roundUsd(livePosition.size * avgEntryPrice),
        };
        cycle.highWaterMark = avgEntryPrice;
        cycle.trailStopPrice = roundUsd(Math.max(0.01, avgEntryPrice - this.config.trailDist));
        cycle.cyclePhase = "holding";
        this.pushLog(`[${tag}] Reconcile: adopted external position ${livePosition.size} sh @ $${avgEntryPrice.toFixed(4)}.`, "warn");
        // Subscribe to book so reconcileHolding can read bestBid for trailing.
        this.subscribeBook(tokenId);
      } else if (Math.abs(cycle.position.shares - livePosition.size) > 0.01) {
        // Size drifted (partial sell happened externally). Sync.
        this.pushLog(`[${tag}] Reconcile: position size drift ${cycle.position.shares} → ${livePosition.size}. Updating.`, "warn");
        cycle.position.shares = livePosition.size;
        cycle.position.costBasisUsd = roundUsd(livePosition.size * cycle.position.avgEntryPrice);
      }
    } else {
      // PM has no position.
      if (cycle.position) {
        // We thought we had one. Either it was sold externally OR our previous sell completed without us seeing.
        // If we had a sell order whose orderId matches one on PM that's now matched → record trade.
        // Otherwise clear silently (likely manual sell).
        const lastSellId = cycle.sellOrder?.orderId;
        if (lastSellId && this.runtime.getTradesForOrder) {
          const agg = await this.aggregateTrades(lastSellId, side, "SELL");
          if (agg && agg.totalShares > 0) {
            this.pushLog(`[${tag}] Reconcile: position closed via SELL ${lastSellId}. Recording trade.`, "info");
            await this.handleSellFill(side, agg.avgPrice, cycle.cyclePhase === "force_selling" ? "force_sell" : "target_sell");
            return;
          }
        }
        this.pushLog(`[${tag}] Reconcile: position vanished on Polymarket without a matching sell trade. Clearing local (likely external sale).`, "warn");
        cycle.position = null;
        cycle.highWaterMark = null;
        cycle.trailStopPrice = null;
        // Don't lose track of sell order — handled below.
      }
    }

    // ---- 2. BUY ORDER reconcile ----
    // Keep newest live buy (latest by id sort) as the "tracked" one; cancel rest as orphans.
    if (liveBuys.length > 0) {
      const liveBuy = liveBuys[liveBuys.length - 1]; // arbitrary "newest" pick
      const expectedOrderId = cycle.buyOrder?.orderId;
      if (!cycle.buyOrder || cycle.buyOrder.orderId !== liveBuy.id) {
        // Adopt
        cycle.buyOrder = {
          id: randomUUID(),
          orderId: liveBuy.id,
          side: "buy",
          tokenId,
          bettingSide: side,
          price: liveBuy.price,
          size: liveBuy.originalSize,
          filledSize: liveBuy.matchedSize,
          status: "open",
          reservedBudget: 0,  // can't easily reconstruct; future placements still consume budget correctly
          createdAt: this.runtime.now(),
          updatedAt: this.runtime.now(),
        };
        cycle.cyclePhase = livePosition ? "holding" : "buy_pending";
        this.pushLog(`[${tag}] Reconcile: adopted external BUY order ${liveBuy.id} @ $${liveBuy.price.toFixed(4)} (size ${liveBuy.originalSize}).`, "warn");
      }
      // Cancel orphan duplicates
      for (let i = 0; i < liveBuys.length - 1; i++) {
        const orphan = liveBuys[i];
        if (orphan.id !== expectedOrderId) {
          this.pushLog(`[${tag}] Reconcile: cancelling orphan BUY ${orphan.id} @ $${orphan.price.toFixed(4)}.`, "warn");
          try { await this.runtime.cancelOrder(orphan.id); } catch { /* best-effort */ }
        }
      }
    } else if (cycle.buyOrder) {
      // PM has no buy. Either filled (position appeared above) or cancelled externally.
      if (livePosition && !cycle.position) {
        // already handled in position adopt
      } else {
        const vanishedBuy = cycle.buyOrder;
        if (vanishedBuy.orderId && this.runtime.getTradesForOrder) {
          const aggregated = await this.aggregateTrades(vanishedBuy.orderId, side, "BUY");
          if (aggregated && aggregated.totalShares > 0) {
            this.pushLog(`[${tag}] Reconcile: tracked BUY ${vanishedBuy.orderId} disappeared from open orders but has trade matches. Adopting filled position.`, "info");
            await this.applyRecoveredBuyFill(side, {
              tokenId,
              shares: aggregated.totalShares,
              avgEntryPrice: aggregated.avgPrice,
              buyFeeUsd: aggregated.totalFeeUsd,
              reservedBudget: vanishedBuy.reservedBudget,
              now: this.runtime.now(),
            });
            return;
          }
        }
        const recentTrade = await this.findRecentAccountTrade({
          tokenId,
          side: "BUY",
          notBeforeMs: (vanishedBuy.createdAt ?? this.runtime.now()) - 10_000,
          expectedSize: vanishedBuy.size,
        });
        if (recentTrade) {
          this.pushLog(`[${tag}] Reconcile: tracked BUY ${vanishedBuy.orderId} disappeared from open orders but recent account BUY trade exists. Adopting filled position.`, "warn");
          await this.applyRecoveredBuyFill(side, {
            tokenId,
            shares: Number(recentTrade.size),
            avgEntryPrice: Number(recentTrade.price),
            buyFeeUsd: computeTradeFeeUsd(Number(recentTrade.size), Number(recentTrade.price), recentTrade.fee_rate_bps),
            reservedBudget: vanishedBuy.reservedBudget,
            now: this.runtime.now(),
          });
          return;
        }
        // Filled into existing position (handled by position size adopt) or external cancel.
        this.pushLog(`[${tag}] Reconcile: tracked BUY ${cycle.buyOrder.orderId} is no longer open on Polymarket. Clearing local.`, "info");
        // Release reserved budget (if we held any)
        if (cycle.buyOrder.reservedBudget > 0) {
          await this.runtime.budget.release(cycle.buyOrder.reservedBudget, `btc15mAuto-${side}-reconcile-clear`);
        }
        cycle.buyOrder = null;
      }
    }

    // ---- 3. SELL ORDER reconcile ----
    if (liveSells.length > 0) {
      const liveSell = liveSells[liveSells.length - 1];
      const expectedOrderId = cycle.sellOrder?.orderId;
      if (!cycle.sellOrder || cycle.sellOrder.orderId !== liveSell.id) {
        cycle.sellOrder = {
          id: randomUUID(),
          orderId: liveSell.id,
          side: "sell",
          tokenId,
          bettingSide: side,
          price: liveSell.price,
          size: liveSell.originalSize,
          filledSize: liveSell.matchedSize,
          status: "open",
          reservedBudget: 0,
          createdAt: this.runtime.now(),
          updatedAt: this.runtime.now(),
        };
        if (cycle.cyclePhase !== "force_selling") cycle.cyclePhase = "holding";
        this.pushLog(`[${tag}] Reconcile: adopted external SELL order ${liveSell.id} @ $${liveSell.price.toFixed(4)} (size ${liveSell.originalSize}).`, "warn");
      }
      // Cancel orphan duplicates
      for (let i = 0; i < liveSells.length - 1; i++) {
        const orphan = liveSells[i];
        if (orphan.id !== expectedOrderId) {
          this.pushLog(`[${tag}] Reconcile: cancelling orphan SELL ${orphan.id} @ $${orphan.price.toFixed(4)}.`, "warn");
          try { await this.runtime.cancelOrder(orphan.id); } catch { /* best-effort */ }
        }
      }
    } else if (cycle.sellOrder) {
      this.pushLog(`[${tag}] Reconcile: tracked SELL ${cycle.sellOrder.orderId} is no longer open on Polymarket. Clearing local.`, "info");
      cycle.sellOrder = null;
    }

    // ---- 4. PHASE recompute ----
    // Derive cyclePhase from synced execution state, preserving in-flight phases.
    if (cycle.position) {
      if (cycle.cyclePhase !== "force_selling") cycle.cyclePhase = "holding";
    } else if (cycle.buyOrder) {
      cycle.cyclePhase = "buy_pending";
    } else if (cycle.cyclePhase === "holding" || cycle.cyclePhase === "force_selling" || cycle.cyclePhase === "buy_pending") {
      cycle.cyclePhase = "waiting_direction";
    }
  }

  async start(options: Btc15mAutoBotStartOptions = {}): Promise<void> {
    if (this.state.enginePhase === "running") {
      return;
    }

    this.state.enginePhase = "running";
    this.state.lastError = null;
    this.pushLog(`BTC 15m Auto bot started (${this.dryRun ? "SIM" : "LIVE"}).`, "success");
    await this.runtime.persistConfig(this.config);
    if (!this.dryRun) {
      await this.runtime.startUserWs((msg) => {
        this.trackAction(this.handleUserWsMessage(msg));
      });
    }
    this.touch();
    if (options.runImmediateTick !== false) {
      await this.runOneTick();
    }
    if (options.scheduleLoop !== false && this.state.enginePhase === "running") {
      this.tickTimer = (this.runtime.setIntervalFn ?? setInterval)(() => {
        void this.runOneTick();
      }, Math.max(500, this.config.tickIntervalSec * 1000));
    }
  }

  async stop(): Promise<void> {
    if (this.tickTimer) {
      (this.runtime.clearIntervalFn ?? clearInterval)(this.tickTimer);
      this.tickTimer = null;
    }
    for (const tokenId of this.subscribedTokens) {
      this.runtime.onMarketBookUnsubscribe(tokenId);
    }
    this.subscribedTokens.clear();
    this.bookSnapshots.clear();
    if (!this.dryRun) {
      // Cancel any open orders BEFORE we mark stopped and persist — guarantees that
      // when the HTTP /stop response returns, the persisted state shows no live orders.
      try {
        await this.cancelOpenOrders("bot-stopped");
      } catch (error) {
        // best-effort: even if Polymarket cancel fails, we still want to mark stopped locally
        this.pushLog(`cancelOpenOrders during stop failed: ${error instanceof Error ? error.message : String(error)}`, "warn");
      }
      this.runtime.stopUserWs();
    }
    this.state.enginePhase = "stopped";
    this.pushLog("BTC 15m Auto bot stopped.", "info");
    this.touch();
    await this.persistRuntimeState();
  }

  async flushPendingActions(): Promise<void> {
    while (this.pendingActions.length > 0) {
      const pending = this.pendingActions.splice(0);
      await Promise.all(pending);
    }
  }

  async runOneTick(): Promise<void> {
    if (this.state.enginePhase !== "running" || this.tickInProgress) {
      return;
    }

    this.tickInProgress = true;
    try {
      const now = this.runtime.now();
      const resolvedMarket = await this.runtime.resolveMarket();
      if (!resolvedMarket) {
        this.state.market = null;
        this.state.upCycle = emptyCycle();
        this.state.downCycle = emptyCycle();
        this.touch();
        await this.refreshBudget();
        await this.persistRuntimeState();
        return;
      }

      if (!this.state.market || this.state.market.slug !== resolvedMarket.slug || now >= this.state.market.endTimeMs) {
        await this.switchMarket(resolvedMarket);
      }

      const market = this.state.market;
      if (!market) {
        return;
      }

      this.state.currentBtcPrice = await this.runtime.fetchBtcPrice(now);
      this.syncMarketSubscriptions();
      this.refreshMarketPricesFromSnapshots();
      await this.refreshBudget();

      // Run the full per-side pipeline for UP and DOWN independently (parallel cycles, shared budget).
      for (const side of Btc15mAutoBot.SIDES) {
        await this.runSidePipeline(side, now);
      }

      this.touch();
      await this.refreshBudget();
      await this.persistRuntimeState();
    } catch (error) {
      this.fail(error, "BTC 15m Auto bot tick failed");
      await this.persistRuntimeState();
    } finally {
      this.tickInProgress = false;
    }
  }

  /** Run the full phase pipeline for one side (UP or DOWN). */
  private async runSidePipeline(side: Btc15mAutoSide, now: number): Promise<void> {
    // LIVE: reconcile local cycle state against Polymarket reality BEFORE strategy runs.
    // The bot must not invent state — orders + positions are read fresh every tick.
    // Strategy-only state (planned-buy, trail levels, highWaterMark) is preserved across ticks.
    if (!this.dryRun) {
      await this.reconcileWithPolymarket(side);
    }

    const cycle = this.cycleFor(side);

    if (cycle.cyclePhase === "waiting_market") {
      cycle.cyclePhase = "waiting_direction";
    }

    // Self-heal inconsistent phases caused by crashes/restarts/race conditions in prior sessions.
    if (cycle.cyclePhase === "buy_pending" && !cycle.buyOrder) {
      this.pushLog(`[${side.toUpperCase()}] Self-heal: buy_pending but buyOrder=null — reset to waiting_direction.`, "warn");
      cycle.cyclePhase = "waiting_direction";
    }
    if (cycle.cyclePhase === "holding" && !cycle.position) {
      this.pushLog(`[${side.toUpperCase()}] Self-heal: holding but position=null — reset to waiting_direction.`, "warn");
      cycle.cyclePhase = "waiting_direction";
    }
    if (cycle.cyclePhase === "force_selling" && !cycle.position) {
      this.pushLog(`[${side.toUpperCase()}] Self-heal: force_selling but position=null — reset to market_idle.`, "warn");
      cycle.cyclePhase = "market_idle";
      cycle.sellOrder = null;
    }

    if (cycle.cyclePhase === "buy_pending") {
      await this.reconcilePendingBuy(side, now);
    }

    if (this.cycleFor(side).cyclePhase === "holding") {
      await this.reconcileHolding(side, now);
    }

    if (this.cycleFor(side).cyclePhase === "cycle_done") {
      this.decideRepeat(side, now);
      return;
    }

    if (this.cycleFor(side).cyclePhase === "waiting_direction") {
      await this.maybePlaceBuy(side);
    }
  }

  private async switchMarket(market: Btc15mAutoMarketView): Promise<void> {
    await this.cancelOpenOrders("market-switch");
    this.state.market = market;
    this.state.marketStartBtcPrice = await this.runtime.fetchBtcPrice(market.startTimeMs);
    this.state.currentBtcPrice = null;
    this.state.upPrice = null;
    this.state.downPrice = null;
    for (const side of Btc15mAutoBot.SIDES) {
      const fresh = emptyCycle();
      fresh.cyclePhase = "waiting_direction";
      this.setCycleFor(side, fresh);
    }
    this.pushLog(`Switched to market ${market.slug}.`, "info");
    this.touch();
  }

  private async maybePlaceBuy(side: Btc15mAutoSide): Promise<void> {
    const market = this.state.market;
    if (!market) {
      return;
    }
    const cycle = this.cycleFor(side);
    const tag = side.toUpperCase();

    // Time-gating: don't open a new cycle if we're already in the force-sell zone
    // (we'd just buy and immediately force-sell at a loss) or below the repeat threshold
    // (not enough time for a meaningful trade).
    const now = this.runtime.now();
    const timeToEndMs = market.endTimeMs - now;
    const repeatThresholdMs = this.config.repeatThresholdMin * 60_000;
    const forceSellThresholdMs = this.config.forceSellThresholdMin * 60_000;
    const minRequiredMs = Math.max(repeatThresholdMs, forceSellThresholdMs);
    if (timeToEndMs < minRequiredMs) {
      // Mark idle so we don't keep retrying every tick.
      cycle.cyclePhase = "market_idle";
      this.pushLog(`[${tag}] Skipping new cycle: ${(timeToEndMs / 60_000).toFixed(1)}min left < required ${(minRequiredMs / 60_000).toFixed(1)}min.`, "info");
      return;
    }

    // The btc15m-auto strategy is purely orderbook-driven (planned-buy anchored to lowest seen
    // marketPrice + trailDist on each token, per side). It does NOT need to gate on BTC delta —
    // UP and DOWN cycles operate independently from the spot price direction. The neutralZoneUsd
    // config remains on the type for backward-compatibility with other bots / persisted state
    // but is intentionally unused here.
    const bettingSide = side;
    const tokenId = this.tokenFor(side, market);

    const book = this.getFreshBookSnapshot(tokenId);
    const marketPrice = book?.bestAsk ?? book?.bestBid ?? null;
    if (book?.bestAsk === null || book?.bestAsk === undefined || marketPrice === null) {
      return;
    }

    if (marketPrice < this.config.minBuyPrice) {
      cycle.plannedBuyPrice = null;
      cycle.plannedBuyAnchorPrice = null;
      cycle.buyBlockReason = "low_range";
      cycle.buyBlockReferencePrice = null;
      return;
    }

    // Post-cancel cooldown: if reconcilePendingBuy cancelled a stale buy (market moved away),
    // it sets high_wait_pullback with the referencePrice = where market ran off to. We must
    // wait until market drops by at least `trailStep` from that peak before re-arming. While
    // waiting we still update the reference if market climbs further (track new peaks).
    if (cycle.buyBlockReason === "high_wait_pullback" && cycle.buyBlockReferencePrice !== null) {
      const ref = cycle.buyBlockReferencePrice;
      if (marketPrice > ref) {
        // Market kept climbing — bump the reference.
        cycle.buyBlockReferencePrice = marketPrice;
        return;
      }
      if (ref - marketPrice < this.config.trailStep) {
        // Not enough pullback yet — keep waiting.
        return;
      }
      // Pulled back by ≥ trailStep — clear the block and proceed with fresh anchoring.
      this.pushLog(`[${tag}] Pullback satisfied: peak ${ref.toFixed(4)} → ${marketPrice.toFixed(4)} (Δ=${(ref - marketPrice).toFixed(4)} ≥ ${this.config.trailStep}). Re-arming buy.`, "info");
      cycle.buyBlockReason = null;
      cycle.buyBlockReferencePrice = null;
    }

    if (marketPrice > this.config.maxBuyPrice) {
      const highRef = Math.max(cycle.buyBlockReferencePrice ?? marketPrice, marketPrice);
      cycle.buyBlockReason = "high_wait_pullback";
      cycle.buyBlockReferencePrice = highRef;
      cycle.plannedBuyPrice = null;
      cycle.plannedBuyAnchorPrice = null;
      if (highRef - marketPrice < this.config.trailStep) {
        return;
      }
      if (marketPrice > this.config.maxBuyPrice) {
        return;
      }
    }

    const previousAnchor = cycle.plannedBuyAnchorPrice;
    const hasAnchor = previousAnchor !== null && previousAnchor !== undefined;
    const nextAnchor = !hasAnchor || marketPrice < previousAnchor
      ? marketPrice
      : previousAnchor;
    const previousPlannedBuyPrice = cycle.plannedBuyPrice;
    const plannedBuyPrice = roundUsd(nextAnchor + this.config.trailDist);
    const guardedPlannedBuyPrice = previousPlannedBuyPrice !== null && previousPlannedBuyPrice !== undefined
      ? Math.min(previousPlannedBuyPrice, plannedBuyPrice)
      : plannedBuyPrice;

    cycle.buyBlockReason = null;
    cycle.buyBlockReferencePrice = null;

    if (!hasAnchor || marketPrice <= nextAnchor) {
      cycle.plannedBuyAnchorPrice = nextAnchor;
      cycle.plannedBuyPrice = guardedPlannedBuyPrice;
      return;
    }

    if (marketPrice < guardedPlannedBuyPrice) {
      cycle.plannedBuyAnchorPrice = nextAnchor;
      cycle.plannedBuyPrice = guardedPlannedBuyPrice;
      return;
    }

    const stake = roundUsd(this.config.buyAmountUsd);
    const buySize = roundShares(stake / marketPrice);
    if (!(buySize > 0)) {
      this.pushLog(`[${tag}] Skip buy: computed size is 0 for $${stake.toFixed(2)} at ${formatPrice(marketPrice)}.`, "warn");
      return;
    }
    try {
      await this.runtime.budget.reserve(stake, `btc15mAuto-${side}-cycle-buy`);
    } catch (error) {
      // With two parallel sides sharing one budget, a reserve failure here can mean either:
      //  (a) the OTHER side just grabbed the last slice (transient — will free up after that side
      //      consumes/releases/sells), OR
      //  (b) real exhaustion (every cycle lost and the pool is drained).
      // Auto-stopping on (a) would force the user to manually restart after every contention.
      // Instead: log and skip THIS tick. The side stays in waiting_direction and retries next tick.
      // If it's truly (b), the warning will repeat persistently and the user can stop manually.
      const msg = error instanceof Error ? error.message : String(error);
      this.pushLog(`[${tag}] Skip buy: budget reserve failed (${msg}). Will retry next tick.`, "warn");
      return;
    }

    let response: unknown;
    try {
      response = await this.runtime.placeLimitOrder({
        tokenId,
        side: "buy",
        price: marketPrice,
        size: buySize,
      });
    } catch (error) {
      // Polymarket rejected the order (or the request failed). Release the reservation we made
      // above so the budget doesn't leak, and stay in waiting_direction so the next tick retries.
      const msg = error instanceof Error ? error.message : String(error);
      await this.runtime.budget.release(stake, `btc15mAuto-${side}-place-failed`);
      this.pushLog(`[${tag}] BUY placement failed: ${msg}. Released $${stake.toFixed(2)} reserve.`, "error");
      return;
    }
    const extractedOrderId = extractOrderId(response);
    // If Polymarket accepted the order (success validation passed in placeLimitOrder) but the
    // response shape doesn't yield a parseable orderID, abort instead of inventing a sentinel.
    // A sentinel makes polling/WS detection impossible (no real ID to match against), which
    // historically led to phantom positions when polling 404'd on the sentinel.
    if (!extractedOrderId) {
      const recovered = await this.recoverBuySubmissionWithoutOrderId(
        side,
        tokenId,
        marketPrice,
        buySize,
        stake,
        now,
      );
      if (recovered) {
        this.pushLog(
          `[${tag}] BUY trigger ${formatPrice(guardedPlannedBuyPrice)} hit; recovered live submission @ ${formatPrice(marketPrice)}.`,
          "warn",
        );
        return;
      }
      await this.runtime.budget.release(stake, `btc15mAuto-${side}-no-order-id`);
      this.pushLog(`[${tag}] BUY response had no orderID and no live order/position was found. Released reserve.`, "error");
      return;
    }
    const orderId = extractedOrderId;
    this.setCycleFor(side, {
      ...cycle,
      cyclePhase: "buy_pending",
      cycleStartedAt: cycle.cycleStartedAt ?? now,
      buyOrder: {
        id: randomUUID(),
        orderId,
        side: "buy",
        tokenId,
        bettingSide,
        price: marketPrice,
        size: buySize,
        filledSize: 0,
        status: "open",
        reservedBudget: stake,
        createdAt: now,
        updatedAt: now,
      },
      plannedBuyPrice: null,
      plannedBuyAnchorPrice: null,
      buyBlockReason: null,
      buyBlockReferencePrice: null,
    });
    this.pushLog(
      `[${tag}] BUY trigger ${formatPrice(guardedPlannedBuyPrice)} hit; submitted @ ${formatPrice(marketPrice)} (${orderId}).`,
      "info",
    );
    if (this.dryRun) {
      this.subscribeBook(tokenId);
    }
  }

  private async reconcilePendingBuy(side: Btc15mAutoSide, now: number): Promise<void> {
    const market = this.state.market;
    const cycle = this.cycleFor(side);
    const buyOrder = cycle.buyOrder;
    if (!market || !buyOrder) {
      return;
    }
    const tag = side.toUpperCase();

    // Polling fallback FIRST: check order status via API to catch missed WS fills.
    // Must run before any cancel logic so we don't discard already-filled orders.
    if (!this.dryRun && this.runtime.getOrder && buyOrder.orderId) {
      if (now - this.lastOrderPollMs[side] >= this.orderPollIntervalMs) {
        this.lastOrderPollMs[side] = now;
        try {
          const orderData = await this.runtime.getOrder(buyOrder.orderId);
          if (orderData) {
            const statusLower = (orderData.status ?? "").toLowerCase();
            const matched = parseFloat(orderData.size_matched) || 0;
            const original = parseFloat(orderData.original_size ?? String(buyOrder.size)) || buyOrder.size;
            const fullyFilled = matched >= original - 1e-9 && matched > 0;
            const statusFilled = isFilledStatus(statusLower);
            // NOTE: We deliberately do NOT treat a "not_found" (404) response as a fill anymore.
            // Polymarket returns 404 in TWO very different cases:
            //   (a) order was matched and archived → really filled
            //   (b) order was rejected at placement or never existed → NOT filled
            // (b) would cause phantom positions in the UI (bot thinks it bought, Polymarket has
            // nothing). Since `success` is now validated at placement time, a missing order
            // here means it never existed → don't fake a fill. We rely on size_matched and
            // explicit status only.
            if (statusFilled || fullyFilled) {
              const filledSize = matched > 0 ? matched : buyOrder.size;
              this.pushLog(`[${tag}] Buy fill detected via polling (status: ${orderData.status}, matched: ${matched}/${original}).`, "info");
              await this.transitionBuyFilledToHolding(side, filledSize);
              return; // Already transitioned — skip cancel checks below
            } else if (isFailureStatus(statusLower) || statusLower === "not_found") {
              this.pushLog(`[${tag}] Buy order ${statusLower === "not_found" ? "not found on Polymarket" : "failed"} (status: ${orderData.status}). Cancelling local tracking.`, "warn");
              await this.cancelBuy(side, `poll-${orderData.status}`);
              cycle.cyclePhase = "waiting_direction";
              return;
            }
          }
        } catch {
          // polling is best-effort, swallow errors
        }
      }
    }

    const livePrice = this.priceFor(side);
    if (livePrice !== null && livePrice > buyOrder.price) {
      await this.cancelBuy(side, `missed-breakout (${livePrice.toFixed(2)} > ${buyOrder.price.toFixed(2)})`);
      cycle.cyclePhase = "waiting_direction";
      // Reset planning AND require a pullback before re-arming. Without this guard, maybePlaceBuy
      // would immediately re-place at the stale planned price (anchor stays low → planned stays
      // low → market still above → re-place → cancel → loop). Set high_wait_pullback so the
      // next maybePlaceBuy waits until market drops by at least `trailStep` from this peak.
      cycle.plannedBuyPrice = null;
      cycle.plannedBuyAnchorPrice = null;
      cycle.buyBlockReason = "high_wait_pullback";
      cycle.buyBlockReferencePrice = livePrice;
      return;
    }

    const timeToEndMs = market.endTimeMs - now;
    if (timeToEndMs < this.config.forceSellThresholdMin * 60_000 && !cycle.position) {
      await this.cancelBuy(side, "late-market");
      cycle.cyclePhase = "market_idle";
      return;
    }

    // btc15m-auto is orderbook-driven, not BTC-direction-driven — we do not cancel a pending buy
    // just because BTC drifted into a neutral zone. The buy stays armed until either filled,
    // breakout (`livePrice > buyOrder.price` handled above), or the late-market cutoff.
  }

  private async reconcileHolding(side: Btc15mAutoSide, now: number): Promise<void> {
    const market = this.state.market;
    const cycle = this.cycleFor(side);
    const position = cycle.position;
    if (!market || !position) {
      return;
    }
    const tag = side.toUpperCase();

    // Poll the SELL order BEFORE running trail/force-sell logic. The WS user-channel can
    // miss "matched" events (Polymarket sometimes drops them under load), and without this
    // polling our local sellOrder stays "open" forever even after the real Polymarket order
    // was filled or rejected. That stalled the cycle: bot kept waiting for a fill that already
    // happened OR for a sell that was never accepted.
    if (!this.dryRun && cycle.sellOrder && cycle.sellOrder.orderId && this.runtime.getOrder) {
      if (now - this.lastOrderPollMs[side] >= this.orderPollIntervalMs) {
        this.lastOrderPollMs[side] = now;
        try {
          const data = await this.runtime.getOrder(cycle.sellOrder.orderId);
          if (data) {
            const statusLower = (data.status ?? "").toLowerCase();
            const matched = parseFloat(data.size_matched) || 0;
            const original = parseFloat(data.original_size ?? String(cycle.sellOrder.size)) || cycle.sellOrder.size;
            const fullyFilled = matched >= original - 1e-9 && matched > 0;
            const statusFilled = isFilledStatus(statusLower);

            if (statusFilled || fullyFilled) {
              this.pushLog(`[${tag}] SELL fill detected via polling (matched ${matched}/${original}, status=${data.status}).`, "info");
              await this.handleSellFill(
                side,
                cycle.sellOrder.price,
                cycle.cyclePhase === "force_selling" ? "force_sell" : "target_sell",
              );
              return; // cycle is now closed — nothing else to do this tick
            } else if (isFailureStatus(statusLower) || statusLower === "not_found") {
              this.pushLog(`[${tag}] SELL ${statusLower === "not_found" ? "not found on Polymarket" : "failed"} (status=${data.status}). Clearing local tracking; will re-place.`, "warn");
              cycle.sellOrder = null;
              // Fall through to trail logic — it will place a fresh sell next iteration.
            }
            // else: still open — fall through to trail/force-sell logic which may update price.
          }
        } catch {
          // best-effort; trail/force-sell still runs below
        }
      }
    }

    const snap = this.getFreshBookSnapshot(position.tokenId);
    const bestBid = snap?.bestBid ?? null;
    const bestAsk = snap?.bestAsk ?? null;
    const timeToEndMs = market.endTimeMs - now;
    if (bestBid === null && bestAsk === null) {
      this.pushLog(`[${tag}] Waiting for fresh websocket book before managing position.`, "warn");
      return;
    }

    const isLateForceSellWindow = timeToEndMs < this.config.forceSellThresholdMin * 60_000;

    // --- TRAILING STOP LOGIC ---
    // Trail off the SAME price the UI shows for this side (bestAsk-preferred), so STOP SELL is
    // always exactly trailDist below the side price at a fresh high.
    const refPrice = bestAsk ?? bestBid;
    const highWaterMark = cycle.highWaterMark ?? position.avgEntryPrice;
    if (refPrice !== null && refPrice > highWaterMark) {
      const cooldownOk =
        this.dryRun || now - this.lastTrailUpdateMs[side] >= this.config.trailUpdateIntervalSec * 1000;
      if (cooldownOk) {
        cycle.highWaterMark = refPrice;
        const nextTrailStopPrice = roundUsd(refPrice - this.config.trailDist);
        const currentTrailStopPrice = cycle.trailStopPrice;
        cycle.trailStopPrice = currentTrailStopPrice !== null && currentTrailStopPrice !== undefined
          ? Math.max(currentTrailStopPrice, nextTrailStopPrice)
          : nextTrailStopPrice;
        this.lastTrailUpdateMs[side] = now;
        this.pushLog(`[${tag}] Trail stop moved to ${formatPrice(cycle.trailStopPrice)} (price ${formatPrice(refPrice)}).`, "info");
      }
    }

    const trailStopPrice = cycle.trailStopPrice;
    if (!isLateForceSellWindow && bestBid !== null && trailStopPrice !== null && bestBid <= trailStopPrice) {
      // The whole point of a stop is to EXIT NOW. If we place a sell at `trailStopPrice` while
      // the current bid is below it, the limit sells sits above the bid and never fills — the
      // bot then waits forever while the price keeps dropping. Cross the spread by selling
      // INTO the current bid (so the sell matches immediately against the existing buy offer).
      // Also fetch a fresh book here in LIVE: WS bookSnapshots can be stale by hundreds of ms,
      // and a stop-out at a stale price is the worst time to hesitate.
      const exitBid: number | null = bestBid;
      // Sell INTO the bid (cross-the-spread). Clamp to ≥ 0.01 (Polymarket min tick).
      const liveExitPrice = exitBid !== null && exitBid > 0 ? exitBid : 0.01;
      // Anti-spam: if an existing sell is already at or below the current bid, it SHOULD fill
      // via Polymarket matching — re-placing every tick would just cancel/replace API spam.
      // Only re-place when the existing sell is ABOVE the bid (so it can't fill passively).
      if (cycle.sellOrder && cycle.sellOrder.price <= liveExitPrice + 1e-9) {
        // existing sell is competitive; let it sit. Polling will detect a real fill.
        return;
      }
      this.pushLog(`[${tag}] Trail stop triggered. Stop=${formatPrice(trailStopPrice)}, bid=${formatPrice(exitBid ?? 0)} → selling at ${formatPrice(liveExitPrice)} (cross-spread).`, "warn");
      // Cancel the stale higher-priced sell before placing the fresh cross-spread one.
      if (cycle.sellOrder) {
        await this.cancelSellOrderApi(side);
      }
      await this.placeSell(side, liveExitPrice, "holding");
      if (this.dryRun) {
        await this.handleSellFill(side, liveExitPrice, "target_sell");
      }
      return;
    }

    // --- FORCE SELL ---
    if (!isLateForceSellWindow) {
      return;
    }
    const liveBid: number | null = bestBid;
    const forceSellPrice = liveBid !== null && liveBid > 0 ? liveBid : 0.01;
    await this.cancelSellOrderApi(side);
    this.pushLog(`[${tag}] Force-sell at ${formatPrice(forceSellPrice)} (live bid: ${liveBid ?? "n/a"}).`, "warn");
    await this.placeSell(side, forceSellPrice, "force_selling");
    if (this.dryRun) {
      await this.handleSellFill(side, forceSellPrice, "force_sell");
    }
  }

  private async cancelSellOrderApi(side: Btc15mAutoSide): Promise<void> {
    const cycle = this.cycleFor(side);
    const sellOrder = cycle.sellOrder;
    if (!sellOrder) return;
    if (sellOrder.orderId) {
      try {
        await this.runtime.cancelOrder(sellOrder.orderId);
      } catch {
      }
    }
    cycle.sellOrder = null;
  }

  private decideRepeat(side: Btc15mAutoSide, now: number): void {
    const market = this.state.market;
    if (!market) {
      this.setCycleFor(side, emptyCycle());
      return;
    }
    const cycle = this.cycleFor(side);

    // Safety: never repeat if position or sell order still open
    if (cycle.position !== null || cycle.sellOrder !== null) {
      this.pushLog(`[${side.toUpperCase()}] Cycle not fully closed; skipping repeat (safety guard).`, "warn");
      cycle.cyclePhase = "market_idle";
      return;
    }

    if (market.endTimeMs - now > this.config.repeatThresholdMin * 60_000) {
      const fresh = emptyCycle();
      fresh.cyclePhase = "waiting_direction";
      this.setCycleFor(side, fresh);
      return;
    }

    cycle.cyclePhase = "market_idle";
  }

  private async cancelBuy(side: Btc15mAutoSide, reason: string): Promise<void> {
    const cycle = this.cycleFor(side);
    const buyOrder = cycle.buyOrder;
    if (!buyOrder) {
      return;
    }

    if (buyOrder.orderId) {
      try {
        await this.runtime.cancelOrder(buyOrder.orderId);
      } catch {
        // Order may already be gone.
      }
    }

    await this.runtime.budget.release(buyOrder.reservedBudget, reason);
    this.runtime.onMarketBookUnsubscribe(buyOrder.tokenId);
    this.subscribedTokens.delete(buyOrder.tokenId);
    cycle.buyOrder = null;
    this.pushLog(`[${side.toUpperCase()}] BUY cancelled (${reason}).`, "warn");
  }

  /** Cancel any open buy/sell orders on BOTH sides (used on stop / market-switch). */
  private async cancelOpenOrders(reason: string): Promise<void> {
    for (const side of Btc15mAutoBot.SIDES) {
      const cycle = this.cycleFor(side);
      const { buyOrder, sellOrder } = cycle;
      if (buyOrder) {
        await this.cancelBuy(side, reason);
      }
      if (sellOrder?.orderId) {
        try {
          await this.runtime.cancelOrder(sellOrder.orderId);
        } catch {
          // best effort
        }
      }
      if (sellOrder) {
        this.runtime.onMarketBookUnsubscribe(sellOrder.tokenId);
        this.subscribedTokens.delete(sellOrder.tokenId);
        cycle.sellOrder = null;
      }
    }
  }

  private subscribeBook(tokenId: string): void {
    if (this.subscribedTokens.has(tokenId)) {
      return;
    }
    this.runtime.onMarketBookSubscribe(tokenId, (bestBid, bestAsk) => {
      this.bookSnapshots.set(tokenId, { bestBid, bestAsk, updatedAt: this.runtime.now() });
      const market = this.state.market;
      if (market) {
        if (tokenId === market.upTokenId) {
          this.state.upPrice = bestAsk;
          this.touch();
        } else if (tokenId === market.downTokenId) {
          this.state.downPrice = bestAsk;
          this.touch();
        }
      }
      // In LIVE mode the book listener is ONLY used to populate bookSnapshots (for the trailing
      // stop calculation in reconcileHolding). It must NOT auto-trigger fills — real fills come
      // from the Polymarket user-WS channel and the polling fallback. Auto-firing transitionBuy
      // or handleSellFill on book crossings would mark the position closed locally while the
      // actual Polymarket order is still open → bot state diverges from reality.
      if (!this.dryRun) return;

      const side = this.sideForToken(tokenId);
      if (!side) return;
      const cycle = this.cycleFor(side);

      const buyOrder = cycle.buyOrder;
      if (
        buyOrder &&
        cycle.cyclePhase === "buy_pending" &&
        buyOrder.tokenId === tokenId &&
        bestAsk !== null &&
        bestAsk <= buyOrder.price
      ) {
        this.trackAction(this.transitionBuyFilledToHolding(side, buyOrder.size));
        return;
      }

      const sellOrder = cycle.sellOrder;
      if (
        sellOrder &&
        (cycle.cyclePhase === "holding" || cycle.cyclePhase === "force_selling") &&
        sellOrder.tokenId === tokenId &&
        bestBid !== null &&
        bestBid >= sellOrder.price
      ) {
        const exitReason = cycle.cyclePhase === "force_selling" ? "force_sell" : "target_sell";
        this.trackAction(this.handleSellFill(side, sellOrder.price, exitReason));
      }
    });
    this.subscribedTokens.add(tokenId);
  }

  private async transitionBuyFilledToHolding(side: Btc15mAutoSide, filledSize: number): Promise<void> {
    // Atomic capture-and-transition BEFORE any await. Concurrent WS fill events + polling
    // can both trigger this for the same buy — without atomic clearing both would consume()
    // budget twice and double-create the position.
    const cycle = this.cycleFor(side);
    const buyOrder = cycle.buyOrder;
    if (!buyOrder || cycle.cyclePhase !== "buy_pending") {
      return;
    }
    let shares = normalizeSize(Math.min(filledSize, buyOrder.size));
    let avgPrice = buyOrder.price;
    let buyFeeUsd = 0;
    // Move to "holding" synchronously so concurrent callers see phase != "buy_pending" and bail.
    cycle.cyclePhase = "holding";
    const tokenId = buyOrder.tokenId;
    const orderIdForTrades = buyOrder.orderId;
    cycle.buyOrder = null;

    // In LIVE, fetch real trades for this order to get the TRUE avg fill price and fees.
    // A single limit order can match across multiple counterparties at different prices, so
    // trusting buyOrder.price gives misleading P&L. SIM has no real fills — skip.
    if (!this.dryRun && orderIdForTrades && this.runtime.getTradesForOrder) {
      const aggregated = await this.aggregateTrades(orderIdForTrades, side, "BUY");
      if (aggregated && aggregated.totalShares > 0) {
        shares = roundShares(aggregated.totalShares);
        avgPrice = aggregated.avgPrice;
        buyFeeUsd = aggregated.totalFeeUsd;
        this.pushLog(`[${side.toUpperCase()}] BUY real fill: ${shares.toFixed(2)} sh × $${avgPrice.toFixed(4)} avg, fees $${buyFeeUsd.toFixed(4)}.`, "info");
      }
    }

    const consumed = roundUsd(shares * avgPrice + buyFeeUsd);
    cycle.position = {
      bettingSide: buyOrder.bettingSide,
      tokenId,
      shares,
      avgEntryPrice: roundPrice(avgPrice),
      costBasisUsd: consumed,
    };
    // Track buy fee on the position so handleSellFill can include it in the final P&L.
    (cycle.position as { buyFeeUsd?: number }).buyFeeUsd = buyFeeUsd;
    cycle.highWaterMark = avgPrice;
    cycle.trailStopPrice = roundUsd(Math.max(0.01, avgPrice - this.config.trailDist));

    await this.runtime.budget.consume(consumed, `btc15mAuto-${side}-buy-filled`);
    const reservedAmount = roundUsd(buyOrder.size * buyOrder.price);
    const unfilledBudget = roundUsd(Math.max(0, reservedAmount - consumed));
    if (unfilledBudget > 0) {
      await this.runtime.budget.release(unfilledBudget, `btc15mAuto-${side}-partial-unfilled`);
    }

    this.runtime.onMarketBookUnsubscribe(tokenId);
    this.subscribedTokens.delete(tokenId);
    this.pushLog(`[${side.toUpperCase()}] BUY filled. Holding ${formatSize(shares)} shares @ $${avgPrice.toFixed(4)}.`, "success");
    // Re-subscribe so reconcileHolding receives book updates for the trailing stop.
    this.subscribeBook(tokenId);
    await this.refreshBudget();
    await this.persistRuntimeState();
  }

  /**
   * Fetch all Polymarket trades for an order and aggregate them into total shares, avg price,
   * and total fees in USD. Returns null on failure or no trades. Used by LIVE-only paths to
   * record the TRUE economic outcome of a fill (not just the limit price we placed).
   */
  private async aggregateTrades(
    orderId: string,
    side: Btc15mAutoSide,
    label: "BUY" | "SELL",
  ): Promise<{ totalShares: number; avgPrice: number; totalFeeUsd: number } | null> {
    if (!this.runtime.getTradesForOrder) return null;
    try {
      const trades = await this.runtime.getTradesForOrder(orderId);
      if (!trades || trades.length === 0) return null;
      let totalShares = 0;
      let totalNotional = 0;
      let totalFeeUsd = 0;
      for (const t of trades) {
        const size = t.size;
        const price = t.price;
        if (!Number.isFinite(size) || !Number.isFinite(price) || size <= 0) continue;
        const notional = size * price;
        totalShares += size;
        totalNotional += notional;
        // Polymarket fees are taker-side, applied on notional. fee_rate_bps = basis points (1bp = 0.0001).
        totalFeeUsd += notional * (t.feeRateBps / 10000);
      }
      if (totalShares <= 0) return null;
      return {
        totalShares,
        avgPrice: totalNotional / totalShares,
        totalFeeUsd: roundPrice(totalFeeUsd),
      };
    } catch (error) {
      this.pushLog(`[${side.toUpperCase()}] ${label} aggregateTrades failed: ${error instanceof Error ? error.message : String(error)}`, "warn");
      return null;
    }
  }

  private async placeSell(
    side: Btc15mAutoSide,
    price: number,
    phase: "holding" | "force_selling",
  ): Promise<void> {
    const cycle = this.cycleFor(side);
    const position = cycle.position;
    const market = this.state.market;
    if (!position || !market) {
      return;
    }

    // Polymarket CLOB only accepts prices in [0.01, 0.99] at 0.01 tick.
    const clamped = Math.min(0.99, Math.max(0.01, roundUsd(price)));
    if (clamped !== price) {
      this.pushLog(`[${side.toUpperCase()}] Sell price ${price} clamped to ${clamped} (valid range 0.01–0.99).`, "warn");
    }

    let response: unknown;
    try {
      response = await this.runtime.placeLimitOrder({
        tokenId: position.tokenId,
        side: "sell",
        price: clamped,
        size: position.shares,
      });
    } catch (error) {
      // SELL placement failed — leave the position open (we still hold it). The next tick of
      // reconcileHolding / force-sell will retry. Do NOT mark the position closed.
      const msg = error instanceof Error ? error.message : String(error);
      this.pushLog(`[${side.toUpperCase()}] SELL placement failed: ${msg}. Position kept; will retry.`, "error");
      return;
    }
    const now = this.runtime.now();
    const extractedOrderId = extractOrderId(response);
    if (!extractedOrderId) {
      const recovered = await this.recoverSellSubmissionWithoutOrderId(side, clamped, now);
      if (recovered) {
        this.pushLog(
          `[${side.toUpperCase()}] SELL submission recovered from live state @ ${formatPrice(clamped)}.`,
          "warn",
        );
        return;
      }
      this.pushLog(`[${side.toUpperCase()}] SELL response had no orderID. Position kept; will retry next tick.`, "error");
      return;
    }
    const orderId = extractedOrderId;
    cycle.sellOrder = {
      id: randomUUID(),
      orderId,
      side: "sell",
      tokenId: position.tokenId,
      bettingSide: position.bettingSide,
      price: clamped,
      size: position.shares,
      filledSize: 0,
      status: "open",
      reservedBudget: 0,
      createdAt: now,
      updatedAt: now,
    };
    cycle.cyclePhase = phase;
    this.pushLog(`[${side.toUpperCase()}] SELL @ ${formatPrice(clamped)} submitted (${orderId}).`, "info");
    if (this.dryRun && phase === "holding") {
      this.subscribeBook(position.tokenId);
    }
  }

  private async handleSellFill(
    side: Btc15mAutoSide,
    sellPrice: number,
    exitReason: Btc15mAutoCompletedTrade["exitReason"],
  ): Promise<void> {
    // Atomic capture-and-clear BEFORE any await — guards against concurrent WS/poll fill events.
    const cycle = this.cycleFor(side);
    const position = cycle.position;
    const market = this.state.market;
    const sellOrder = cycle.sellOrder;
    if (!position || !market || !sellOrder) {
      return;
    }
    const sellOrderId = sellOrder.orderId;
    cycle.sellOrder = null;
    cycle.position = null;
    cycle.cyclePhase = "cycle_done";

    // In LIVE, fetch real trades to get the TRUE avg sell price + total fees. One limit sell can
    // match against multiple buyers at different prices ("одна продажа может выполниться
    // несколькими сделками"). Trust Polymarket trades over our intended price.
    let realSellPrice = sellPrice;
    let realShares = position.shares;
    let sellFeeUsd = 0;
    let sellProceedsUsd = roundUsd(sellPrice * position.shares);
    const buyFeeUsd = (position as { buyFeeUsd?: number }).buyFeeUsd ?? 0;
    const buyCostUsd = roundUsd(position.avgEntryPrice * position.shares);

    if (!this.dryRun && sellOrderId && this.runtime.getTradesForOrder) {
      const aggregated = await this.aggregateTrades(sellOrderId, side, "SELL");
      if (aggregated && aggregated.totalShares > 0) {
        realSellPrice = aggregated.avgPrice;
        realShares = roundShares(aggregated.totalShares);
        sellFeeUsd = aggregated.totalFeeUsd;
        sellProceedsUsd = roundUsd(realSellPrice * realShares);
        this.pushLog(`[${side.toUpperCase()}] SELL real fill: ${realShares.toFixed(2)} sh × $${realSellPrice.toFixed(4)} avg, fees $${sellFeeUsd.toFixed(4)}.`, "info");
      }
    }

    // True net P&L: what we got out − what we paid in − fees on both sides.
    const pnlUsd = roundUsd(sellProceedsUsd - buyCostUsd - buyFeeUsd - sellFeeUsd);
    const trade: Btc15mAutoCompletedTrade = {
      id: randomUUID(),
      marketSlug: market.slug,
      bettingSide: position.bettingSide,
      buyPrice: position.avgEntryPrice,
      sellPrice: roundPrice(realSellPrice),
      shares: realShares,
      pnlUsd,
      result: pnlUsd > 0 ? "win" : "loss",
      exitReason,
      startedAt: cycle.cycleStartedAt ?? this.runtime.now(),
      closedAt: this.runtime.now(),
      dryRun: this.dryRun,
      ...(this.dryRun ? {} : {
        buyCostUsd,
        sellProceedsUsd,
        buyFeeUsd: roundUsd(buyFeeUsd),
        sellFeeUsd: roundUsd(sellFeeUsd),
      }),
    };

    // Credit budget with NET proceeds (sell receipts minus sell fee).
    await this.runtime.budget.addFunds(roundUsd(sellProceedsUsd - sellFeeUsd), `btc15mAuto-${side}-sell-filled`);
    if (this.dryRun) {
      this.state.sessionTrades = [...this.state.sessionTrades, trade].slice(-500);
    } else {
      this.state.completedTrades = [...this.state.completedTrades, trade].slice(-500);
      await this.runtime.persistTrade(trade);
    }
    this.runtime.onMarketBookUnsubscribe(position.tokenId);
    this.subscribedTokens.delete(position.tokenId);
    this.pushLog(`${this.dryRun ? "[SIM] " : ""}[${side.toUpperCase()}] SELL filled. PnL ${pnlUsd.toFixed(2)} (${trade.result}).`, trade.result === "win" ? "success" : "warn");
    await this.refreshBudget();
    await this.persistRuntimeState();
  }

  private async handleUserWsMessage(message: ScalperUserWsMessage): Promise<void> {
    if (this.dryRun || this.state.enginePhase !== "running") {
      return;
    }

    // The WS message could belong to either side's buy or sell order — check both cycles.
    for (const side of Btc15mAutoBot.SIDES) {
      const cycle = this.cycleFor(side);

      const buyOrder = cycle.buyOrder;
      if (buyOrder && matchesOrder(message, buyOrder)) {
        if (isFailureStatus(message.status)) {
          await this.cancelBuy(side, `live-${message.status ?? "failed"}`);
          cycle.cyclePhase = "waiting_direction";
          return;
        }
        if (isFilledStatus(message.status)) {
          // VERIFY via REST before trusting the WS event. We've seen Polymarket WS deliver
          // matched-like events when the order was only partially or not actually filled —
          // that previously caused phantom positions (bot shows position, Polymarket doesn't).
          // Now: only transition if getOrder confirms size_matched >= original_size, or the
          // order is genuinely gone (status=matched and size matches). Otherwise log and wait
          // — polling on the next tick will re-check.
          const verified = await this.verifyOrderFilled(buyOrder.orderId, buyOrder.size, side, "BUY");
          if (verified.filled) {
            this.pushLog(`[${side.toUpperCase()}] BUY fill verified via WS+REST (matched ${verified.matched}/${verified.original}).`, "info");
            await this.transitionBuyFilledToHolding(side, verified.matched > 0 ? verified.matched : buyOrder.size);
          } else {
            this.pushLog(`[${side.toUpperCase()}] WS said BUY matched, but REST shows ${verified.matched}/${verified.original} (status=${verified.status}). Ignoring — polling will retry.`, "warn");
          }
          return;
        }
      }

      const sellOrder = cycle.sellOrder;
      if (sellOrder && matchesOrder(message, sellOrder)) {
        if (isFailureStatus(message.status)) {
          sellOrder.status = "failed";
          sellOrder.errorMessage = message.status;
          this.pushLog(`[${side.toUpperCase()}] SELL failed: ${message.status ?? "unknown"}.`, "error");
          return;
        }
        if (isFilledStatus(message.status)) {
          // Same verification for sells — phantom "matched" events on un-filled sells would
          // close the position locally while Polymarket still holds the position (and the
          // open sell order is still sitting on the book).
          const verified = await this.verifyOrderFilled(sellOrder.orderId, sellOrder.size, side, "SELL");
          if (verified.filled) {
            this.pushLog(`[${side.toUpperCase()}] SELL fill verified via WS+REST (matched ${verified.matched}/${verified.original}).`, "info");
            await this.handleSellFill(
              side,
              sellOrder.price,
              cycle.cyclePhase === "force_selling" ? "force_sell" : "target_sell",
            );
          } else {
            this.pushLog(`[${side.toUpperCase()}] WS said SELL matched, but REST shows ${verified.matched}/${verified.original} (status=${verified.status}). Ignoring — polling will retry.`, "warn");
          }
          return;
        }
      }
    }
  }

  /**
   * Confirm via REST `getOrder` that an order is truly filled before we transition state.
   * Returns `filled=true` only when size_matched >= original_size (full match) OR Polymarket
   * explicitly returned a filled status. Treats `not_found` (404) as filled IF the matched-size
   * arg suggests it was a real fill (positive original) — but we are conservative and require
   * size_matched. Treats fetch errors as "not filled" (will retry next tick).
   */
  private async verifyOrderFilled(
    orderId: string | null,
    originalSize: number,
    side: Btc15mAutoSide,
    label: "BUY" | "SELL",
  ): Promise<{ filled: boolean; matched: number; original: number; status: string }> {
    if (!orderId || !this.runtime.getOrder) {
      // Without verification capability, fall back to trusting the WS event (legacy behavior).
      return { filled: true, matched: originalSize, original: originalSize, status: "unverifiable" };
    }
    try {
      const data = await this.runtime.getOrder(orderId);
      if (!data) {
        return { filled: false, matched: 0, original: originalSize, status: "no-data" };
      }
      const matched = parseFloat(data.size_matched) || 0;
      const original = parseFloat(data.original_size ?? String(originalSize)) || originalSize;
      const statusLower = (data.status ?? "").toLowerCase();
      const fullyFilled = matched >= original - 1e-9 && matched > 0;
      const explicit = isFilledStatus(statusLower);
      return { filled: fullyFilled || explicit, matched, original, status: data.status ?? "" };
    } catch (error) {
      this.pushLog(`[${side.toUpperCase()}] ${label} verification getOrder failed: ${error instanceof Error ? error.message : String(error)}`, "warn");
      return { filled: false, matched: 0, original: originalSize, status: "verify-error" };
    }
  }

  private trackAction(promise: Promise<void>): void {
    this.pendingActions.push(promise);
    promise.finally(() => {
      this.pendingActions = this.pendingActions.filter((item) => item !== promise);
    });
  }

  private estimatePositionAvgPrice(
    side: Btc15mAutoSide,
    liveAvgPrice: number | null | undefined,
    fallbackPrice: number,
  ): number {
    if (typeof liveAvgPrice === "number" && Number.isFinite(liveAvgPrice) && liveAvgPrice > 0) {
      return roundPrice(liveAvgPrice);
    }
    const cycle = this.cycleFor(side);
    const bookPrice = this.priceFor(side);
    return roundPrice(bookPrice ?? cycle.buyOrder?.price ?? fallbackPrice);
  }

  private async recoverBuySubmissionWithoutOrderId(
    side: Btc15mAutoSide,
    tokenId: string,
    fallbackPrice: number,
    fallbackSize: number,
    reservedBudget: number,
    now: number,
  ): Promise<boolean> {
    if (!this.runtime.getLiveStateForAsset) {
      return false;
    }
    try {
      const live = await this.runtime.getLiveStateForAsset(tokenId);
      const cycle = this.cycleFor(side);
      const liveBuy = live.openOrders.filter((order) => order.side === "buy")[0];

      if (liveBuy?.id) {
        cycle.cyclePhase = "buy_pending";
        cycle.cycleStartedAt = cycle.cycleStartedAt ?? now;
        cycle.buyOrder = {
          id: randomUUID(),
          orderId: liveBuy.id,
          side: "buy",
          tokenId,
          bettingSide: side,
          price: liveBuy.price > 0 ? liveBuy.price : fallbackPrice,
          size: liveBuy.originalSize > 0 ? liveBuy.originalSize : fallbackSize,
          filledSize: liveBuy.matchedSize,
          status: "open",
          reservedBudget,
          createdAt: now,
          updatedAt: now,
        };
        cycle.plannedBuyPrice = null;
        cycle.plannedBuyAnchorPrice = null;
        cycle.buyBlockReason = null;
        cycle.buyBlockReferencePrice = null;
        return true;
      }

      if (live.position && live.position.size > 0) {
        const avgEntryPrice = this.estimatePositionAvgPrice(side, live.position.avgPrice, fallbackPrice);
        await this.applyRecoveredBuyFill(side, {
          tokenId,
          shares: live.position.size,
          avgEntryPrice,
          buyFeeUsd: 0,
          reservedBudget,
          now,
        });
        return true;
      }

      const recentTrade = await this.findRecentAccountTrade({
        tokenId,
        side: "BUY",
        notBeforeMs: now - 120_000,
        expectedSize: fallbackSize,
      });
      if (recentTrade) {
        await this.applyRecoveredBuyFill(side, {
          tokenId,
          shares: Number(recentTrade.size),
          avgEntryPrice: Number(recentTrade.price),
          buyFeeUsd: computeTradeFeeUsd(Number(recentTrade.size), Number(recentTrade.price), recentTrade.fee_rate_bps),
          reservedBudget,
          now,
        });
        return true;
      }
    } catch {
    }
    return false;
  }

  private async applyRecoveredBuyFill(side: Btc15mAutoSide, args: {
    tokenId: string;
    shares: number;
    avgEntryPrice: number;
    buyFeeUsd: number;
    reservedBudget: number;
    now: number;
  }): Promise<void> {
    const cycle = this.cycleFor(side);
    const shares = roundShares(args.shares);
    const avgEntryPrice = roundPrice(args.avgEntryPrice);
    const buyFeeUsd = roundUsd(args.buyFeeUsd);
    const consumed = roundUsd(shares * avgEntryPrice + buyFeeUsd);
    const unfilledBudget = roundUsd(Math.max(0, args.reservedBudget - consumed));
    cycle.cyclePhase = "holding";
    cycle.cycleStartedAt = cycle.cycleStartedAt ?? args.now;
    cycle.buyOrder = null;
    cycle.position = {
      bettingSide: side,
      tokenId: args.tokenId,
      shares,
      avgEntryPrice,
      costBasisUsd: consumed,
    };
    (cycle.position as { buyFeeUsd?: number }).buyFeeUsd = buyFeeUsd;
    cycle.highWaterMark = avgEntryPrice;
    cycle.trailStopPrice = roundUsd(Math.max(0.01, avgEntryPrice - this.config.trailDist));
    cycle.plannedBuyPrice = null;
    cycle.plannedBuyAnchorPrice = null;
    cycle.buyBlockReason = null;
    cycle.buyBlockReferencePrice = null;
    await this.runtime.budget.consume(consumed, `btc15mAuto-${side}-buy-filled-recovered`);
    if (unfilledBudget > 0) {
      await this.runtime.budget.release(unfilledBudget, `btc15mAuto-${side}-buy-recovered-unfilled`);
    }
  }

  private async recoverSellSubmissionWithoutOrderId(
    side: Btc15mAutoSide,
    fallbackPrice: number,
    now: number,
  ): Promise<boolean> {
    const cycle = this.cycleFor(side);
    const position = cycle.position;
    if (!position || !this.runtime.getLiveStateForAsset) {
      return false;
    }
    try {
      const live = await this.runtime.getLiveStateForAsset(position.tokenId);
      const liveSell = live.openOrders.filter((order) => order.side === "sell")[0];
      if (!liveSell?.id) {
        if (!live.position || live.position.size <= 0) {
          const recentTrade = await this.findRecentAccountTrade({
            tokenId: position.tokenId,
            side: "SELL",
            notBeforeMs: now - 120_000,
            expectedSize: position.shares,
          });
          if (recentTrade) {
            await this.handleRecoveredSellTrade(side, recentTrade, cycle.cyclePhase === "force_selling" ? "force_sell" : "target_sell");
            return true;
          }
        }
        return false;
      }
      cycle.sellOrder = {
        id: randomUUID(),
        orderId: liveSell.id,
        side: "sell",
        tokenId: position.tokenId,
        bettingSide: position.bettingSide,
        price: liveSell.price > 0 ? liveSell.price : fallbackPrice,
        size: liveSell.originalSize > 0 ? liveSell.originalSize : position.shares,
        filledSize: liveSell.matchedSize,
        status: "open",
        reservedBudget: 0,
        createdAt: now,
        updatedAt: now,
      };
      return true;
    } catch {
      return false;
    }
  }

  private async findRecentAccountTrade(args: {
    tokenId: string;
    side: "BUY" | "SELL";
    notBeforeMs: number;
    expectedSize: number;
  }): Promise<{
    id: string;
    asset_id: string;
    side: string;
    size: string;
    fee_rate_bps: string;
    price: string;
    match_time: string;
    outcome: string;
  } | null> {
    if (!this.runtime.getRecentAccountTrades) {
      return null;
    }
    try {
      const candidates = await this.runtime.getRecentAccountTrades();
      const sideNorm = args.side.toUpperCase();
      const recent = candidates
        .map((trade) => ({
          trade,
          matchMs: parseTradeTimestampValue(trade.match_time),
          sizeNum: Number(trade.size),
        }))
        .filter((entry) =>
          entry.trade.asset_id === args.tokenId &&
          String(entry.trade.side).toUpperCase() === sideNorm &&
          Number.isFinite(entry.matchMs) &&
          entry.matchMs >= args.notBeforeMs &&
          Number.isFinite(entry.sizeNum) &&
          entry.sizeNum > 0 &&
          Math.abs(entry.sizeNum - args.expectedSize) <= Math.max(0.05, args.expectedSize * 0.25),
        )
        .sort((a, b) => b.matchMs - a.matchMs);
      return recent[0]?.trade ?? null;
    } catch {
      return null;
    }
  }

  private async handleRecoveredSellTrade(
    side: Btc15mAutoSide,
    trade: {
      id: string;
      asset_id: string;
      side: string;
      size: string;
      fee_rate_bps: string;
      price: string;
      match_time: string;
      outcome: string;
    },
    exitReason: Btc15mAutoCompletedTrade["exitReason"],
  ): Promise<void> {
    const cycle = this.cycleFor(side);
    const position = cycle.position;
    const market = this.state.market;
    if (!position || !market) {
      return;
    }

    const realSellPrice = roundPrice(Number(trade.price));
    const realShares = roundShares(Number(trade.size));
    const sellFeeUsd = computeTradeFeeUsd(realShares, realSellPrice, trade.fee_rate_bps);
    const sellProceedsUsd = roundUsd(realSellPrice * realShares);
    const buyFeeUsd = (position as { buyFeeUsd?: number }).buyFeeUsd ?? 0;
    const buyCostUsd = roundUsd(position.avgEntryPrice * position.shares);
    const pnlUsd = roundUsd(sellProceedsUsd - buyCostUsd - buyFeeUsd - sellFeeUsd);

    const completedTrade: Btc15mAutoCompletedTrade = {
      id: `recovered-${trade.id}`,
      marketSlug: market.slug,
      bettingSide: position.bettingSide,
      buyPrice: position.avgEntryPrice,
      sellPrice: realSellPrice,
      shares: realShares,
      pnlUsd,
      result: pnlUsd > 0 ? "win" : "loss",
      exitReason,
      startedAt: cycle.cycleStartedAt ?? this.runtime.now(),
      closedAt: parseTradeTimestampValue(trade.match_time) || this.runtime.now(),
      dryRun: this.dryRun,
      ...(this.dryRun ? {} : {
        buyCostUsd,
        sellProceedsUsd,
        buyFeeUsd: roundUsd(buyFeeUsd),
        sellFeeUsd: roundUsd(sellFeeUsd),
      }),
    };

    cycle.sellOrder = null;
    cycle.position = null;
    cycle.cyclePhase = "cycle_done";

    await this.runtime.budget.addFunds(roundUsd(sellProceedsUsd - sellFeeUsd), `btc15mAuto-${side}-sell-filled-history`);
    if (this.dryRun) {
      this.state.sessionTrades = [...this.state.sessionTrades, completedTrade].slice(-500);
    } else {
      this.state.completedTrades = [...this.state.completedTrades, completedTrade].slice(-500);
      await this.runtime.persistTrade(completedTrade);
    }
    this.runtime.onMarketBookUnsubscribe(position.tokenId);
    this.subscribedTokens.delete(position.tokenId);
    this.pushLog(`[${side.toUpperCase()}] SELL recovered from account trade history @ ${formatPrice(realSellPrice)}. PnL ${pnlUsd.toFixed(2)} (${completedTrade.result}).`, completedTrade.result === "win" ? "success" : "warn");
    await this.refreshBudget();
    await this.persistRuntimeState();
  }

  private async refreshBudget(): Promise<void> {
    const snapshot = await this.runtime.budget.snapshot();
    this.state.budget = snapshot;
    this.state.analytics = computeAnalytics(this.state.completedTrades, snapshot);
    this.state.sessionAnalytics = computeAnalytics(this.state.sessionTrades, snapshot);
  }

  private async persistRuntimeState(): Promise<void> {
    await this.runtime.persistRuntimeState?.({
      enginePhase: this.state.enginePhase,
      market: this.state.market,
      marketStartBtcPrice: this.state.marketStartBtcPrice,
      currentBtcPrice: this.state.currentBtcPrice,
      upCycle: this.state.upCycle,
      downCycle: this.state.downCycle,
      logs: this.state.logs,
      lastError: this.state.lastError,
    });
  }

  private buildIdleStatus(trades: Btc15mAutoCompletedTrade[]): Btc15mAutoBotStatus {
    return {
      enginePhase: "stopped",
      dryRun: this.dryRun,
      config: this.config,
      market: null,
      marketStartBtcPrice: null,
      currentBtcPrice: null,
      upPrice: null,
      downPrice: null,
      upCycle: emptyCycle(),
      downCycle: emptyCycle(),
      completedTrades: trades,
      analytics: computeAnalytics(trades, null),
      sessionTrades: [],
      sessionAnalytics: computeAnalytics([], null),
      budget: null,
      logs: [],
      updatedAt: this.runtime.now(),
      lastError: null,
    };
  }

  private refreshMarketPricesFromSnapshots(): void {
    const market = this.state.market;
    if (!market) {
      return;
    }
    const upBook = this.getFreshBookSnapshot(market.upTokenId);
    const downBook = this.getFreshBookSnapshot(market.downTokenId);
    this.state.upPrice = upBook?.bestAsk ?? null;
    this.state.downPrice = downBook?.bestAsk ?? null;
  }

  private getFreshBookSnapshot(tokenId: string): { bestBid: number | null; bestAsk: number | null } | null {
    const snapshot = this.bookSnapshots.get(tokenId);
    if (!snapshot) {
      return null;
    }
    if (this.runtime.now() - snapshot.updatedAt > BOOK_STALE_MS) {
      return null;
    }
    return { bestBid: snapshot.bestBid, bestAsk: snapshot.bestAsk };
  }

  private syncMarketSubscriptions(): void {
    const market = this.state.market;
    if (!market) {
      return;
    }
    this.subscribeBook(market.upTokenId);
    this.subscribeBook(market.downTokenId);
  }

  private pushLog(message: string, type: Btc15mAutoLogEntry["type"]): void {
    const entry: Btc15mAutoLogEntry = {
      timestamp: this.runtime.now(),
      message,
      type,
    };
    this.state.logs = [entry, ...this.state.logs].slice(0, MAX_LOG_ENTRIES);
    this.touch();
  }

  private fail(error: unknown, prefix: string): void {
    const message = error instanceof Error ? error.message : String(error);
    this.state.lastError = `${prefix}: ${message}`;
    this.pushLog(this.state.lastError, "error");
  }

  private stopLoopOnly(): void {
    if (this.tickTimer) {
      (this.runtime.clearIntervalFn ?? clearInterval)(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private touch(): void {
    this.state.updatedAt = this.runtime.now();
  }
}

function computeAnalytics(
  trades: Btc15mAutoCompletedTrade[],
  budget: BudgetSnapshot | null,
): Btc15mAutoAnalyticsSummary {
  const wins = trades.filter((trade) => trade.result === "win").length;
  const totalPnlUsd = roundUsd(trades.reduce((sum, trade) => sum + trade.pnlUsd, 0));
  const grossProfitUsd = roundUsd(trades.reduce((sum, trade) => sum + (trade.pnlUsd > 0 ? trade.pnlUsd : 0), 0));
  const grossLossUsd = roundUsd(trades.reduce((sum, trade) => sum + (trade.pnlUsd < 0 ? Math.abs(trade.pnlUsd) : 0), 0));
  return {
    totalTrades: trades.length,
    wins,
    losses: trades.length - wins,
    winRate: trades.length > 0 ? wins / trades.length : 0,
    totalPnlUsd,
    grossProfitUsd,
    grossLossUsd,
    sessionStartBudgetUsd: budget?.initialBudget ?? 0,
    remainingBudgetUsd: budget?.availableBudget ?? 0,
  };
}

function cloneStatus(status: Btc15mAutoBotStatus): Btc15mAutoBotStatus {
  return JSON.parse(JSON.stringify(status)) as Btc15mAutoBotStatus;
}

function matchesOrder(message: ScalperUserWsMessage, order: Btc15mAutoTrackedOrder): boolean {
  return message.orderId === order.orderId || message.assetIds.includes(order.tokenId);
}

function extractOrderId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const value = payload as Record<string, unknown>;
  for (const candidate of [value, value.data, value.order, value.response, value.orderID ? { orderID: value.orderID } : null]) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const record = candidate as Record<string, unknown>;
    if (typeof record.orderID === "string") return record.orderID;
    if (typeof record.orderId === "string") return record.orderId;
    if (typeof record.id === "string") return record.id;
    if (typeof record.order_id === "string") return record.order_id;
    for (const nestedKey of ["data", "order", "response", "orders", "results"]) {
      const nested = record[nestedKey];
      if (Array.isArray(nested)) {
        for (const item of nested) {
          const nestedId = extractOrderId(item);
          if (nestedId) return nestedId;
        }
      } else {
        const nestedId = extractOrderId(nested);
        if (nestedId) return nestedId;
      }
    }
  }
  return null;
}

function parseTradeTimestampValue(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) {
    return Number.NaN;
  }
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  return Date.parse(trimmed);
}

function computeTradeFeeUsd(size: number, price: number, feeRateBps: string): number {
  const feeRate = Number(feeRateBps);
  if (!Number.isFinite(size) || !Number.isFinite(price) || !Number.isFinite(feeRate) || feeRate <= 0) {
    return 0;
  }
  return roundUsd(size * price * (feeRate / 10000));
}

function extractMatchedSize(message: ScalperUserWsMessage): number | null {
  const raw = message.raw;
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  for (const key of ["matched_size", "matchedSize", "size_matched", "size"]) {
    const value = record[key];
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

function isFilledStatus(status: string | null): boolean {
  return status === "matched" || status === "filled" || status === "completed";
}

function isFailureStatus(status: string | null): boolean {
  return status === "failed" || status === "rejected" || status === "canceled" || status === "cancelled";
}

function normalizeSize(value: number): number {
  return Math.max(0.01, Math.round(value * 100) / 100);
}

function formatSize(value: number): string {
  return normalizeSize(value).toFixed(2).replace(/\.00$/, "");
}

function formatPrice(value: number): string {
  return value.toFixed(2);
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundShares(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundPrice(value: number): number {
  // 4-decimal precision so true avg fill prices (e.g. $0.4267) aren't lost in display rounding.
  return Math.round(value * 10000) / 10000;
}
