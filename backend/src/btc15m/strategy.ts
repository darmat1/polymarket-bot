import { randomUUID } from "node:crypto";

import type { ScalperUserWsMessage } from "../scalper-user-ws.js";
import type { BudgetSnapshot } from "../scalper/types.js";
import { emptyCycle } from "./state-store.js";
import type {
  Btc15mAnalyticsSummary,
  Btc15mBotConfig,
  Btc15mBotStatus,
  Btc15mCompletedTrade,
  Btc15mCycleState,
  Btc15mLogEntry,
  Btc15mMarketView,
  Btc15mPosition,
  Btc15mRuntimeStateUpdate,
  Btc15mSide,
  Btc15mTrackedOrder,
} from "./types.js";

export interface Btc15mBudgetPort {
  reserve(amount: number, reason?: string): Promise<void>;
  release(amount: number, reason?: string): Promise<void>;
  consume(amount: number, reason?: string): Promise<void>;
  addFunds(amount: number, reason?: string): Promise<void>;
  resetAvailableBudget(
    maxAvailable: number,
    resetAt: number,
    reason?: string,
  ): Promise<{ snapshot: BudgetSnapshot; skimmedProfitUsd: number }>;
  snapshot(): Promise<BudgetSnapshot>;
}

export interface Btc15mLivePosition {
  bettingSide: Btc15mSide;
  tokenId: string;
  shares: number;
}

export interface PlaceOrderArgs {
  tokenId: string;
  side: "buy" | "sell";
  price: number;
  size: number;
}

export interface Btc15mRuntime {
  now: () => number;
  resolveMarket: () => Promise<Btc15mMarketView | null>;
  fetchBtcPrice: (atMs: number) => Promise<number | null>;
  fetchMarketStartPrice: (market: Btc15mMarketView) => Promise<number | null>;
  placeLimitOrder: (args: PlaceOrderArgs) => Promise<unknown>;
  cancelOrder: (orderId: string) => Promise<unknown>;
  onMarketBookSubscribe: (
    tokenId: string,
    listener: (bestBid: number | null, bestAsk: number | null) => void,
  ) => void;
  onMarketBookUnsubscribe: (tokenId: string) => void;
  startUserWs: (handler: (msg: ScalperUserWsMessage) => void) => Promise<void>;
  stopUserWs: () => void;
  budget: Btc15mBudgetPort;
  persistTrade: (trade: Btc15mCompletedTrade) => Promise<void>;
  persistConfig: (config: Btc15mBotConfig) => Promise<void>;
  persistRuntimeState?: (state: Btc15mRuntimeStateUpdate) => Promise<void>;
  getLivePosition?: (market: Btc15mMarketView) => Promise<Btc15mLivePosition | null>;
  getTopOfBook?: (tokenId: string) => Promise<{ bestBid: number | null; bestAsk: number | null }>;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export interface Btc15mBotStartOptions {
  runImmediateTick?: boolean;
  scheduleLoop?: boolean;
}

export interface Btc15mBotOptions {
  config: Btc15mBotConfig;
  dryRun: boolean;
  runtime: Btc15mRuntime;
  initialTrades?: Btc15mCompletedTrade[];
  initialRuntimeState?: Partial<Btc15mRuntimeStateUpdate>;
}

const MAX_LOG_ENTRIES = 60;
const MIN_CLOB_PRICE = 0.01;
const MAX_CLOB_PRICE = 0.99;

export class Btc15mBot {
  private readonly runtime: Btc15mRuntime;
  private readonly config: Btc15mBotConfig;
  private readonly dryRun: boolean;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickInProgress = false;
  private pendingActions: Promise<void>[] = [];
  private readonly bookSnapshots = new Map<string, { bestBid: number | null; bestAsk: number | null }>();
  private readonly subscribedTokens = new Set<string>();
  private state: Btc15mBotStatus;

  constructor(options: Btc15mBotOptions) {
    this.runtime = options.runtime;
    this.config = options.config;
    this.dryRun = options.dryRun;
    this.state = this.buildIdleStatus(options.initialTrades ?? []);
    if (options.initialRuntimeState) {
      this.state.market = options.initialRuntimeState.market ?? null;
      this.state.marketStartBtcPrice = options.initialRuntimeState.marketStartBtcPrice ?? null;
      this.state.currentBtcPrice = options.initialRuntimeState.currentBtcPrice ?? null;
      this.state.cycle = options.initialRuntimeState.cycle ?? this.state.cycle;
      this.state.logs = options.initialRuntimeState.logs ?? [];
      this.state.lastError = options.initialRuntimeState.lastError ?? null;
      this.state.enginePhase = "stopped";
    }
  }

  getStatus(): Btc15mBotStatus {
    return cloneStatus(this.state);
  }

  async start(options: Btc15mBotStartOptions = {}): Promise<void> {
    if (this.state.enginePhase === "running") {
      return;
    }

    this.state.enginePhase = "running";
    this.state.lastError = null;
    this.pushLog(`BTC 15m bot started (${this.dryRun ? "SIM" : "LIVE"}).`, "success");
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
    await this.cancelOpenOrders("stop");
    if (!this.state.cycle.buyOrder && !this.state.cycle.sellOrder && !this.state.cycle.position) {
      this.state.cycle = emptyCycle();
    } else if (this.state.cycle.position && !this.state.cycle.sellOrder) {
      this.state.cycle.cyclePhase = "holding";
    }
    for (const tokenId of this.subscribedTokens) {
      this.runtime.onMarketBookUnsubscribe(tokenId);
    }
    this.subscribedTokens.clear();
    this.bookSnapshots.clear();
    if (!this.dryRun) {
      this.runtime.stopUserWs();
    }
    this.state.enginePhase = "stopped";
    this.pushLog("BTC 15m bot stopped.", "info");
    await this.refreshBudget();
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

      if (this.state.marketStartBtcPrice === null) {
        this.state.marketStartBtcPrice = await this.fetchMarketStartPrice(market);
      }
      this.state.currentBtcPrice = await this.runtime.fetchBtcPrice(now);
      await this.refreshBudget();
      await this.maybeResetBudget(now);

      if (this.state.cycle.cyclePhase === "waiting_market") {
        this.state.cycle.cyclePhase = "waiting_direction";
      }

      if (!this.dryRun) {
        await this.reconcileLivePosition(now);
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
        if (this.isEntryCutoffReached(now)) {
          this.state.cycle.cyclePhase = "market_idle";
          this.touch();
          await this.persistRuntimeState();
          return;
        }
        await this.maybePlaceBuy();
      }

      this.touch();
      await this.refreshBudget();
      await this.persistRuntimeState();
    } catch (error) {
      this.fail(error, "BTC 15m bot tick failed");
      await this.persistRuntimeState();
    } finally {
      this.tickInProgress = false;
    }
  }

  private async switchMarket(market: Btc15mMarketView): Promise<void> {
    await this.cancelOpenOrders("market-switch");
    this.state.market = market;
    this.state.marketStartBtcPrice = await this.fetchMarketStartPrice(market);
    this.state.currentBtcPrice = null;
    this.state.cycle = emptyCycle();
    this.state.cycle.cyclePhase = "waiting_direction";
    this.pushLog(`Switched to market ${market.slug}.`, "info");
    this.touch();
  }

  private async fetchMarketStartPrice(market: Btc15mMarketView): Promise<number | null> {
    if (typeof market.priceToBeat === "number" && Number.isFinite(market.priceToBeat) && market.priceToBeat > 0) {
      return market.priceToBeat;
    }
    return this.runtime.fetchMarketStartPrice(market);
  }

  private async maybePlaceBuy(): Promise<void> {
    const market = this.state.market;
    const start = this.state.marketStartBtcPrice;
    const current = this.state.currentBtcPrice;
    if (!market || start === null || current === null) {
      return;
    }

    const delta = current - start;
    if (Math.abs(delta) <= this.config.neutralZoneUsd) {
      return;
    }

    const bettingSide: Btc15mSide = delta > 0 ? "down" : "up";
    const tokenId = bettingSide === "down" ? market.downTokenId : market.upTokenId;
    const stake = roundUsd(this.config.shares * this.config.buyPrice);

    try {
      await this.runtime.budget.reserve(stake, "btc15m-cycle-buy");
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
    const now = this.runtime.now();
    const orderId = extractOrderId(response) ?? `btc15m-buy:${market.slug}:${now}`;
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

    const timeToEndMs = market.endTimeMs - now;
    if (timeToEndMs < this.config.repeatThresholdMin * 60_000 && !this.state.cycle.position) {
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
    const expectedSide: Btc15mSide | null = Math.abs(delta) <= this.config.neutralZoneUsd
      ? null
      : delta > 0
        ? "down"
        : "up";
    if (expectedSide !== buyOrder.bettingSide) {
      await this.cancelBuy("direction-reset");
      this.state.cycle.cyclePhase = "waiting_direction";
    }
  }

  private async reconcileHolding(now: number): Promise<void> {
    const market = this.state.market;
    const position = this.state.cycle.position;
    const sellOrder = this.state.cycle.sellOrder;
    if (!market || !position || !sellOrder) {
      return;
    }

    const timeToEndMs = market.endTimeMs - now;
    if (timeToEndMs < this.config.forceSellThresholdMin * 60_000) {
      await this.replaceSellAtBestBid(position, sellOrder, "force_sell", "force_selling");
      return;
    }

    const profitCheckDue = now - sellOrder.createdAt >= this.config.profitCheckDelayMin * 60_000;
    if (!profitCheckDue || sellOrder.price !== this.config.targetSellPrice) {
      return;
    }

    const bestBid = await this.getBestBid(position.tokenId);
    const nextPrice = bestBid !== null &&
      bestBid !== undefined &&
      bestBid >= this.config.fallbackSellPrice &&
      bestBid < this.config.targetSellPrice
      ? normalizeSellPrice(bestBid)
      : this.config.fallbackSellPrice;

    if (sellOrder.orderId) {
      try {
        await this.runtime.cancelOrder(sellOrder.orderId);
      } catch {
        // Order may already be filled/cancelled.
      }
    }
    await this.placeSell(nextPrice, "holding");
    this.pushLog(`Profit check moved SELL to ${formatPrice(nextPrice)}.`, "info");
    if (this.dryRun && bestBid !== null && bestBid !== undefined && bestBid >= nextPrice) {
      await this.handleSellFill(nextPrice, "target_sell");
    }
  }

  private async reconcileLivePosition(now: number): Promise<void> {
    const market = this.state.market;
    if (!market || this.state.cycle.position || !this.runtime.getLivePosition) {
      return;
    }

    const livePosition = await this.runtime.getLivePosition(market);
    if (!livePosition || livePosition.shares <= 0) {
      return;
    }

    if (this.state.cycle.buyOrder) {
      await this.transitionBuyFilledToHolding(livePosition.shares);
    } else if (this.hasCompletedTrade(market.slug, livePosition.bettingSide)) {
      return;
    } else {
      this.state.cycle.position = {
        bettingSide: livePosition.bettingSide,
        tokenId: livePosition.tokenId,
        shares: normalizeSize(livePosition.shares),
        avgEntryPrice: this.config.buyPrice,
        costBasisUsd: roundUsd(livePosition.shares * this.config.buyPrice),
      };
      this.state.cycle.buyOrder = null;
      this.state.cycle.cycleStartedAt = this.state.cycle.cycleStartedAt ?? now;
      this.state.cycle.cyclePhase = "holding";
      await this.syncRecoveredPositionBudget(this.state.cycle.position.costBasisUsd);
      this.pushLog(
        `Recovered LIVE position: ${formatSize(livePosition.shares)} ${livePosition.bettingSide.toUpperCase()} shares.`,
        "warn",
      );
      if (market.endTimeMs - now < this.config.forceSellThresholdMin * 60_000) {
        const bestBid = await this.getBestBid(livePosition.tokenId);
        if (bestBid !== null && bestBid > 0) {
          await this.placeSell(bestBid, "force_selling");
        }
      } else {
        await this.placeSell(this.config.targetSellPrice, "holding");
      }
    }

    if (
      this.state.cycle.cyclePhase === "holding" &&
      market.endTimeMs - now < this.config.forceSellThresholdMin * 60_000
    ) {
      await this.reconcileHolding(now);
    }
  }

  private decideRepeat(now: number): void {
    const market = this.state.market;
    if (!market) {
      this.state.cycle = emptyCycle();
      return;
    }

    if (market.endTimeMs - now > this.config.repeatThresholdMin * 60_000) {
      this.state.cycle = emptyCycle();
      this.state.cycle.cyclePhase = "waiting_direction";
      return;
    }

    this.state.cycle.cyclePhase = "market_idle";
  }

  private isEntryCutoffReached(now: number): boolean {
    const market = this.state.market;
    if (!market) {
      return true;
    }
    return market.endTimeMs - now < this.config.repeatThresholdMin * 60_000;
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

  private subscribeBook(tokenId: string, mode: "buy" | "sell"): void {
    this.runtime.onMarketBookSubscribe(tokenId, (bestBid, bestAsk) => {
      this.bookSnapshots.set(tokenId, { bestBid, bestAsk });
      if (mode === "buy") {
        const buyOrder = this.state.cycle.buyOrder;
        if (
          buyOrder &&
          this.state.cycle.cyclePhase === "buy_pending" &&
          buyOrder.tokenId === tokenId &&
          bestAsk !== null &&
          bestAsk <= buyOrder.price
        ) {
          this.trackAction(this.transitionBuyFilledToHolding(buyOrder.size));
        }
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
    const buyOrder = this.state.cycle.buyOrder;
    if (!buyOrder || this.state.cycle.cyclePhase !== "buy_pending") {
      return;
    }

    const shares = normalizeSize(Math.min(filledSize, buyOrder.size));
    const consumed = roundUsd(shares * buyOrder.price);
    await this.runtime.budget.consume(consumed, "btc15m-buy-filled");
    const unfilledBudget = roundUsd(Math.max(0, buyOrder.size - shares) * buyOrder.price);
    if (unfilledBudget > 0) {
      await this.runtime.budget.release(unfilledBudget, "btc15m-partial-unfilled");
    }

    this.runtime.onMarketBookUnsubscribe(buyOrder.tokenId);
    this.subscribedTokens.delete(buyOrder.tokenId);
    this.state.cycle.position = {
      bettingSide: buyOrder.bettingSide,
      tokenId: buyOrder.tokenId,
      shares,
      avgEntryPrice: buyOrder.price,
      costBasisUsd: consumed,
    };
    this.state.cycle.buyOrder = null;
    this.pushLog(`BUY filled. Holding ${formatSize(shares)} ${buyOrder.bettingSide.toUpperCase()} shares.`, "success");
    await this.placeSell(this.config.targetSellPrice, "holding");
    await this.refreshBudget();
    await this.persistRuntimeState();
  }

  private async replaceSellAtBestBid(
    position: Btc15mPosition,
    sellOrder: Btc15mTrackedOrder,
    exitReason: Btc15mCompletedTrade["exitReason"],
    phase: "holding" | "force_selling",
  ): Promise<void> {
    const bestBid = await this.getBestBid(position.tokenId);
    if (bestBid === null || bestBid === undefined || bestBid <= 0) {
      return;
    }

    if (sellOrder.orderId) {
      try {
        await this.runtime.cancelOrder(sellOrder.orderId);
      } catch {
        // Order may already be filled/cancelled.
      }
    }
    const sellPrice = normalizeSellPrice(bestBid);
    if (bestBid < MIN_CLOB_PRICE) {
      this.pushLog(
        `Best bid ${formatPrice(bestBid)} is below CLOB minimum; placing SELL at ${formatPrice(sellPrice)}.`,
        "warn",
      );
    }
    await this.placeSell(sellPrice, phase);
    if (this.dryRun && bestBid >= sellPrice) {
      await this.handleSellFill(sellPrice, exitReason);
    }
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

    const normalizedPrice = normalizeSellPrice(price);
    const response = await this.runtime.placeLimitOrder({
      tokenId: position.tokenId,
      side: "sell",
      price: normalizedPrice,
      size: position.shares,
    });
    const now = this.runtime.now();
    const orderId = extractOrderId(response) ?? `btc15m-sell:${market.slug}:${now}`;
    this.state.cycle.sellOrder = {
      id: randomUUID(),
      orderId,
      side: "sell",
      tokenId: position.tokenId,
      bettingSide: position.bettingSide,
      price: normalizedPrice,
      size: position.shares,
      filledSize: 0,
      status: "open",
      reservedBudget: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.state.cycle.cyclePhase = phase;
    this.pushLog(`SELL ${position.bettingSide.toUpperCase()} @ ${formatPrice(normalizedPrice)} submitted (${orderId}).`, "info");
    if (phase === "holding" && !this.subscribedTokens.has(position.tokenId)) {
      this.subscribeBook(position.tokenId, "sell");
    }
  }

  private async handleSellFill(
    sellPrice: number,
    exitReason: Btc15mCompletedTrade["exitReason"],
  ): Promise<void> {
    const position = this.state.cycle.position;
    const market = this.state.market;
    const sellOrder = this.state.cycle.sellOrder;
    if (!position || !market || !sellOrder) {
      return;
    }

    sellOrder.status = "filled";
    sellOrder.filledSize = position.shares;
    sellOrder.updatedAt = this.runtime.now();
    this.state.cycle.sellOrder = null;
    this.state.cycle.position = null;
    this.state.cycle.cyclePhase = "cycle_done";
    this.runtime.onMarketBookUnsubscribe(position.tokenId);
    this.subscribedTokens.delete(position.tokenId);

    const pnlUsd = roundUsd((sellPrice - position.avgEntryPrice) * position.shares);
    const trade: Btc15mCompletedTrade = {
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
    };

    await this.runtime.budget.addFunds(roundUsd(sellPrice * position.shares), "btc15m-sell-filled");
    this.state.completedTrades = [...this.state.completedTrades, trade].slice(-500);
    await this.runtime.persistTrade(trade);
    this.pushLog(`SELL filled. PnL ${pnlUsd.toFixed(2)} (${trade.result}).`, trade.result === "win" ? "success" : "warn");
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
  }

  private async maybeResetBudget(now: number): Promise<void> {
    const budget = this.state.budget;
    if (!budget) {
      return;
    }

    const lastResetAt = budget.lastProfitResetAt ?? budget.updatedAt;
    const resetIntervalMs = this.config.budgetResetIntervalHours * 60 * 60 * 1000;
    if (now - lastResetAt < resetIntervalMs) {
      return;
    }

    const cycle = this.state.cycle;
    const hasActiveCycle = Boolean(cycle.buyOrder || cycle.sellOrder || cycle.position);
    if (hasActiveCycle || budget.lockedBudget > 0) {
      return;
    }

    const { snapshot, skimmedProfitUsd } = await this.runtime.budget.resetAvailableBudget(
      this.config.workingBudgetUsd,
      now,
      "btc15m-profit-skim",
    );
    this.state.budget = snapshot;
    this.state.analytics = computeAnalytics(this.state.completedTrades, snapshot);
    if (skimmedProfitUsd > 0) {
      this.pushLog(`Budget reset: skimmed ${formatUsd(skimmedProfitUsd)} profit.`, "success");
    }
  }

  private hasCompletedTrade(marketSlug: string, bettingSide: Btc15mSide): boolean {
    return this.state.completedTrades.some((trade) => (
      trade.marketSlug === marketSlug && trade.bettingSide === bettingSide
    ));
  }

  private async getBestBid(tokenId: string): Promise<number | null> {
    const snapshotBid = this.bookSnapshots.get(tokenId)?.bestBid;
    if (snapshotBid !== null && snapshotBid !== undefined) {
      return snapshotBid;
    }
    const top = await this.runtime.getTopOfBook?.(tokenId);
    if (top) {
      this.bookSnapshots.set(tokenId, top);
      return top.bestBid;
    }
    return null;
  }

  private async syncRecoveredPositionBudget(costBasisUsd: number): Promise<void> {
    try {
      await this.runtime.budget.reserve(costBasisUsd, "btc15m-live-position-recovered");
      await this.runtime.budget.consume(costBasisUsd, "btc15m-live-position-recovered");
      await this.refreshBudget();
    } catch (error) {
      this.pushLog(
        `Recovered position budget sync skipped: ${error instanceof Error ? error.message : String(error)}.`,
        "warn",
      );
    }
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

  private buildIdleStatus(trades: Btc15mCompletedTrade[]): Btc15mBotStatus {
    return {
      enginePhase: "stopped",
      dryRun: this.dryRun,
      config: this.config,
      market: null,
      marketStartBtcPrice: null,
      currentBtcPrice: null,
      cycle: emptyCycle(),
      completedTrades: trades,
      analytics: computeAnalytics(trades, null),
      budget: null,
      logs: [],
      updatedAt: this.runtime.now(),
      lastError: null,
    };
  }

  private pushLog(message: string, type: Btc15mLogEntry["type"]): void {
    const entry: Btc15mLogEntry = {
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
  trades: Btc15mCompletedTrade[],
  budget: BudgetSnapshot | null,
): Btc15mAnalyticsSummary {
  const wins = trades.filter((trade) => trade.result === "win").length;
  const totalPnlUsd = roundUsd(trades.reduce((sum, trade) => sum + trade.pnlUsd, 0));
  return {
    totalTrades: trades.length,
    wins,
    losses: trades.length - wins,
    winRate: trades.length > 0 ? wins / trades.length : 0,
    totalPnlUsd,
    remainingBudgetUsd: budget?.availableBudget ?? 0,
  };
}

function cloneStatus(status: Btc15mBotStatus): Btc15mBotStatus {
  return JSON.parse(JSON.stringify(status)) as Btc15mBotStatus;
}

function matchesOrder(message: ScalperUserWsMessage, order: Btc15mTrackedOrder): boolean {
  return Boolean(message.orderId && order.orderId && message.orderId === order.orderId);
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

function formatUsd(value: number): string {
  return `$${roundUsd(value).toFixed(2)}`;
}

function normalizeSellPrice(value: number): number {
  if (!Number.isFinite(value)) {
    return MIN_CLOB_PRICE;
  }
  const ticked = Math.floor(value * 100) / 100;
  return Math.min(MAX_CLOB_PRICE, Math.max(MIN_CLOB_PRICE, roundUsd(ticked)));
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}
