import type { Settings } from "../config.js";
import { logEvent } from "../event-log.js";
import { MarketScanner } from "../market-scanner.js";
import type { IMarket } from "../models.js";
import { PolymarketService } from "../polymarket-service.js";
import {
  ScalperUserWs,
  type ScalperUserWsMessage,
} from "../scalper-user-ws.js";

import { createBudgetManager } from "./budget-manager.js";
import { createScalperStateStore } from "./state-store.js";
import type { ScalperTrackedOrder } from "./types.js";

let activeStrategy: ScalperStrategy | null = null;

export async function startScalperStrategy(settings: Settings): Promise<void> {
  await reconcileScalperState(settings);

  if (activeStrategy) {
    return;
  }

  const strategy = new ScalperStrategy(settings);
  await strategy.start();
  activeStrategy = strategy;
}

export function stopScalperStrategy(): void {
  activeStrategy?.stop();
  activeStrategy = null;
}

export function getScalperStatus(): { active: boolean } {
  return { active: activeStrategy !== null };
}

export async function reconcileScalperState(settings: Settings): Promise<void> {
  const service = PolymarketService.getInstance(settings);
  await service.initialize();

  const store = createScalperStateStore({
    filePath: settings.scalper.stateFile,
    maxBotBudget: settings.scalper.maxBotBudget,
  });
  const budget = createBudgetManager({
    store,
    maxBotBudget: settings.scalper.maxBotBudget,
    balanceProvider: service,
  });

  let exchangeOrders: Array<{ id?: string }> = [];
  try {
    exchangeOrders = await service.getOpenOrders();
  } catch (error) {
    console.error("[SCALPER] Failed to fetch open orders for reconciliation", error);
    return;
  }

  const liveOrderIds = new Set(
    exchangeOrders
      .map((order) => (typeof order.id === "string" ? order.id : null))
      .filter((value): value is string => value !== null),
  );

  const trackedOrders = await store.listTrackedOrders();
  for (const order of trackedOrders) {
    if (!order.orderId || !isOpenStatus(order.status)) {
      continue;
    }

    if (liveOrderIds.has(order.orderId)) {
      continue;
    }

    const scope = order.marketSlug || order.orderId;
    if (order.side === "buy" && order.reservedBudget > 0) {
      await budget.release(order.reservedBudget, `reconcile ghost buy ${scope}`);
    }

    logEvent(
      scope,
      `Removed stale local ${order.side.toUpperCase()} order ${order.orderId} not found in Polymarket open orders`,
      "warn",
      "auto",
    );

    await store.removeTrackedOrder(order.id);
  }
}

class ScalperStrategy {
  private readonly scanner = new MarketScanner();
  private readonly service: PolymarketService;
  private readonly store;
  private readonly budget;
  private readonly userWs: ScalperUserWs;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private expiryTimer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;
  private stopped = false;

  constructor(private readonly settings: Settings) {
    this.service = PolymarketService.getInstance(settings);
    this.store = createScalperStateStore({
      filePath: settings.scalper.stateFile,
      maxBotBudget: settings.scalper.maxBotBudget,
    });
    this.budget = createBudgetManager({
      store: this.store,
      maxBotBudget: settings.scalper.maxBotBudget,
      balanceProvider: this.service,
    });
    this.userWs = new ScalperUserWs((message) => {
      void this.handleUserMessage(message);
    });
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.service.initialize();
    await this.budget.initialize();
    await reconcileScalperState(this.settings);
    await this.userWs.start();
    await this.scanOnce();

    this.scanTimer = setInterval(() => {
      void this.scanOnce();
    }, this.settings.scalper.scannerPollIntervalSec * 1000);

    this.expiryTimer = setInterval(() => {
      void this.monitorExpirations();
    }, 1000);
  }

  stop(): void {
    this.stopped = true;
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = null;
    }
    this.userWs.stop();
  }

  private async scanOnce(): Promise<void> {
    if (this.stopped || this.scanning) {
      return;
    }

    this.scanning = true;
    try {
      await reconcileScalperState(this.settings);

      const markets = await this.scanner.fetchMarkets(250);
      const trackedOrders = await this.store.listTrackedOrders();

      for (const market of markets) {
        const outcome = selectOutcome(market);
        if (!outcome) {
          continue;
        }

        if (
          trackedOrders.some(
            (order) =>
              order.marketSlug === market.slug &&
              order.tokenId === outcome.tokenId &&
              isOpenStatus(order.status),
          )
        ) {
          continue;
        }

        const buyCost = roundUsd(
          this.settings.scalper.buyPriceLimit * this.settings.scalper.orderSize,
        );
        const budgetSnapshot = await this.budget.getSnapshot();
        if (budgetSnapshot.availableBudget < buyCost) {
          continue;
        }

        try {
          await this.budget.reserve(buyCost, `reserve buy ${market.slug}`);
        } catch {
          continue;
        }

        let reservedBudget = buyCost;
        try {
          const response = await this.service.placeLimitOrder({
            tokenId: outcome.tokenId,
            side: "buy",
            price: this.settings.scalper.buyPriceLimit,
            size: this.settings.scalper.orderSize,
            tickSize: "0.01",
          });

          const orderId =
            extractOrderId(response) ??
            buildSyntheticOrderId("buy", market.slug, outcome.tokenId);

          await this.store.upsertTrackedOrder({
            id: orderId,
            orderId,
            marketId: market.marketId,
            marketSlug: market.slug,
            tokenId: outcome.tokenId,
            outcome: outcome.label,
            conditionId: market.conditionId ?? null,
            side: "buy",
            status: this.settings.dryRun ? "open" : "pending",
            price: this.settings.scalper.buyPriceLimit,
            size: this.settings.scalper.orderSize,
            reservedBudget,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            matchedSize: 0,
            remainingSize: this.settings.scalper.orderSize,
            expiresAt: null,
            endDateIso: market.endDateIso,
            proceedsReceived: 0,
            dryRun: this.settings.dryRun,
            errorMessage: null,
          });
        } catch (error) {
          await this.budget.release(buyCost, `release failed buy ${market.slug}`);
          reservedBudget = 0;
          console.error("[SCALPER] Failed to place buy order", error);
        }
      }
    } finally {
      this.scanning = false;
    }
  }

  private async handleUserMessage(message: ScalperUserWsMessage): Promise<void> {
    if (this.stopped) {
      return;
    }

    const trackedOrders = await this.store.listTrackedOrders();
    const matches = trackedOrders.filter((order) => {
      if (message.orderId && order.orderId === message.orderId) {
        return true;
      }
      return message.assetIds.includes(order.tokenId);
    });

    for (const order of matches) {
      const nextStatus = deriveStatus(order.status, message);
      const nextMatchedSize = Math.max(order.matchedSize ?? 0, extractMatchedSize(message));
      const deltaMatched = Math.max(0, nextMatchedSize - (order.matchedSize ?? 0));
      const nextRemaining = Math.max(0, order.size - nextMatchedSize);

      let nextReservedBudget = order.reservedBudget;
      let nextProceeds = order.proceedsReceived ?? 0;

      if (order.side === "buy" && deltaMatched > 0) {
        const consumedBudget = roundUsd(deltaMatched * order.price);
        await this.budget.consume(consumedBudget, `consume buy fill ${order.id}`);
        nextReservedBudget = Math.max(0, roundUsd(order.reservedBudget - consumedBudget));
      }

      if (order.side === "sell" && deltaMatched > 0) {
        const proceeds = roundUsd(deltaMatched * order.price);
        await this.budget.addFunds(proceeds, `sell fill ${order.id}`);
        nextProceeds = roundUsd(nextProceeds + proceeds);
      }

      const updatedOrder: ScalperTrackedOrder = {
        ...order,
        status: nextStatus,
        matchedSize: nextMatchedSize,
        remainingSize: nextRemaining,
        reservedBudget: nextReservedBudget,
        proceedsReceived: nextProceeds,
        updatedAt: Date.now(),
      };
      await this.store.upsertTrackedOrder(updatedOrder);

      if (
        order.side === "buy" &&
        deltaMatched > 0 &&
        (nextStatus === "partial" || nextStatus === "filled")
      ) {
        await this.ensureSellOrder(updatedOrder, deltaMatched);
      }

      if (
        order.side === "buy" &&
        ["cancelled", "expired", "failed"].includes(nextStatus) &&
        updatedOrder.reservedBudget > 0
      ) {
        await this.budget.release(
          updatedOrder.reservedBudget,
          `release cancelled buy ${order.id}`,
        );
        await this.store.upsertTrackedOrder({
          ...updatedOrder,
          reservedBudget: 0,
          updatedAt: Date.now(),
        });
      }
    }
  }

  private async ensureSellOrder(
    buyOrder: ScalperTrackedOrder,
    sizeDelta: number,
  ): Promise<void> {
    const trackedOrders = await this.store.listTrackedOrders();
    const existingSell = trackedOrders.find(
      (order) =>
        order.side === "sell" &&
        order.marketSlug === buyOrder.marketSlug &&
        order.tokenId === buyOrder.tokenId &&
        isOpenStatus(order.status),
    );

    if (existingSell) {
      return;
    }

    try {
      const response = await this.service.placeLimitOrder({
        tokenId: buyOrder.tokenId,
        side: "sell",
        price: this.settings.scalper.sellPriceLimit,
        size: sizeDelta,
        tickSize: "0.01",
      });

      const orderId =
        extractOrderId(response) ??
        buildSyntheticOrderId("sell", buyOrder.marketSlug, buyOrder.tokenId);

      await this.store.upsertTrackedOrder({
        id: orderId,
        orderId,
        marketId: buyOrder.marketId,
        marketSlug: buyOrder.marketSlug,
        tokenId: buyOrder.tokenId,
        outcome: buyOrder.outcome,
        conditionId: buyOrder.conditionId,
        side: "sell",
        status: this.settings.dryRun ? "open" : "pending",
        price: this.settings.scalper.sellPriceLimit,
        size: sizeDelta,
        reservedBudget: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        matchedSize: 0,
        remainingSize: sizeDelta,
        expiresAt: null,
        endDateIso: buyOrder.endDateIso,
        proceedsReceived: 0,
        dryRun: this.settings.dryRun,
        errorMessage: null,
      });
    } catch (error) {
      console.error("[SCALPER] Failed to place sell order", error);
    }
  }

  private async monitorExpirations(): Promise<void> {
    if (this.stopped) {
      return;
    }

    await reconcileScalperState(this.settings);

    const trackedOrders = await this.store.listTrackedOrders();
    const markets = buildTrackedMarkets(trackedOrders);
    const refreshed = await this.scanner.refreshTrackedMarkets(markets);

    const pendingCancels: Array<Promise<void>> = [];

    for (const order of trackedOrders) {
      const refreshedMarket = order.marketId ? refreshed.get(order.marketId) : undefined;
      const endDateIso = refreshedMarket?.endDateIso ?? order.endDateIso ?? null;
      const secondsLeft = getSecondsLeft(endDateIso);
      if (secondsLeft === null || !isOpenStatus(order.status)) {
        continue;
      }

      if (order.side === "buy" && secondsLeft <= this.settings.scalper.cancelBuyBeforeSec) {
        pendingCancels.push(this.expireBuyOrder(order, endDateIso));
      }

      if (order.side === "sell" && secondsLeft <= this.settings.scalper.cancelSellBeforeSec) {
        pendingCancels.push(this.expireSellOrder(order, endDateIso));
      }
    }

    if (pendingCancels.length > 0) {
      await Promise.all(pendingCancels);
    }
  }

  private async expireBuyOrder(
    order: ScalperTrackedOrder,
    endDateIso: string | null,
  ): Promise<void> {
    try {
      if (!this.settings.dryRun && order.orderId) {
        await this.service.cancelOrder(order.orderId);
      }
    } catch (error) {
      console.error("[SCALPER] Failed to cancel buy order", error);
    }

    if (order.reservedBudget > 0) {
      await this.budget.release(order.reservedBudget, `expire buy ${order.id}`);
    }

    await this.store.upsertTrackedOrder({
      ...order,
      status: "expired",
      reservedBudget: 0,
      endDateIso,
      updatedAt: Date.now(),
    });
  }

  private async expireSellOrder(
    order: ScalperTrackedOrder,
    endDateIso: string | null,
  ): Promise<void> {
    try {
      if (!this.settings.dryRun && order.orderId) {
        await this.service.cancelOrder(order.orderId);
      }
    } catch (error) {
      console.error("[SCALPER] Failed to cancel sell order", error);
    }

    await this.store.upsertTrackedOrder({
      ...order,
      status: "expired",
      endDateIso,
      updatedAt: Date.now(),
    });

    const remainder = order.remainingSize ?? Math.max(0, order.size - (order.matchedSize ?? 0));
    if (remainder <= 0) {
      return;
    }

    try {
      await this.service.placeLimitOrder({
        tokenId: order.tokenId,
        side: "sell",
        price: 0.01,
        size: remainder,
        tickSize: "0.01",
      });
    } catch (error) {
      console.error("[SCALPER] Failed emergency sell after expiry", error);
    }
  }

}

function buildTrackedMarkets(orders: ScalperTrackedOrder[]): IMarket[] {
  const byMarket = new Map<string, IMarket>();
  for (const order of orders) {
    if (!order.marketId) {
      continue;
    }

    if (!byMarket.has(order.marketId)) {
      byMarket.set(order.marketId, {
        marketId: order.marketId,
        slug: order.marketSlug,
        question: order.marketSlug,
        description: "",
        category: "",
        startDateIso: null,
        endDateIso: order.endDateIso ?? null,
        conditionId: order.conditionId ?? null,
        active: true,
        closed: false,
        liquidity: null,
        volume: null,
        outcomes: order.outcome
          ? [{ label: order.outcome, tokenId: order.tokenId }]
          : [],
        raw: {},
      });
    }
  }

  return [...byMarket.values()];
}

function selectOutcome(market: IMarket) {
  return (
    market.outcomes.find((outcome) => /^yes$/i.test(outcome.label)) ??
    market.outcomes.find((outcome) => /^no$/i.test(outcome.label)) ??
    market.outcomes[0] ??
    null
  );
}

function isOpenStatus(status: ScalperTrackedOrder["status"]): boolean {
  return ["pending", "open", "partial", "cancel_requested"].includes(status);
}

function deriveStatus(
  fallback: ScalperTrackedOrder["status"],
  message: ScalperUserWsMessage,
): ScalperTrackedOrder["status"] {
  if (message.eventType === "trade") {
    return "partial";
  }
  if (
    message.status === "filled" ||
    message.status === "matched" ||
    message.status === "completed"
  ) {
    return "filled";
  }
  if (
    message.status === "partially_filled" ||
    message.status === "partially_matched"
  ) {
    return "partial";
  }
  if (message.status === "canceled" || message.status === "cancelled") {
    return "cancelled";
  }
  if (message.status === "failed" || message.status === "rejected") {
    return "failed";
  }
  if (
    message.status === "open" ||
    message.status === "live" ||
    message.status === "pending"
  ) {
    return "open";
  }
  return fallback;
}

function extractMatchedSize(message: ScalperUserWsMessage): number {
  for (const value of [
    message.raw.size_matched,
    message.raw.matched_size,
    message.raw.matchedSize,
    message.raw.size,
  ]) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return 0;
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

function getSecondsLeft(endDateIso: string | null): number | null {
  if (!endDateIso) {
    return null;
  }
  const timestamp = Date.parse(endDateIso);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return Math.floor((timestamp - Date.now()) / 1000);
}

function buildSyntheticOrderId(
  side: string,
  marketSlug: string,
  tokenId: string,
): string {
  return `${side}:${marketSlug}:${tokenId}:${Date.now()}`;
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}
