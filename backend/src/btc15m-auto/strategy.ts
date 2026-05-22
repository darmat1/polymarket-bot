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

export class Btc15mAutoBot {
  private readonly runtime: Btc15mAutoRuntime;
  private readonly config: Btc15mAutoBotConfig;
  private readonly dryRun: boolean;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickInProgress = false;
  private pendingActions: Promise<void>[] = [];
  private readonly bookSnapshots = new Map<string, { bestBid: number | null; bestAsk: number | null }>();
  private readonly subscribedTokens = new Set<string>();
  private lastTrailUpdateMs = 0;
  private lastOrderPollMs = 0;
  // Poll every tick (effectively ~1-2s) — Polymarket WS misses fills, so we need fast polling
  // for instant phase transitions. The API call is cheap (single REST GET).
  private readonly orderPollIntervalMs = 1000;
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
      this.state.cycle = options.initialRuntimeState.cycle ?? this.state.cycle;
      this.state.logs = options.initialRuntimeState.logs ?? [];
      this.state.lastError = options.initialRuntimeState.lastError ?? null;
      this.state.enginePhase = "stopped";
    }
  }

  getStatus(): Btc15mAutoBotStatus {
    return cloneStatus(this.state);
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
        this.state.cycle = emptyCycle();
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
      await this.refreshMarketPrices();
      await this.refreshBudget();

      if (this.state.cycle.cyclePhase === "waiting_market") {
        this.state.cycle.cyclePhase = "waiting_direction";
      }

      // Self-heal inconsistent phases caused by crashes/restarts/race conditions in prior sessions.
      // Without these the bot would silently get stuck (reconcilePendingBuy bails when buyOrder is null,
      // reconcileHolding bails when position is null, etc).
      if (this.state.cycle.cyclePhase === "buy_pending" && !this.state.cycle.buyOrder) {
        this.pushLog("Self-heal: cyclePhase=buy_pending but buyOrder=null — resetting to waiting_direction.", "warn");
        this.state.cycle.cyclePhase = "waiting_direction";
      }
      if (this.state.cycle.cyclePhase === "holding" && !this.state.cycle.position) {
        this.pushLog("Self-heal: cyclePhase=holding but position=null — resetting to waiting_direction.", "warn");
        this.state.cycle.cyclePhase = "waiting_direction";
      }
      if (this.state.cycle.cyclePhase === "force_selling" && !this.state.cycle.position) {
        this.pushLog("Self-heal: cyclePhase=force_selling but position=null — resetting to market_idle.", "warn");
        this.state.cycle.cyclePhase = "market_idle";
        this.state.cycle.sellOrder = null;
      }

      if (this.state.cycle.cyclePhase === "buy_pending") {
        await this.reconcilePendingBuy(now);
      }

      if (this.state.cycle.cyclePhase === "holding") {
        await this.reconcileHolding(now);
      }

      if (this.state.cycle.cyclePhase === "cycle_done") {
        this.decideRepeat(now);
        this.touch();
        await this.persistRuntimeState();
        return;
      }

      if (this.state.cycle.cyclePhase === "waiting_direction") {
        await this.maybePlaceBuy();
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

  private async switchMarket(market: Btc15mAutoMarketView): Promise<void> {
    await this.cancelOpenOrders("market-switch");
    this.state.market = market;
    this.state.marketStartBtcPrice = await this.runtime.fetchBtcPrice(market.startTimeMs);
    this.state.currentBtcPrice = null;
    this.state.upPrice = null;
    this.state.downPrice = null;
    this.state.cycle = emptyCycle();
    this.state.cycle.cyclePhase = "waiting_direction";
    this.pushLog(`Switched to market ${market.slug}.`, "info");
    this.touch();
  }

  private async maybePlaceBuy(): Promise<void> {
    const market = this.state.market;
    const start = this.state.marketStartBtcPrice;
    const current = this.state.currentBtcPrice;
    if (!market || start === null || current === null) {
      return;
    }

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
      this.state.cycle.cyclePhase = "market_idle";
      this.pushLog(`Skipping new cycle: ${(timeToEndMs / 60_000).toFixed(1)}min left < required ${(minRequiredMs / 60_000).toFixed(1)}min (repeat=${this.config.repeatThresholdMin}, force-sell=${this.config.forceSellThresholdMin}).`, "info");
      return;
    }

    const delta = current - start;
    if (Math.abs(delta) <= this.config.neutralZoneUsd) {
      return;
    }

    const bettingSide: Btc15mAutoSide = sideForDelta(delta, this.config.buyPrice);
    const tokenId = bettingSide === "down" ? market.downTokenId : market.upTokenId;
    const stake = roundUsd(this.config.shares * this.config.buyPrice);

    if (this.config.buyPrice > 0.5) {
      const { previous, current: book } = await this.getFreshBookSnapshot(tokenId);
      const marketPrice = book.bestAsk ?? book.bestBid;
      const previousMarketPrice = previous?.bestAsk ?? previous?.bestBid ?? null;
      const priceRising = previousMarketPrice !== null && marketPrice !== null && marketPrice > previousMarketPrice;
      const priceInRange = marketPrice !== null && marketPrice > 0.5 && marketPrice < this.config.buyPrice;
      if (!priceInRange || !priceRising) {
        this.pushLog(
          `Skipping trend entry ${bettingSide.toUpperCase()}: market=${marketPrice?.toFixed(2) ?? "n/a"}, prev=${previousMarketPrice?.toFixed(2) ?? "n/a"}, target=${this.config.buyPrice.toFixed(2)}.`,
          "info",
        );
        return;
      }
    }

    try {
      await this.runtime.budget.reserve(stake, "btc15mAuto-cycle-buy");
    } catch (error) {
      this.state.enginePhase = "auto_stopped";
      this.state.lastError = `Budget exhausted. Stopping. ${error instanceof Error ? error.message : String(error)}`;
      this.pushLog(this.state.lastError, "error");
      this.stopLoopOnly();
      return;
    }

    const response = await this.runtime.placeLimitOrder({
      tokenId,
      side: "buy",
      price: this.config.buyPrice,
      size: this.config.shares,
    });
    const orderId = extractOrderId(response) ?? `btc15mAuto-buy:${market.slug}:${now}`;
    this.state.cycle = {
      ...this.state.cycle,
      cyclePhase: "buy_pending",
      cycleStartedAt: this.state.cycle.cycleStartedAt ?? now,
      buyOrder: {
        id: randomUUID(),
        orderId,
        side: "buy",
        tokenId,
        bettingSide,
        price: this.config.buyPrice,
        size: this.config.shares,
        filledSize: 0,
        status: "open",
        reservedBudget: stake,
        createdAt: now,
        updatedAt: now,
      },
    };
    this.pushLog(`BUY ${bettingSide.toUpperCase()} @ ${formatPrice(this.config.buyPrice)} submitted (${orderId}).`, "info");
    if (this.dryRun) {
      this.subscribeBook(tokenId, "buy");
    }
  }

  private async reconcilePendingBuy(now: number): Promise<void> {
    const market = this.state.market;
    const buyOrder = this.state.cycle.buyOrder;
    if (!market || !buyOrder) {
      return;
    }

    // Polling fallback FIRST: check order status via API every 5s to catch missed WS fills.
    // Must run before any cancel logic so we don't discard already-filled orders.
    if (!this.dryRun && this.runtime.getOrder && buyOrder.orderId) {
      if (now - this.lastOrderPollMs >= this.orderPollIntervalMs) {
        this.lastOrderPollMs = now;
        try {
          const orderData = await this.runtime.getOrder(buyOrder.orderId);
          if (orderData) {
            const statusLower = (orderData.status ?? "").toLowerCase();
            const matched = parseFloat(orderData.size_matched) || 0;
            const original = parseFloat(orderData.original_size ?? String(buyOrder.size)) || buyOrder.size;
            // Polymarket sometimes keeps status="live" even after full match.
            // Treat as filled if size_matched >= original_size, OR status is matched/filled,
            // OR the order is gone (not_found sentinel from runtime).
            const fullyFilled = matched >= original - 1e-9 && matched > 0;
            const statusFilled = isFilledStatus(statusLower);
            const statusNotFound = statusLower === "not_found";

            if (statusFilled || fullyFilled || statusNotFound) {
              const filledSize = matched > 0 ? matched : buyOrder.size;
              this.pushLog(`Buy fill detected via polling (status: ${orderData.status}, matched: ${matched}/${original}).`, "info");
              await this.transitionBuyFilledToHolding(filledSize);
              return; // Already transitioned — skip cancel checks below
            } else if (isFailureStatus(statusLower)) {
              this.pushLog(`Buy order failed via polling (status: ${orderData.status}).`, "warn");
              await this.cancelBuy(`poll-${orderData.status}`);
              this.state.cycle.cyclePhase = "waiting_direction";
              return;
            }
            // If still open/partial - fall through to direction/timing checks
          }
        } catch {
          // polling is best-effort, swallow errors
        }
      }
    }

    const timeToEndMs = market.endTimeMs - now;
    if (timeToEndMs < this.config.forceSellThresholdMin * 60_000 && !this.state.cycle.position) {
      await this.cancelBuy("late-market");
      this.state.cycle.cyclePhase = "market_idle";
      return;
    }

    const start = this.state.marketStartBtcPrice;
    const current = this.state.currentBtcPrice;
    if (start === null || current === null) {
      return;
    }

    const delta = current - start;
    const expectedSide: Btc15mAutoSide | null = Math.abs(delta) <= this.config.neutralZoneUsd
      ? null
      : sideForDelta(delta, this.config.buyPrice);
    if (expectedSide !== buyOrder.bettingSide) {
      const flipReason = expectedSide === null
        ? `neutral-zone (Δ=${delta.toFixed(2)})`
        : `direction-flip (Δ=${delta.toFixed(2)}, was=${buyOrder.bettingSide}, now=${expectedSide})`;
      this.pushLog(`Direction reset: ${flipReason}.`, "warn");
      await this.cancelBuy(flipReason);
      this.state.cycle.cyclePhase = "waiting_direction";
    }
  }

  private async reconcileHolding(now: number): Promise<void> {
    const market = this.state.market;
    const position = this.state.cycle.position;
    if (!market || !position) {
      return;
    }

    const snap = this.bookSnapshots.get(position.tokenId);
    let bestBid = snap?.bestBid ?? null;
    const timeToEndMs = market.endTimeMs - now;

    if (this.runtime.getOrderBook) {
      try {
        const book = await this.runtime.getOrderBook(position.tokenId);
        this.bookSnapshots.set(position.tokenId, { bestBid: book.bestBid, bestAsk: book.bestAsk });
        bestBid = book.bestBid;
      } catch (error) {
        this.pushLog(`getOrderBook failed during holding: ${error instanceof Error ? error.message : String(error)}`, "warn");
      }
    }

    // --- TRAILING STOP LOGIC ---
    const highWaterMark = this.state.cycle.highWaterMark ?? position.avgEntryPrice;
    if (bestBid !== null && bestBid > highWaterMark + this.config.trailStep) {
      const cooldownOk =
        this.dryRun || now - this.lastTrailUpdateMs >= this.config.trailUpdateIntervalSec * 1000;
      if (cooldownOk) {
        this.state.cycle.highWaterMark = bestBid;
        this.state.cycle.trailStopPrice = roundUsd(bestBid - this.config.trailDist);
        this.lastTrailUpdateMs = now;
        this.pushLog(`Trail stop moved to ${formatPrice(this.state.cycle.trailStopPrice)} (high ${formatPrice(bestBid)}).`, "info");
      }
    }

    const trailStopPrice = this.state.cycle.trailStopPrice;
    if (bestBid !== null && trailStopPrice !== null && bestBid <= trailStopPrice) {
      const liveExitPrice = bestBid > 0 ? bestBid : trailStopPrice;
      this.pushLog(`Trail stop triggered at ${formatPrice(trailStopPrice)} (live bid ${formatPrice(liveExitPrice)}).`, "warn");
      await this.placeSell(liveExitPrice, "holding");
      if (this.dryRun) {
        await this.handleSellFill(liveExitPrice, "target_sell");
      }
      return;
    }

    // --- FORCE SELL ---
    if (timeToEndMs >= this.config.forceSellThresholdMin * 60_000) {
      return;
    }
    // Fetch the freshest bid synchronously — WS bookSnapshots may be stale/empty
    // (especially if we just subscribed). Without a live bid we'd fall through to $0.01,
    // which often sits unfilled because no one is bidding even that low.
    let liveBid: number | null = bestBid;
    if (!this.dryRun && this.runtime.getOrderBook) {
      try {
        const book = await this.runtime.getOrderBook(position.tokenId);
        if (book.bestBid !== null && book.bestBid > 0) {
          liveBid = book.bestBid;
          // Also refresh our cache so the next tick is consistent
          this.bookSnapshots.set(position.tokenId, { bestBid: book.bestBid, bestAsk: book.bestAsk });
        }
      } catch (error) {
        this.pushLog(`getOrderBook failed during force-sell: ${error instanceof Error ? error.message : String(error)}`, "warn");
      }
    }
    // Sell INTO the live bid (price = bestBid means our SELL crosses the spread → instant fill).
    // If there's no bid at all, fall back to $0.01 (lowest tick) — at least we tried.
    const forceSellPrice = liveBid !== null && liveBid > 0 ? liveBid : 0.01;
    await this.cancelSellOrderApi();
    this.pushLog(`Force-sell at ${formatPrice(forceSellPrice)} (live bid: ${liveBid ?? "n/a"}).`, "warn");
    await this.placeSell(forceSellPrice, "force_selling");
    if (this.dryRun) {
      await this.handleSellFill(forceSellPrice, "force_sell");
    }
  }

  private async cancelSellOrderApi(): Promise<void> {
    const sellOrder = this.state.cycle.sellOrder;
    if (!sellOrder) return;
    if (sellOrder.orderId) {
      try {
        await this.runtime.cancelOrder(sellOrder.orderId);
      } catch {
      }
    }
    this.state.cycle.sellOrder = null;
  }

  private async getFreshBookSnapshot(tokenId: string): Promise<{ previous: { bestBid: number | null; bestAsk: number | null } | null; current: { bestBid: number | null; bestAsk: number | null } }> {
    const previous = this.bookSnapshots.get(tokenId) ?? null;
    if (this.runtime.getOrderBook) {
      try {
        const book = await this.runtime.getOrderBook(tokenId);
        if (book.bestBid !== null || book.bestAsk !== null) {
          this.bookSnapshots.set(tokenId, { bestBid: book.bestBid, bestAsk: book.bestAsk });
          return { previous, current: book };
        }
      } catch {
      }
    }
    return { previous, current: previous ?? { bestBid: null, bestAsk: null } };
  }

  private decideRepeat(now: number): void {
    const market = this.state.market;
    if (!market) {
      this.state.cycle = emptyCycle();
      return;
    }

    // Safety: never repeat if position or sell order still open
    if (this.state.cycle.position !== null || this.state.cycle.sellOrder !== null) {
      this.pushLog("Cycle not fully closed; skipping repeat (safety guard).", "warn");
      this.state.cycle.cyclePhase = "market_idle";
      return;
    }

    if (market.endTimeMs - now > this.config.repeatThresholdMin * 60_000) {
      this.state.cycle = emptyCycle();
      this.state.cycle.cyclePhase = "waiting_direction";
      return;
    }

    this.state.cycle.cyclePhase = "market_idle";
  }

  private async cancelBuy(reason: string): Promise<void> {
    const buyOrder = this.state.cycle.buyOrder;
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
    this.state.cycle.buyOrder = null;
    this.pushLog(`BUY cancelled (${reason}).`, "warn");
  }

  private async cancelOpenOrders(reason: string): Promise<void> {
    const { buyOrder, sellOrder } = this.state.cycle;
    if (buyOrder) {
      await this.cancelBuy(reason);
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
    }
  }

  private subscribeBook(tokenId: string, _mode: "buy" | "sell"): void {
    if (this.subscribedTokens.has(tokenId)) {
      return;
    }
    this.runtime.onMarketBookSubscribe(tokenId, (bestBid, bestAsk) => {
      this.bookSnapshots.set(tokenId, { bestBid, bestAsk });

      const buyOrder = this.state.cycle.buyOrder;
      if (
        buyOrder &&
        this.state.cycle.cyclePhase === "buy_pending" &&
        buyOrder.tokenId === tokenId &&
        bestAsk !== null &&
        bestAsk <= buyOrder.price
      ) {
        this.trackAction(this.transitionBuyFilledToHolding(buyOrder.size));
        return;
      }

      const sellOrder = this.state.cycle.sellOrder;
      if (
        sellOrder &&
        (this.state.cycle.cyclePhase === "holding" || this.state.cycle.cyclePhase === "force_selling") &&
        sellOrder.tokenId === tokenId &&
        bestBid !== null &&
        bestBid >= sellOrder.price
      ) {
        const exitReason = this.state.cycle.cyclePhase === "force_selling" ? "force_sell" : "target_sell";
        this.trackAction(this.handleSellFill(sellOrder.price, exitReason));
      }
    });
    this.subscribedTokens.add(tokenId);
  }

  private async transitionBuyFilledToHolding(filledSize: number): Promise<void> {
    // Atomic capture-and-transition BEFORE any await. Concurrent WS fill events + polling
    // can both trigger this for the same buy — without atomic clearing both would consume()
    // budget twice and double-create the position.
    const buyOrder = this.state.cycle.buyOrder;
    if (!buyOrder || this.state.cycle.cyclePhase !== "buy_pending") {
      return;
    }
    const shares = normalizeSize(Math.min(filledSize, buyOrder.size));
    // Move to "holding" synchronously so concurrent callers see phase != "buy_pending" and bail.
    this.state.cycle.cyclePhase = "holding";
    this.state.cycle.buyOrder = null;
    const consumed = roundUsd(shares * buyOrder.price);
    this.state.cycle.position = {
      bettingSide: buyOrder.bettingSide,
      tokenId: buyOrder.tokenId,
      shares,
      avgEntryPrice: buyOrder.price,
      costBasisUsd: consumed,
    };
    this.state.cycle.highWaterMark = buyOrder.price;
    this.state.cycle.trailStopPrice = roundUsd(Math.max(0.01, buyOrder.price - this.config.trailDist));

    await this.runtime.budget.consume(consumed, "btc15mAuto-buy-filled");
    const unfilledBudget = roundUsd(Math.max(0, buyOrder.size - shares) * buyOrder.price);
    if (unfilledBudget > 0) {
      await this.runtime.budget.release(unfilledBudget, "btc15mAuto-partial-unfilled");
    }

    // Re-register the book listener with mode="sell" — old listener was mode="buy" (captured in closure)
    // and ignored sell-side trailing in dryRun. In LIVE we need the subscription alive for bookSnapshots
    // so reconcileHolding can read bestBid for the trailing stop.
    this.runtime.onMarketBookUnsubscribe(buyOrder.tokenId);
    this.subscribedTokens.delete(buyOrder.tokenId);
    this.pushLog(`BUY filled. Holding ${formatSize(shares)} ${buyOrder.bettingSide.toUpperCase()} shares.`, "success");
    // Always re-subscribe for sell-side tracking (was previously dryRun-only — broke trailing in LIVE).
    this.subscribeBook(buyOrder.tokenId, "sell");
    await this.refreshBudget();
    await this.persistRuntimeState();
  }

  private async placeSell(
    price: number,
    phase: "holding" | "force_selling",
  ): Promise<void> {
    const position = this.state.cycle.position;
    const market = this.state.market;
    if (!position || !market) {
      return;
    }

    // Polymarket CLOB only accepts prices in [0.01, 0.99] at 0.01 tick.
    // Trail logic (bestBid - trailDist) and force-sell can produce values like 0.001,
    // 0, or negatives when the bid is very low — clamp here so the API never rejects us.
    const clamped = Math.min(0.99, Math.max(0.01, roundUsd(price)));
    if (clamped !== price) {
      this.pushLog(`Sell price ${price} clamped to ${clamped} (Polymarket valid range 0.01–0.99).`, "warn");
    }

    const response = await this.runtime.placeLimitOrder({
      tokenId: position.tokenId,
      side: "sell",
      price: clamped,
      size: position.shares,
    });
    const now = this.runtime.now();
    const orderId = extractOrderId(response) ?? `btc15mAuto-sell:${market.slug}:${now}`;
    this.state.cycle.sellOrder = {
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
    this.state.cycle.cyclePhase = phase;
    this.pushLog(`SELL ${position.bettingSide.toUpperCase()} @ ${formatPrice(clamped)} submitted (${orderId}).`, "info");
    if (this.dryRun && phase === "holding") {
      this.subscribeBook(position.tokenId, "sell");
    }
  }

  private async handleSellFill(
    sellPrice: number,
    exitReason: Btc15mAutoCompletedTrade["exitReason"],
  ): Promise<void> {
    // Atomic capture-and-clear BEFORE any await. Multiple WS fill events can fire concurrently
    // for the same order (replays, partial-then-full, polling races) — without this guard each
    // event would snapshot the still-non-null sellOrder and re-credit funds + log a duplicate trade.
    // This caused budget inflation ($13.50 from $5 working) and 5x duplicate rows in trade history.
    const position = this.state.cycle.position;
    const market = this.state.market;
    const sellOrder = this.state.cycle.sellOrder;
    if (!position || !market || !sellOrder) {
      return;
    }
    // Clear synchronously — subsequent concurrent calls will see null and bail out above.
    this.state.cycle.sellOrder = null;
    this.state.cycle.position = null;
    this.state.cycle.cyclePhase = "cycle_done";

    const pnlUsd = roundUsd((sellPrice - position.avgEntryPrice) * position.shares);
    const trade: Btc15mAutoCompletedTrade = {
      id: randomUUID(),
      marketSlug: market.slug,
      bettingSide: position.bettingSide,
      buyPrice: position.avgEntryPrice,
      sellPrice,
      shares: position.shares,
      pnlUsd,
      result: pnlUsd > 0 ? "win" : "loss",
      exitReason,
      startedAt: this.state.cycle.cycleStartedAt ?? this.runtime.now(),
      closedAt: this.runtime.now(),
      dryRun: this.dryRun,
    };

    await this.runtime.budget.addFunds(roundUsd(sellPrice * position.shares), "btc15mAuto-sell-filled");
    if (this.dryRun) {
      // SIM trade — track in-memory session counter only. Do NOT persist or pollute LIVE history.
      this.state.sessionTrades = [...this.state.sessionTrades, trade].slice(-500);
    } else {
      this.state.completedTrades = [...this.state.completedTrades, trade].slice(-500);
      await this.runtime.persistTrade(trade);
    }
    this.runtime.onMarketBookUnsubscribe(position.tokenId);
    this.subscribedTokens.delete(position.tokenId);
    this.pushLog(`${this.dryRun ? "[SIM] " : ""}SELL filled. PnL ${pnlUsd.toFixed(2)} (${trade.result}).`, trade.result === "win" ? "success" : "warn");
    await this.refreshBudget();
    await this.persistRuntimeState();
  }

  private async handleUserWsMessage(message: ScalperUserWsMessage): Promise<void> {
    if (this.dryRun || this.state.enginePhase !== "running") {
      return;
    }

    const buyOrder = this.state.cycle.buyOrder;
    if (buyOrder && matchesOrder(message, buyOrder)) {
      if (isFailureStatus(message.status)) {
        await this.cancelBuy(`live-${message.status ?? "failed"}`);
        this.state.cycle.cyclePhase = "waiting_direction";
        return;
      }
      if (isFilledStatus(message.status)) {
        await this.transitionBuyFilledToHolding(extractMatchedSize(message) ?? buyOrder.size);
        return;
      }
    }

    const sellOrder = this.state.cycle.sellOrder;
    if (sellOrder && matchesOrder(message, sellOrder)) {
      if (isFailureStatus(message.status)) {
        sellOrder.status = "failed";
        sellOrder.errorMessage = message.status;
        this.pushLog(`SELL failed: ${message.status ?? "unknown"}.`, "error");
        return;
      }
      if (isFilledStatus(message.status)) {
        await this.handleSellFill(
          sellOrder.price,
          this.state.cycle.cyclePhase === "force_selling" ? "force_sell" : "target_sell",
        );
      }
    }
  }

  private trackAction(promise: Promise<void>): void {
    this.pendingActions.push(promise);
    promise.finally(() => {
      this.pendingActions = this.pendingActions.filter((item) => item !== promise);
    });
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
      cycle: this.state.cycle,
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
      cycle: emptyCycle(),
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

  private async refreshMarketPrices(): Promise<void> {
    const market = this.state.market;
    if (!market || !this.runtime.getOrderBook) {
      return;
    }
    try {
      const [upBook, downBook] = await Promise.all([
        this.runtime.getOrderBook(market.upTokenId),
        this.runtime.getOrderBook(market.downTokenId),
      ]);
      this.bookSnapshots.set(market.upTokenId, { bestBid: upBook.bestBid, bestAsk: upBook.bestAsk });
      this.bookSnapshots.set(market.downTokenId, { bestBid: downBook.bestBid, bestAsk: downBook.bestAsk });
      this.state.upPrice = upBook.bestAsk ?? upBook.bestBid;
      this.state.downPrice = downBook.bestAsk ?? downBook.bestBid;
    } catch (error) {
      this.pushLog(`getOrderBook failed during market refresh: ${error instanceof Error ? error.message : String(error)}`, "warn");
    }
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
  if (typeof value.orderID === "string") return value.orderID;
  if (typeof value.orderId === "string") return value.orderId;
  if (typeof value.id === "string") return value.id;
  return null;
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

/**
 * Pick the side to bet on based on BTC movement relative to start, AND the configured buyPrice.
 *
 * - buyPrice < 0.50: CONTRARIAN. We're trying to buy the cheap (unlikely) side hoping for a
 *   mean-reversion. If BTC went UP (delta>0), the market is pricing UP as the winner → UP is
 *   expensive, DOWN is cheap → bet DOWN.
 * - buyPrice >= 0.50: TREND-FOLLOWING. We're trying to buy the expected-winner side that's
 *   trading near our entry price. If BTC went UP (delta>0), UP is the likely winner → bet UP.
 */
function sideForDelta(delta: number, buyPrice: number): Btc15mAutoSide {
  if (buyPrice >= 0.5) {
    // Trend-following: bet WITH the move.
    return delta > 0 ? "up" : "down";
  }
  // Contrarian: bet AGAINST the move.
  return delta > 0 ? "down" : "up";
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
