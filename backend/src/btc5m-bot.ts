import {
  getOpenPositions,
} from "./app.js";
import type { Settings } from "./config.js";
import { logEvent } from "./event-log.js";
import { GammaClient } from "./gamma.js";
import { PolymarketService } from "./polymarket-service.js";
import {
  ScalperUserWs,
  type ScalperUserWsMessage,
} from "./scalper-user-ws.js";
import {
  cloneBtc5mStatus,
  createConfiguredIdleStatus,
  createIdleStatus,
  peekBtc5mMarketSelection,
} from "./btc5m/index.js";
import type {
  Btc5mBotLogEntry,
  Btc5mBotRuntime,
  Btc5mBotStartOptions,
  Btc5mBotStatus,
  Btc5mMarketSelection,
  Btc5mMarketView,
} from "./btc5m/index.js";

let activeBot: Btc5mBot | null = null;

export async function startBtc5mBot(settings: Settings): Promise<Btc5mBotStatus> {
  if (activeBot) {
    return activeBot.getStatus();
  }

  const bot = new Btc5mBot(settings);
  await bot.start();
  activeBot = bot;
  return bot.getStatus();
}

export function stopBtc5mBot(settings: Settings): Btc5mBotStatus {
  if (activeBot) {
    activeBot.stop();
    const status = activeBot.getStatus();
    activeBot = null;
    return status;
  }

  return createConfiguredIdleStatus(settings);
}

export async function getBtc5mBotStatus(settings: Settings): Promise<Btc5mBotStatus> {
  if (activeBot) {
    return activeBot.getStatus();
  }

  const status = createConfiguredIdleStatus(settings);
  const selection = await peekBtc5mMarketSelection(settings);
  status.currentMarket = selection.current;
  status.nextMarket = selection.next;
  status.phase = selection.next || selection.current ? "idle" : "looking_for_market";
  return status;
}

export class Btc5mBot {
  private readonly gamma: GammaClient;
  private readonly service: Pick<PolymarketService, "initialize" | "placeLimitOrder" | "cancelOrder">;
  private readonly userWs: Pick<ScalperUserWs, "start" | "stop">;
  private readonly runtime: Btc5mBotRuntime;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private tickInProgress = false;
  private state: Btc5mBotStatus;
  private queuedMarket: Btc5mMarketView | null = null;
  private tradeMarket: Btc5mMarketView | null = null;

  constructor(
    private readonly settings: Settings,
    runtime: Btc5mBotRuntime = {},
  ) {
    this.runtime = runtime;
    this.gamma = new GammaClient(settings.gammaHost);
    this.service = runtime.service ?? PolymarketService.getInstance(settings);
    this.userWs =
      runtime.createUserWs?.((message) => {
        void this.handleUserMessage(message);
      }) ??
      new ScalperUserWs((message) => {
        void this.handleUserMessage(message);
      });
    this.state = createIdleStatus();
    this.state.dryRun = settings.dryRun;
    this.state.orderSize = settings.btc5m.orderSize;
    this.state.buyPriceLimit = settings.btc5m.buyPriceLimit;
    this.state.sellPriceLimit = settings.btc5m.sellPriceLimit;
    this.state.active = true;
  }

  async start(options: Btc5mBotStartOptions = {}): Promise<void> {
    this.stopped = false;
    this.state.active = true;
    this.state.lastError = null;
    this.touch();
    await this.service.initialize();
    await this.userWs.start();
    this.pushLog(
      `BTC 5m bot started (${this.settings.dryRun ? "dry-run" : "live"}).`,
      "success",
    );
    if (options.runImmediateTick !== false) {
      await this.tick();
    }
    if (options.scheduleLoop !== false) {
      this.tickTimer = (this.runtime.setIntervalFn ?? setInterval)(() => {
        void this.tick();
      }, this.settings.btc5m.marketScanIntervalSec * 1000);
    }
  }

  stop(): void {
    this.stopped = true;
    this.state.active = false;
    if (this.tickTimer) {
      (this.runtime.clearIntervalFn ?? clearInterval)(this.tickTimer);
      this.tickTimer = null;
    }
    this.userWs.stop();
    this.pushLog("BTC 5m bot stopped.", "info");
    this.state.phase = "idle";
    this.touch();
  }

  getStatus(): Btc5mBotStatus {
    return cloneBtc5mStatus(this.state);
  }

  async tickNow(): Promise<void> {
    await this.tick();
  }

  async processUserMessage(message: ScalperUserWsMessage): Promise<void> {
    await this.handleUserMessage(message);
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.tickInProgress) {
      return;
    }

    this.tickInProgress = true;
    try {
      const selection = await this.findMarketSelection();
      this.state.currentMarket = selection.current;
      this.state.nextMarket = selection.next;
      this.queuedMarket = this.refreshTrackedMarket(this.queuedMarket, selection);
      this.tradeMarket = this.refreshTrackedMarket(this.tradeMarket, selection);
      this.touch();

      if (!selection.next && !selection.current && !this.queuedMarket && !this.tradeMarket) {
        if (this.state.phase !== "looking_for_market") {
          this.state.phase = "looking_for_market";
          this.pushLog("Waiting for current/next Bitcoin 5m markets.", "info");
        }
        return;
      }

      if (!this.queuedMarket && !this.tradeMarket) {
        this.selectQueuedMarket(selection.next);
      }

      await this.reconcileExpiredBuy(selection);

      if (this.state.buyOrderId || this.state.sellOrderId || this.tradeMarket) {
        return;
      }

      if (["placing_buy", "buy_open", "placing_sell", "sell_open"].includes(this.state.phase)) {
        return;
      }

      if (!this.queuedMarket) {
        this.state.phase = this.state.lastCompletedMarketSlug
          ? "completed_waiting_next"
          : "looking_for_market";
        this.touch();
        return;
      }

      this.tradeMarket = this.queuedMarket;
      await this.placeBuyOrder(this.tradeMarket);
    } catch (error) {
      this.fail(error, "BTC 5m bot tick failed");
    } finally {
      this.tickInProgress = false;
    }
  }

  private async handleUserMessage(message: ScalperUserWsMessage): Promise<void> {
    if (this.stopped || this.settings.dryRun) {
      return;
    }

    const tradeMarket = this.tradeMarket;
    if (!tradeMarket) {
      return;
    }

    const relevantByAsset = message.assetIds.includes(tradeMarket.upTokenId);

    if (
      this.state.buyOrderId &&
      (message.orderId === this.state.buyOrderId || relevantByAsset)
    ) {
      if (isFailureStatus(message.status)) {
        this.state.buyOrderId = null;
        this.state.phase = "error";
        this.state.lastError = `Buy order ${message.status ?? "failed"}`;
        this.pushLog(`Buy order failed: ${message.status ?? "unknown"}.`, "error");
        return;
      }

      if (isFilledStatus(message.status)) {
        const fillSize = await this.resolveSellSize(tradeMarket.upTokenId, tradeMarket.slug);
        this.pushLog(
          `Buy filled on UP. Preparing sell for ${formatSize(fillSize)} shares at ${formatPrice(this.settings.btc5m.sellPriceLimit)}.`,
          "success",
        );
        this.state.buyOrderId = null;
        await this.placeSellOrder(tradeMarket, fillSize);
        return;
      }
    }

    if (
      this.state.sellOrderId &&
      (message.orderId === this.state.sellOrderId || relevantByAsset)
    ) {
      if (isFailureStatus(message.status)) {
        this.state.sellOrderId = null;
        this.state.phase = "error";
        this.state.lastError = `Sell order ${message.status ?? "failed"}`;
        this.pushLog(`Sell order failed: ${message.status ?? "unknown"}.`, "error");
        return;
      }

      if (isFilledStatus(message.status)) {
        this.completeCurrentMarket("Sell filled. Waiting for the next Bitcoin 5m market.");
      }
    }
  }

  private async placeBuyOrder(market: Btc5mMarketView): Promise<void> {
    this.state.phase = "placing_buy";
    this.state.lastError = null;
    this.touch();
    this.pushLog(
      `Placing BUY UP @ ${formatPrice(this.settings.btc5m.buyPriceLimit)} for market ${market.slug} with ${formatSize(this.settings.btc5m.orderSize)} shares.`,
      "info",
    );

    const response = await this.service.placeLimitOrder({
      tokenId: market.upTokenId,
      side: "buy",
      price: this.settings.btc5m.buyPriceLimit,
      size: this.settings.btc5m.orderSize,
      tickSize: "0.01",
    });

    const orderId =
      extractOrderId(response) ??
      `btc5m-buy:${market.slug}:${Date.now()}`;

    this.state.buyOrderId = orderId;
    this.state.phase = "buy_open";
    this.touch();
    this.pushLog(
      `BUY order submitted on UP @ ${formatPrice(this.settings.btc5m.buyPriceLimit)} (${orderId}). Waiting for fill.`,
      "success",
    );
    this.writeEvent(
      market.slug,
      `BTC5M BUY UP @ ${formatPrice(this.settings.btc5m.buyPriceLimit)} submitted (${orderId})`,
      "info",
    );

    if (this.settings.dryRun) {
      await this.handleDryRunBuyFill(market);
    }
  }

  private async reconcileExpiredBuy(selection: Btc5mMarketSelection): Promise<void> {
    if (!this.state.buyOrderId || !this.queuedMarket) {
      return;
    }

    const marketEndMs = this.queuedMarket.endDateIso ? Date.parse(this.queuedMarket.endDateIso) : Number.NaN;
    if (!Number.isFinite(marketEndMs) || marketEndMs > this.now()) {
      return;
    }

    try {
      await this.service.cancelOrder(this.state.buyOrderId);
    } catch {
      // ignore cancellation failure; order may already be gone
    }

    const expiredSlug = this.queuedMarket.slug;
    this.pushLog(`Queued BUY expired with market ${expiredSlug}. Rolling to next market.`, "warn");
    this.writeEvent(expiredSlug, `BTC5M BUY expired before fill; moving to next market`, "warn");
    this.state.buyOrderId = null;
    this.tradeMarket = null;
    this.queuedMarket = null;
    this.state.phase = "looking_for_market";

    if (selection.next && selection.next.slug !== expiredSlug) {
      this.selectQueuedMarket(selection.next);
    }
  }

  private async handleDryRunBuyFill(market: Btc5mMarketView): Promise<void> {
    this.pushLog("Dry-run: buy fill simulated instantly.", "warn");
    this.state.buyOrderId = null;
    await this.placeSellOrder(market, this.settings.btc5m.orderSize);
  }

  private async placeSellOrder(
    market: Btc5mMarketView,
    size: number,
  ): Promise<void> {
    this.state.phase = "placing_sell";
    this.touch();

    const sellSize = normalizeSize(size || this.settings.btc5m.orderSize);
    const response = await this.service.placeLimitOrder({
      tokenId: market.upTokenId,
      side: "sell",
      price: this.settings.btc5m.sellPriceLimit,
      size: sellSize,
      tickSize: "0.01",
    });

    const orderId =
      extractOrderId(response) ??
      `btc5m-sell:${market.slug}:${Date.now()}`;

    this.state.sellOrderId = orderId;
    this.state.phase = "sell_open";
    this.touch();
    this.pushLog(
      `SELL order submitted for all UP shares @ ${formatPrice(this.settings.btc5m.sellPriceLimit)} (${orderId}).`,
      "success",
    );
    this.writeEvent(
      market.slug,
      `BTC5M SELL UP @ ${formatPrice(this.settings.btc5m.sellPriceLimit)} submitted (${orderId})`,
      "info",
    );

    if (this.settings.dryRun) {
      this.completeCurrentMarket("Dry-run: sell fill simulated. Waiting for the next Bitcoin 5m market.");
    }
  }

  private completeCurrentMarket(message: string): void {
    const completedMarket = this.tradeMarket ?? this.queuedMarket;
    const slug = completedMarket?.slug ?? "btc5m";
    this.state.lastCompletedMarketSlug = completedMarket?.slug ?? null;
    this.state.buyOrderId = null;
    this.state.sellOrderId = null;
    this.queuedMarket = null;
    this.tradeMarket = null;
    this.state.phase = "completed_waiting_next";
    this.state.lastError = null;
    this.touch();
    this.pushLog(message, "success");
    this.writeEvent(slug, message, "success");
  }

  private async resolveSellSize(tokenId: string, marketSlug: string): Promise<number> {
    try {
      const payload = await (this.runtime.getOpenPositions ?? getOpenPositions)();
      const exact = payload.positions.find(
        (position) => position.asset === tokenId || position.slug === marketSlug,
      );
      if (typeof exact?.size === "number" && exact.size > 0) {
        return normalizeSize(exact.size);
      }
    } catch {
      // ignore and fall back to configured order size
    }

    return normalizeSize(this.settings.btc5m.orderSize);
  }

  private async findMarketSelection(): Promise<Btc5mMarketSelection> {
    if (this.runtime.findMarketSelection) {
      return this.runtime.findMarketSelection();
    }
    return peekBtc5mMarketSelection(this.settings, this.gamma, this.now());
  }

  private selectQueuedMarket(nextCandidate: Btc5mMarketView | null): void {
    if (!nextCandidate || nextCandidate.slug === this.state.lastCompletedMarketSlug) {
      return;
    }

    this.queuedMarket = nextCandidate;
    this.state.phase = "looking_for_market";
    this.pushLog(
      `Selected next market ${nextCandidate.slug}. Queueing BUY for ${formatSize(this.settings.btc5m.orderSize)} UP shares at ${formatPrice(this.settings.btc5m.buyPriceLimit)} before activation.`,
      "info",
    );
  }

  private refreshTrackedMarket(
    market: Btc5mMarketView | null,
    selection: Btc5mMarketSelection,
  ): Btc5mMarketView | null {
    if (!market) {
      return null;
    }

    return [selection.current, selection.next].find((entry) => entry?.slug === market.slug) ?? market;
  }

  private writeEvent(
    marketSlug: string,
    message: string,
    type: Btc5mBotLogEntry["type"],
  ): void {
    (this.runtime.logEvent ?? logEvent)(marketSlug, message, type);
  }

  private now(): number {
    return this.runtime.now?.() ?? Date.now();
  }

  private pushLog(
    message: string,
    type: Btc5mBotLogEntry["type"] = "info",
  ): void {
    const entry: Btc5mBotLogEntry = {
      timestamp: Date.now(),
      message,
      type,
    };
    this.state.logs = [entry, ...this.state.logs].slice(0, 40);
    this.touch();
  }

  private fail(error: unknown, prefix: string): void {
    const message = error instanceof Error ? error.message : String(error);
    this.state.phase = "error";
    this.state.lastError = message;
    this.state.buyOrderId = null;
    this.state.sellOrderId = null;
    this.tradeMarket = null;
    this.queuedMarket = null;
    this.pushLog(`${prefix}: ${message}`, "error");
  }

  private touch(): void {
    this.state.updatedAt = Date.now();
  }
}

export {
  peekBtc5mMarketSelection,
  peekCurrentBtc5mMarket,
} from "./btc5m/index.js";
export type {
  Btc5mBotLogEntry,
  Btc5mBotPhase,
  Btc5mBotRuntime,
  Btc5mBotStartOptions,
  Btc5mBotStatus,
  Btc5mMarketSelection,
  Btc5mMarketView,
} from "./btc5m/index.js";

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
