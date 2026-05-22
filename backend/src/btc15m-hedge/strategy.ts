import { randomUUID } from "node:crypto";

import type { ScalperUserWsMessage } from "../scalper-user-ws.js";
import type { BudgetSnapshot } from "../budget-manager.js";
import { emptyHedgeCycle } from "./state-store.js";
import type {
  Btc15mHedgeBotConfig,
  Btc15mHedgeBotStatus,
  Btc15mHedgeCompletedCycle,
  Btc15mHedgeCycleState,
  Btc15mHedgeLegState,
  Btc15mHedgeLogEntry,
  Btc15mHedgeMarketView,
  Btc15mHedgeRuntimeStateUpdate,
  Btc15mHedgeSide,
} from "./types.js";

const MAX_LOG_ENTRIES = 100;
type FillLot = { shares: number; price: number };

export interface PlaceOrderArgs {
  tokenId: string;
  side: "buy" | "sell";
  price: number;
  size: number;
}

export interface Btc15mHedgeRuntime {
  now: () => number;
  resolveMarket: () => Promise<Btc15mHedgeMarketView | null>;
  placeLimitOrder: (args: PlaceOrderArgs) => Promise<unknown>;
  cancelOrder: (orderId: string) => Promise<unknown>;
  appendCompletedCycle: (cycle: Btc15mHedgeCompletedCycle) => Promise<void>;
  budget?: {
    reserve: (amount: number, reason?: string) => Promise<void>;
    release: (amount: number, reason?: string) => Promise<void>;
    consume: (amount: number, reason?: string) => Promise<void>;
    snapshot?: () => Promise<BudgetSnapshot | null>;
  };
  persistRuntimeState?: (state: Btc15mHedgeRuntimeStateUpdate) => Promise<void>;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export interface Btc15mHedgeBotStartOptions {
  runImmediateTick?: boolean;
  scheduleLoop?: boolean;
}

export interface Btc15mHedgeBotOptions {
  config: Btc15mHedgeBotConfig;
  dryRun: boolean;
  runtime: Btc15mHedgeRuntime;
  initialCompletedCycles?: Btc15mHedgeCompletedCycle[];
  initialRuntimeState?: Partial<Btc15mHedgeRuntimeStateUpdate>;
}

export class Btc15mHedgeBot {
  private readonly runtime: Btc15mHedgeRuntime;
  private readonly config: Btc15mHedgeBotConfig;
  private readonly dryRun: boolean;
  private readonly bookSnapshots = new Map<string, { bestBid: number | null; bestAsk: number | null }>();
  private readonly liveOrderSides = new Map<string, "buy" | "sell">();
  private readonly orderMatchedTotals = new Map<string, number>();
  private readonly orderReservedUsd = new Map<string, number>();
  private readonly fillLots: Record<Btc15mHedgeSide, FillLot[]> = { up: [], down: [] };
  private unwindRealizedPnlUsd = 0;
  private tickInProgress = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private state: Btc15mHedgeBotStatus;

  constructor(options: Btc15mHedgeBotOptions) {
    this.runtime = options.runtime;
    this.config = options.config;
    this.dryRun = options.dryRun;
    this.state = this.buildIdleStatus(options.initialCompletedCycles ?? []);
    if (options.initialRuntimeState) {
      this.state.market = options.initialRuntimeState.market ?? null;
      this.state.marketStartBtcPrice = options.initialRuntimeState.marketStartBtcPrice ?? null;
      this.state.currentBtcPrice = options.initialRuntimeState.currentBtcPrice ?? null;
      this.state.cycle = options.initialRuntimeState.cycle ?? this.state.cycle;
      this.state.logs = options.initialRuntimeState.logs ?? [];
      this.state.lastError = options.initialRuntimeState.lastError ?? null;
      this.state.enginePhase = "stopped";
      this.hydrateTransientState();
    }
  }

  getStatus(): Btc15mHedgeBotStatus {
    return JSON.parse(JSON.stringify(this.state)) as Btc15mHedgeBotStatus;
  }

  updateBook(tokenId: string, snapshot: { bestBid: number | null; bestAsk: number | null }): void {
    this.bookSnapshots.set(tokenId, snapshot);
  }

  async start(options: Btc15mHedgeBotStartOptions = {}): Promise<void> {
    if (this.state.enginePhase === "running") {
      return;
    }
    this.state.enginePhase = "running";
    this.state.lastError = null;
    this.pushLog(`BTC 15m Hedge bot started (${this.dryRun ? "SIM" : "LIVE"}).`, "success");
    await this.persistRuntimeState();

    if (options.runImmediateTick !== false) {
      await this.runOneTick();
    }

    if (options.scheduleLoop !== false && !this.tickTimer) {
      this.tickTimer = (this.runtime.setIntervalFn ?? setInterval)(() => {
        void this.runOneTick();
      }, Math.max(500, this.config.tickIntervalSec * 1000));
    }
  }

  stop(): void {
    if (this.tickTimer) {
      (this.runtime.clearIntervalFn ?? clearInterval)(this.tickTimer);
      this.tickTimer = null;
    }
    this.state.enginePhase = "stopped";
    this.pushLog("BTC 15m Hedge bot stopped.", "info");
    void this.persistRuntimeState();
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
        if (!this.state.market) {
          this.state.market = null;
          this.state.cycle = emptyHedgeCycle();
        } else {
          this.pushLog("Market resolver returned no market. Keeping current hedge state.", "warn");
        }
        this.touch();
        await this.persistRuntimeState();
        return;
      }

      if (!this.state.market || this.state.market.slug !== resolvedMarket.slug) {
        await this.cancelAllLiveOrders("market-switch");
        await this.finalizeCurrentCycle("market-switch");
        this.switchMarket(resolvedMarket);
      } else {
        this.state.market = resolvedMarket;
      }

      this.recomputeDerivedPairState();

      if (this.state.cycle.phase === "waiting_market") {
        this.state.cycle.phase = "building_pair";
      }

      if (this.state.cycle.phase === "paired_holding" && this.shouldForceUnwind(now)) {
        await this.forceUnwind();
        this.touch();
        await this.persistRuntimeState();
        return;
      }

      if (this.state.cycle.phase === "paired_holding" || this.state.cycle.phase === "cycle_done") {
        this.touch();
        await this.persistRuntimeState();
        return;
      }

      if (this.state.cycle.phase === "unwinding") {
        this.touch();
        await this.persistRuntimeState();
        return;
      }

      if (this.shouldAssemblePair()) {
        await this.transitionToPairedHolding();
        if (this.shouldForceUnwind(now)) {
          await this.forceUnwind();
        }
        this.touch();
        await this.persistRuntimeState();
        return;
      }

      if (this.shouldForceUnwind(now)) {
        await this.forceUnwind();
        this.touch();
        await this.persistRuntimeState();
        return;
      }

      if (this.shouldStopNewEntry(now)) {
        await this.cancelLiveBuyOrders();
        if (!this.hasMeaningfulCycleProgress()) {
          this.state.cycle.phase = "market_idle";
        }
        this.touch();
        await this.persistRuntimeState();
        return;
      }

      if (this.state.cycle.phase === "building_pair") {
        await this.maintainBuyOrders();
      }

      this.touch();
      await this.persistRuntimeState();
    } catch (error) {
      this.fail(error, "BTC 15m Hedge tick failed");
      await this.persistRuntimeState();
    } finally {
      this.tickInProgress = false;
    }
  }

  async handleUserWsMessage(message: ScalperUserWsMessage): Promise<void> {
    if (this.state.enginePhase !== "running") {
      return;
    }

    const side = this.matchLeg(message);
    if (!side) {
      return;
    }

    const leg = this.getLeg(side);
    const orderId = leg.orderId;
    if (!orderId) {
      return;
    }

    const orderSide = this.liveOrderSides.get(orderId);
    if (!orderSide) {
      return;
    }

    if (isFailureStatus(message.status)) {
      if (orderSide === "buy") {
        await this.releaseRemainingReservation(orderId, "hedge-buy-failed");
      }
      this.clearOrder(side);
      this.recomputeDerivedPairState();
      if (orderSide === "sell" && this.state.cycle.phase === "unwinding" && !this.hasActiveSellOrders()) {
        await this.completeUnwoundCycle();
      }
      await this.persistRuntimeState();
      return;
    }

    const delta = this.extractFillDelta(orderId, leg, message);
    if (delta <= 0) {
      return;
    }

    if (orderSide === "buy") {
      this.applyBuyFill(side, delta);
      if (isTerminalFillStatus(message.status) || leg.orderSize <= 0) {
        this.clearOrder(side);
      }
    } else {
      this.applySellFill(side, delta);
      if (isTerminalFillStatus(message.status) || leg.orderSize <= 0) {
        this.clearOrder(side);
        if (this.state.cycle.phase === "unwinding" && !this.hasActiveSellOrders()) {
          await this.completeUnwoundCycle();
        }
      }
    }

    this.recomputeDerivedPairState();
    await this.persistRuntimeState();
  }

  private async maintainBuyOrders(): Promise<void> {
    const market = this.state.market;
    const target = this.config.targetCombinedPrice;
    if (!market || target === null) {
      return;
    }
    const upAsk = this.bookSnapshots.get(market.upTokenId)?.bestAsk ?? null;
    const downAsk = this.bookSnapshots.get(market.downTokenId)?.bestAsk ?? null;
    if (upAsk === null || downAsk === null || upAsk <= 0 || downAsk <= 0) {
      return;
    }

    const upFilled = this.state.cycle.upLeg.filledShares;
    const downFilled = this.state.cycle.downLeg.filledShares;

    if (upFilled === downFilled) {
      if (roundPrice(upAsk + downAsk) > target) {
        await this.cancelLiveBuyOrders();
        return;
      }
      await this.ensureBuyOrder("up", market.upTokenId);
      await this.ensureBuyOrder("down", market.downTokenId);
      return;
    }

    if (upFilled > downFilled) {
      await this.cancelIfBuy("up");
      const upUnpairedAvg = this.computeUnpairedAverage("up");
      if (upUnpairedAvg !== null && roundPrice(upUnpairedAvg + downAsk) <= target) {
        await this.ensureBuyOrder("down", market.downTokenId);
      } else {
        await this.cancelIfBuy("down");
      }
      return;
    }

    await this.cancelIfBuy("down");
    const downUnpairedAvg = this.computeUnpairedAverage("down");
    if (downUnpairedAvg !== null && roundPrice(downUnpairedAvg + upAsk) <= target) {
      await this.ensureBuyOrder("up", market.upTokenId);
    } else {
      await this.cancelIfBuy("up");
    }
  }

  private async ensureBuyOrder(side: Btc15mHedgeSide, tokenId: string): Promise<void> {
    const leg = this.getLeg(side);
    if (leg.orderId && this.liveOrderSides.get(leg.orderId) === "buy") {
      return;
    }

    const remaining = roundShares(this.config.sharesPerSide - leg.filledShares);
    if (remaining <= 0) {
      return;
    }

    const ask = this.bookSnapshots.get(tokenId)?.bestAsk ?? null;
    if (ask === null || ask <= 0) {
      return;
    }

    const reservationUsd = roundPrice(ask * remaining);
    await this.runtime.budget?.reserve(reservationUsd, `btc15m-hedge-${side}-buy`);
    let response: unknown;
    try {
      response = await this.runtime.placeLimitOrder({
        tokenId,
        side: "buy",
        price: roundPrice(ask),
        size: remaining,
      });
    } catch (error) {
      await this.runtime.budget?.release(reservationUsd, `btc15m-hedge-${side}-buy-failed`);
      throw error;
    }
    const orderId = extractOrderId(response) ?? `${side}-buy-${randomUUID()}`;
    leg.tokenId = tokenId;
    leg.orderId = orderId;
    leg.orderPrice = roundPrice(ask);
    leg.orderSize = remaining;
    leg.orderStatus = "open";
    this.liveOrderSides.set(orderId, "buy");
    this.orderMatchedTotals.set(orderId, 0);
    this.orderReservedUsd.set(orderId, reservationUsd);
    this.pushLog(`BUY ${side.toUpperCase()} @ ${formatPrice(ask)} submitted (${orderId}).`, "info");
  }

  private shouldAssemblePair(): boolean {
    return this.state.cycle.pairedShares > 0 &&
      this.config.targetCombinedPrice !== null &&
      this.state.cycle.combinedAverage !== null &&
      this.state.cycle.combinedAverage <= this.config.targetCombinedPrice;
  }

  private async transitionToPairedHolding(): Promise<void> {
    await this.cancelLiveBuyOrders();
    this.recomputeDerivedPairState();
    this.state.cycle.phase = "paired_holding";
    this.state.cycle.pairAssembledAt ??= this.runtime.now();
    this.pushLog("Hedge pair assembled. Holding to market completion.", "success");
  }

  private shouldForceUnwind(now: number): boolean {
    const market = this.state.market;
    if (!market) {
      return false;
    }
    if (
      this.state.cycle.phase !== "building_pair" &&
      this.state.cycle.phase !== "paired_holding"
    ) {
      return false;
    }
    if (
      this.state.cycle.phase === "paired_holding" &&
      this.state.cycle.unpairedUpShares <= 0 &&
      this.state.cycle.unpairedDownShares <= 0
    ) {
      return false;
    }
    const timeLeftMs = market.endTimeMs - now;
    return timeLeftMs < this.config.forceUnwindThresholdMin * 60_000;
  }

  private shouldStopNewEntry(now: number): boolean {
    const market = this.state.market;
    if (!market || this.state.cycle.phase !== "building_pair") {
      return false;
    }
    const timeLeftMs = market.endTimeMs - now;
    return timeLeftMs < this.config.entryCutoffMin * 60_000;
  }

  private async forceUnwind(): Promise<void> {
    await this.cancelLiveBuyOrders();
    this.recomputeDerivedPairState();
    this.state.cycle.phase = "unwinding";

    const sellOrdersPlaced = await Promise.all([
      this.placeUnpairedSell("up"),
      this.placeUnpairedSell("down"),
    ]);

    if (!sellOrdersPlaced.some(Boolean)) {
      await this.completeUnwoundCycle();
      return;
    }

    this.pushLog("Force unwind started for unpaired remainder.", "warn");
  }

  private async placeUnpairedSell(side: Btc15mHedgeSide): Promise<boolean> {
    const leg = this.getLeg(side);
    const remainder = side === "up"
      ? this.state.cycle.unpairedUpShares
      : this.state.cycle.unpairedDownShares;

    if (remainder <= 0 || !leg.tokenId) {
      return false;
    }

    if (leg.orderId && this.liveOrderSides.get(leg.orderId) === "sell") {
      return true;
    }

    const bid = this.bookSnapshots.get(leg.tokenId)?.bestBid ?? null;
    if (bid === null || bid <= 0) {
      return false;
    }

    const response = await this.runtime.placeLimitOrder({
      tokenId: leg.tokenId,
      side: "sell",
      price: roundPrice(bid),
      size: roundShares(remainder),
    });
    const orderId = extractOrderId(response) ?? `${side}-sell-${randomUUID()}`;
    leg.orderId = orderId;
    leg.orderPrice = roundPrice(bid);
    leg.orderSize = roundShares(remainder);
    leg.orderStatus = "open";
    this.liveOrderSides.set(orderId, "sell");
    this.orderMatchedTotals.set(orderId, 0);
    this.pushLog(`SELL ${side.toUpperCase()} @ ${formatPrice(bid)} submitted (${orderId}).`, "warn");
    return true;
  }

  private async completeUnwoundCycle(): Promise<void> {
    this.recomputeDerivedPairState();
    this.state.cycle.phase = "cycle_done";
    this.pushLog("Unwind completed for current market.", "info");
    await this.appendCompletedCycleOnce(
      this.state.cycle.pairedShares > 0 ? "partial_unwind" : "failed_to_pair",
    );
  }

  private async finalizeCurrentCycle(reason: "market-switch"): Promise<void> {
    if (!this.state.market || this.state.cycle.completionLocked) {
      return;
    }

    if (this.state.cycle.phase === "paired_holding") {
      await this.appendCompletedCycleOnce("paired_hold");
      return;
    }

    if (reason === "market-switch" && this.hasMeaningfulCycleProgress()) {
      await this.appendCompletedCycleOnce(
        this.state.cycle.pairedShares > 0 ? "partial_unwind" : "failed_to_pair",
      );
    }
  }

  private hasMeaningfulCycleProgress(): boolean {
    return this.state.cycle.upLeg.filledShares > 0 ||
      this.state.cycle.downLeg.filledShares > 0 ||
      this.state.cycle.pairedShares > 0;
  }

  private async appendCompletedCycleOnce(
    result: Btc15mHedgeCompletedCycle["result"],
  ): Promise<void> {
    if (!this.state.market || this.state.cycle.completionLocked) {
      return;
    }

    const cycle: Btc15mHedgeCompletedCycle = {
      id: `${this.state.market.slug}:${this.state.cycle.cycleStartedAt ?? this.runtime.now()}`,
      marketSlug: this.state.market.slug,
      targetCombinedPrice: this.config.targetCombinedPrice ?? 0,
      maxSharesPerSide: this.config.sharesPerSide,
      pairedShares: this.state.cycle.pairedShares,
      avgUpPrice: this.state.cycle.pairedAvgUp,
      avgDownPrice: this.state.cycle.pairedAvgDown,
      combinedAverage: this.state.cycle.combinedAverage,
      unpairedUnwindPnlUsd: result === "partial_unwind" || result === "failed_to_pair"
        ? this.computeUnpairedUnwindPnl()
        : 0,
      result,
      startedAt: this.state.cycle.cycleStartedAt ?? this.runtime.now(),
      closedAt: this.runtime.now(),
    };

    this.state.completedCycles = [...this.state.completedCycles, cycle].slice(-500);
    this.state.cycle.completionLocked = true;
    await this.runtime.appendCompletedCycle(cycle);
  }

  private computeUnpairedUnwindPnl(): number {
    if (this.unwindRealizedPnlUsd !== 0) {
      return roundPrice(this.unwindRealizedPnlUsd);
    }
    const up = computeLegMarketValue(this.state.cycle.upLeg, this.state.cycle.unpairedUpShares);
    const down = computeLegMarketValue(this.state.cycle.downLeg, this.state.cycle.unpairedDownShares);
    return roundPrice(up + down);
  }

  private recomputeDerivedPairState(): void {
    const pairedShares = roundShares(Math.min(
      totalLotShares(this.fillLots.up),
      totalLotShares(this.fillLots.down),
    ));

    this.state.cycle.pairedShares = pairedShares;
    this.state.cycle.unpairedUpShares = roundShares(Math.max(0, totalLotShares(this.fillLots.up) - pairedShares));
    this.state.cycle.unpairedDownShares = roundShares(Math.max(0, totalLotShares(this.fillLots.down) - pairedShares));
    this.state.cycle.pairedAvgUp = pairedShares > 0 ? averageLotPriceForPrefix(this.fillLots.up, pairedShares) : null;
    this.state.cycle.pairedAvgDown = pairedShares > 0 ? averageLotPriceForPrefix(this.fillLots.down, pairedShares) : null;
    this.state.cycle.combinedAverage = pairedShares > 0 &&
        this.state.cycle.pairedAvgUp !== null &&
        this.state.cycle.pairedAvgDown !== null
      ? roundPrice(this.state.cycle.pairedAvgUp + this.state.cycle.pairedAvgDown)
      : null;
  }

  private applyBuyFill(side: Btc15mHedgeSide, delta: number): void {
    const leg = this.getLeg(side);
    const fillSize = Math.min(delta, leg.orderSize > 0 ? leg.orderSize : delta);
    const fillPrice = leg.orderPrice ?? 0;
    const orderId = leg.orderId;
    this.fillLots[side].push({ shares: fillSize, price: fillPrice });
    leg.filledShares = roundShares(leg.filledShares + fillSize);
    leg.filledCostUsd = roundPrice(leg.filledCostUsd + fillSize * fillPrice);
    leg.avgEntryPrice = leg.filledShares > 0
      ? roundPrice(leg.filledCostUsd / leg.filledShares)
      : null;
    leg.orderSize = roundShares(Math.max(0, leg.orderSize - fillSize));
    leg.orderStatus = "matched";
    this.state.cycle.cycleStartedAt ??= this.runtime.now();
    if (orderId) {
      const matchedUsd = roundPrice(fillSize * fillPrice);
      const reserved = this.orderReservedUsd.get(orderId) ?? 0;
      const nextReserved = roundPrice(Math.max(0, reserved - matchedUsd));
      this.orderReservedUsd.set(orderId, nextReserved);
      void this.runtime.budget?.consume(matchedUsd, `btc15m-hedge-${side}-buy-fill`);
    }
  }

  private applySellFill(side: Btc15mHedgeSide, delta: number): void {
    const leg = this.getLeg(side);
    const fillSize = Math.min(delta, leg.orderSize > 0 ? leg.orderSize : delta, leg.filledShares);
    const fillPrice = leg.orderPrice ?? 0;
    const removedCost = consumeLotSharesFromTail(this.fillLots[side], fillSize);
    this.unwindRealizedPnlUsd = roundPrice(this.unwindRealizedPnlUsd + (fillSize * fillPrice) - removedCost);
    leg.filledShares = roundShares(Math.max(0, leg.filledShares - fillSize));
    leg.filledCostUsd = roundPrice(totalLotCost(this.fillLots[side]));
    leg.avgEntryPrice = leg.filledShares > 0
      ? roundPrice(leg.filledCostUsd / leg.filledShares)
      : null;
    leg.orderSize = roundShares(Math.max(0, leg.orderSize - fillSize));
    leg.orderStatus = "matched";
  }

  private extractFillDelta(orderId: string, leg: Btc15mHedgeLegState, message: ScalperUserWsMessage): number {
    const matchedTotal = extractMatchedSize(message);
    if (matchedTotal !== null) {
      const previous = this.orderMatchedTotals.get(orderId) ?? 0;
      const delta = roundShares(Math.max(0, matchedTotal - previous));
      this.orderMatchedTotals.set(orderId, Math.max(previous, matchedTotal));
      return delta;
    }

    if (isTerminalFillStatus(message.status)) {
      const fallback = roundShares(leg.orderSize);
      this.orderMatchedTotals.set(orderId, fallback);
      return fallback;
    }
    return 0;
  }

  private async cancelLiveBuyOrders(): Promise<void> {
    await Promise.all([
      this.cancelIfBuy("up"),
      this.cancelIfBuy("down"),
    ]);
  }

  private async cancelAllLiveOrders(reason: string): Promise<void> {
    await Promise.all([
      this.cancelIfSide("up", reason),
      this.cancelIfSide("down", reason),
    ]);
  }

  private async cancelIfBuy(side: Btc15mHedgeSide): Promise<void> {
    await this.cancelIfSide(side, "hedge-buy-cancel");
  }

  private async cancelIfSide(side: Btc15mHedgeSide, reason: string): Promise<void> {
    const leg = this.getLeg(side);
    if (!leg.orderId) {
      return;
    }
    const orderId = leg.orderId;
    const orderSide = this.liveOrderSides.get(orderId);
    if (!orderSide) {
      this.clearOrder(side);
      return;
    }
    await this.runtime.cancelOrder(orderId);
    if (orderSide === "buy") {
      await this.releaseRemainingReservation(orderId, reason);
    }
    this.clearOrder(side);
  }

  private clearOrder(side: Btc15mHedgeSide): void {
    const leg = this.getLeg(side);
    if (leg.orderId) {
      this.liveOrderSides.delete(leg.orderId);
      this.orderMatchedTotals.delete(leg.orderId);
      this.orderReservedUsd.delete(leg.orderId);
    }
    leg.orderId = null;
    leg.orderPrice = null;
    leg.orderSize = 0;
    leg.orderStatus = null;
  }

  private hasActiveSellOrders(): boolean {
    for (const side of ["up", "down"] as const) {
      const leg = this.getLeg(side);
      if (leg.orderId && this.liveOrderSides.get(leg.orderId) === "sell") {
        return true;
      }
    }
    return false;
  }

  private async releaseRemainingReservation(orderId: string, reason: string): Promise<void> {
    const reserved = this.orderReservedUsd.get(orderId) ?? 0;
    if (reserved > 0) {
      await this.runtime.budget?.release(reserved, reason);
    }
    this.orderReservedUsd.delete(orderId);
  }

  private getLeg(side: Btc15mHedgeSide): Btc15mHedgeLegState {
    return side === "up" ? this.state.cycle.upLeg : this.state.cycle.downLeg;
  }

  private computeUnpairedAverage(side: Btc15mHedgeSide): number | null {
    const pairedShares = this.state.cycle.pairedShares;
    const legLots = this.fillLots[side];
    const totalShares = totalLotShares(legLots);
    if (totalShares <= pairedShares) {
      return null;
    }
    return averageLotPriceForSuffix(legLots, totalShares - pairedShares);
  }

  private matchLeg(message: ScalperUserWsMessage): Btc15mHedgeSide | null {
    const up = this.state.cycle.upLeg;
    const down = this.state.cycle.downLeg;
    if (up.orderId && message.orderId === up.orderId) return "up";
    if (down.orderId && message.orderId === down.orderId) return "down";
    if (up.tokenId && message.assetIds.includes(up.tokenId)) return "up";
    if (down.tokenId && message.assetIds.includes(down.tokenId)) return "down";
    return null;
  }

  private switchMarket(market: Btc15mHedgeMarketView): void {
    this.state.market = market;
    this.state.marketStartBtcPrice = null;
    this.state.currentBtcPrice = null;
    this.state.cycle = emptyHedgeCycle();
    this.state.cycle.phase = "building_pair";
    this.state.cycle.upLeg.tokenId = market.upTokenId;
    this.state.cycle.downLeg.tokenId = market.downTokenId;
    this.fillLots.up = [];
    this.fillLots.down = [];
    this.liveOrderSides.clear();
    this.orderMatchedTotals.clear();
    this.orderReservedUsd.clear();
    this.unwindRealizedPnlUsd = 0;
    this.pushLog(`Switched to market ${market.slug}.`, "info");
  }

  private buildIdleStatus(completedCycles: Btc15mHedgeCompletedCycle[]): Btc15mHedgeBotStatus {
    return {
      enginePhase: "stopped",
      dryRun: this.dryRun,
      config: this.config,
      market: null,
      marketStartBtcPrice: null,
      currentBtcPrice: null,
      cycle: emptyHedgeCycle(),
      completedCycles,
      budget: null,
      logs: [],
      updatedAt: this.runtime.now(),
      lastError: null,
    };
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

  private pushLog(message: string, type: Btc15mHedgeLogEntry["type"]): void {
    this.state.logs = [{
      timestamp: this.runtime.now(),
      message,
      type,
    }, ...this.state.logs].slice(0, MAX_LOG_ENTRIES);
    this.touch();
  }

  private fail(error: unknown, prefix: string): void {
    const message = error instanceof Error ? error.message : String(error);
    this.state.lastError = `${prefix}: ${message}`;
    this.pushLog(this.state.lastError, "error");
  }

  private touch(): void {
    this.state.updatedAt = this.runtime.now();
  }

  private hydrateTransientState(): void {
    this.fillLots.up = synthesizeLots(this.state.cycle.upLeg);
    this.fillLots.down = synthesizeLots(this.state.cycle.downLeg);

    const orderKind = this.state.cycle.phase === "unwinding" ? "sell" : "buy";
    for (const side of ["up", "down"] as const) {
      const leg = this.getLeg(side);
      if (!leg.orderId) {
        continue;
      }
      this.liveOrderSides.set(leg.orderId, orderKind);
      this.orderMatchedTotals.set(leg.orderId, orderKind === "buy" ? leg.filledShares : 0);
      if (orderKind === "buy" && leg.orderPrice !== null && leg.orderSize > 0) {
        this.orderReservedUsd.set(leg.orderId, roundPrice(leg.orderPrice * leg.orderSize));
      }
    }
  }
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
  for (const key of ["matched_size", "matchedSize", "size_matched", "filledSize", "filled_size", "size"]) {
    const value = record[key];
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (Number.isFinite(parsed) && parsed >= 0) {
      return roundShares(parsed);
    }
  }
  return null;
}

function computeLegMarketValue(leg: Btc15mHedgeLegState, shares: number): number {
  if (shares <= 0 || leg.orderPrice === null || leg.avgEntryPrice === null) {
    return 0;
  }
  return roundPrice((leg.orderPrice - leg.avgEntryPrice) * shares);
}

function synthesizeLots(leg: Btc15mHedgeLegState): FillLot[] {
  if (leg.filledShares <= 0 || leg.avgEntryPrice === null) {
    return [];
  }
  return [{ shares: leg.filledShares, price: leg.avgEntryPrice }];
}

function totalLotShares(lots: FillLot[]): number {
  return roundShares(lots.reduce((sum, lot) => sum + lot.shares, 0));
}

function totalLotCost(lots: FillLot[]): number {
  return roundPrice(lots.reduce((sum, lot) => sum + lot.shares * lot.price, 0));
}

function averageLotPriceForPrefix(lots: FillLot[], shares: number): number | null {
  return averageLotPriceForSegment(lots, shares, "prefix");
}

function averageLotPriceForSuffix(lots: FillLot[], shares: number): number | null {
  return averageLotPriceForSegment(lots, shares, "suffix");
}

function averageLotPriceForSegment(
  lots: FillLot[],
  shares: number,
  mode: "prefix" | "suffix",
): number | null {
  let remaining = roundShares(shares);
  if (remaining <= 0) {
    return null;
  }
  const source = mode === "prefix" ? lots : [...lots].reverse();
  let cost = 0;
  let filled = 0;
  for (const lot of source) {
    if (remaining <= 0) {
      break;
    }
    const take = Math.min(remaining, lot.shares);
    cost += take * lot.price;
    filled += take;
    remaining = roundShares(remaining - take);
  }
  return filled > 0 ? roundPrice(cost / filled) : null;
}

function consumeLotSharesFromTail(lots: FillLot[], shares: number): number {
  let remaining = roundShares(shares);
  let removedCost = 0;
  while (remaining > 0 && lots.length > 0) {
    const last = lots[lots.length - 1];
    if (!last) {
      break;
    }
    if (last.shares <= remaining) {
      removedCost += last.shares * last.price;
      remaining = roundShares(remaining - last.shares);
      lots.pop();
      continue;
    }
    removedCost += remaining * last.price;
    last.shares = roundShares(last.shares - remaining);
    remaining = 0;
  }
  return roundPrice(removedCost);
}

function isFailureStatus(status: string | null): boolean {
  return status === "failed" || status === "rejected" || status === "canceled" || status === "cancelled";
}

function isTerminalFillStatus(status: string | null): boolean {
  return status === "filled" || status === "completed";
}

function formatPrice(value: number): string {
  return roundPrice(value).toFixed(2);
}

function roundPrice(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundShares(value: number): number {
  return Math.round(value * 100) / 100;
}
