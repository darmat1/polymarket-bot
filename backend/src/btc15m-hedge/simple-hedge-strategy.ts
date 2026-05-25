import { randomUUID } from "node:crypto";
import type {
  Btc15mHedgeBotConfig,
  Btc15mHedgeBotStatus,
  Btc15mHedgeCompletedCycle,
  Btc15mHedgeCycleState,
  Btc15mHedgeLegState,
  Btc15mHedgeLogEntry,
  Btc15mHedgeMarketView,
} from "./types.js";

const MAX_LOG_ENTRIES = 100;
const ENTRY_CUTOFF_MS = 3 * 60 * 1000;

export interface PlaceOrderArgs {
  tokenId: string;
  side: "buy" | "sell";
  price: number;
  size: number;
}

export interface SimpleHedgeRuntime {
  now: () => number;
  getMarketFromUrl: (url: string) => Promise<Btc15mHedgeMarketView | null>;
  placeLimitOrder: (args: PlaceOrderArgs) => Promise<{ orderId: string }>;
  getOrderStatus: (orderId: string) => Promise<{ status: string; matched: number; price: number }>;
  cancelOrder: (orderId: string) => Promise<void>;
  getLiveStateForAsset?: (tokenId: string) => Promise<{
    openOrders: Array<{ id: string }>;
    position: { size: number; avgPrice: number } | null;
  }>;
}

export interface SimpleHedgeBotOptions {
  config: Btc15mHedgeBotConfig;
  dryRun: boolean;
  runtime: SimpleHedgeRuntime;
}

export class SimpleHedgeBot {
  private config: Btc15mHedgeBotConfig;
  private dryRun: boolean;
  private runtime: SimpleHedgeRuntime;
  
  private enginePhase: "stopped" | "running" = "stopped";
  private market: Btc15mHedgeMarketView | null = null;
  private cycle: Btc15mHedgeCycleState;
  private completedCycles: Btc15mHedgeCompletedCycle[] = [];
  private logs: Btc15mHedgeLogEntry[] = [];
  private lastError: string | null = null;
  
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options: SimpleHedgeBotOptions) {
    this.config = options.config;
    this.dryRun = options.dryRun;
    this.runtime = options.runtime;
    this.cycle = this.createEmptyCycle();
  }

  async start(): Promise<void> {
    if (this.enginePhase === "running") {
      throw new Error("Bot is already running");
    }

    this.pushLog("Starting simple hedge bot", "info");
    this.enginePhase = "running";
    this.lastError = null;

    try {
      await this.tryAdvanceToTradableMarket();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.pushLog(`Start failed: ${this.lastError}`, "error");
      await this.stop();
      throw error;
    }

    // Start polling loop
    this.tickInterval = setInterval(() => void this.tick(), 5000);
  }

  async stop(): Promise<void> {
    if (this.enginePhase === "stopped") {
      return;
    }

    this.pushLog("Stopping simple hedge bot", "info");
    
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }

    // Cancel any open orders
    if (
      this.cycle.upLeg.orderId &&
      this.cycle.upLeg.orderStatus !== "matched" &&
      this.cycle.upLeg.orderStatus !== "cancelled"
    ) {
      try {
        await this.runtime.cancelOrder(this.cycle.upLeg.orderId);
        this.pushLog("Cancelled UP order", "info");
      } catch (error) {
        this.pushLog(`Failed to cancel UP order: ${error}`, "warn");
      }
    }

    if (
      this.cycle.downLeg.orderId &&
      this.cycle.downLeg.orderStatus !== "matched" &&
      this.cycle.downLeg.orderStatus !== "cancelled"
    ) {
      try {
        await this.runtime.cancelOrder(this.cycle.downLeg.orderId);
        this.pushLog("Cancelled DOWN order", "info");
      } catch (error) {
        this.pushLog(`Failed to cancel DOWN order: ${error}`, "warn");
      }
    }

    this.enginePhase = "stopped";
  }

  getStatus(): Btc15mHedgeBotStatus {
    return {
      enginePhase: this.enginePhase,
      dryRun: this.dryRun,
      config: this.config,
      market: this.market,
      cycle: this.cycle,
      completedCycles: this.completedCycles,
      logs: this.logs,
      updatedAt: this.runtime.now(),
      lastError: this.lastError,
    };
  }

  private async placeHedgeOrders(): Promise<void> {
    if (!this.market) {
      throw new Error("No market loaded");
    }

    const { buyPrice, shares } = this.config;

    // Place UP order
    try {
      this.pushLog(`Placing UP order: ${shares} shares @ $${buyPrice}`, "info");
      const upOrder = await this.runtime.placeLimitOrder({
        tokenId: this.market.upTokenId,
        side: "buy",
        price: buyPrice,
        size: shares,
      });
      
      this.cycle.upLeg.tokenId = this.market.upTokenId;
      this.cycle.upLeg.orderId = upOrder.orderId;
      this.cycle.upLeg.orderPrice = buyPrice;
      this.cycle.upLeg.orderSize = shares;
      this.cycle.upLeg.orderStatus = "open";
      
      this.pushLog(`UP order placed: ${upOrder.orderId}`, "success");
    } catch (error) {
      this.lastError = `Failed to place UP order: ${error}`;
      this.pushLog(this.lastError, "error");
      throw error;
    }

    // Place DOWN order
    try {
      this.pushLog(`Placing DOWN order: ${shares} shares @ $${buyPrice}`, "info");
      const downOrder = await this.runtime.placeLimitOrder({
        tokenId: this.market.downTokenId,
        side: "buy",
        price: buyPrice,
        size: shares,
      });
      
      this.cycle.downLeg.tokenId = this.market.downTokenId;
      this.cycle.downLeg.orderId = downOrder.orderId;
      this.cycle.downLeg.orderPrice = buyPrice;
      this.cycle.downLeg.orderSize = shares;
      this.cycle.downLeg.orderStatus = "open";
      
      this.pushLog(`DOWN order placed: ${downOrder.orderId}`, "success");
    } catch (error) {
      if (this.cycle.upLeg.orderId && this.cycle.upLeg.orderStatus !== "matched") {
        await this.cancelOutstandingOrder(this.cycle.upLeg.orderId, "UP");
        this.cycle.upLeg.orderStatus = "cancelled";
      }
      this.lastError = `Failed to place DOWN order: ${error}`;
      this.pushLog(this.lastError, "error");
      throw error;
    }

    this.cycle.phase = "waiting_fills";
  }

  private async tick(): Promise<void> {
    if (this.enginePhase !== "running") {
      return;
    }

    try {
      if (this.cycle.phase === "waiting_fills") {
        await this.checkOrderFills();
        await this.checkMarketExpiry();
      } else if (this.cycle.phase === "paired_holding") {
        await this.checkMarketExpiry();
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.pushLog(`Tick error: ${this.lastError}`, "error");
    }
  }

  private async checkOrderFills(): Promise<void> {
    let upFilled = false;
    let downFilled = false;

    // Check UP order
    if (this.cycle.upLeg.orderId && this.cycle.upLeg.orderStatus !== "matched") {
      try {
        const status = await this.runtime.getOrderStatus(this.cycle.upLeg.orderId);
        this.cycle.upLeg.orderStatus = status.status;
        
        if (status.status === "matched" && status.matched > 0) {
          this.cycle.upLeg.filledShares = status.matched;
          this.cycle.upLeg.filledCostUsd = status.matched * status.price;
          this.cycle.upLeg.avgEntryPrice = status.price;
          upFilled = true;
          this.pushLog(`UP order filled: ${status.matched} shares @ $${status.price}`, "success");
        }
      } catch (error) {
        this.pushLog(`Failed to check UP order: ${error}`, "warn");
      }
    } else {
      upFilled = true;
    }

    // Check DOWN order
    if (this.cycle.downLeg.orderId && this.cycle.downLeg.orderStatus !== "matched") {
      try {
        const status = await this.runtime.getOrderStatus(this.cycle.downLeg.orderId);
        this.cycle.downLeg.orderStatus = status.status;
        
        if (status.status === "matched" && status.matched > 0) {
          this.cycle.downLeg.filledShares = status.matched;
          this.cycle.downLeg.filledCostUsd = status.matched * status.price;
          this.cycle.downLeg.avgEntryPrice = status.price;
          downFilled = true;
          this.pushLog(`DOWN order filled: ${status.matched} shares @ $${status.price}`, "success");
        }
      } catch (error) {
        this.pushLog(`Failed to check DOWN order: ${error}`, "warn");
      }
    } else {
      downFilled = true;
    }

    // If both filled, move to paired holding
    if (upFilled && downFilled) {
      const pairedShares = Math.min(this.cycle.upLeg.filledShares, this.cycle.downLeg.filledShares);
      this.cycle.pairedShares = pairedShares;
      this.cycle.phase = "paired_holding";
      this.pushLog(`Hedge complete! Holding ${pairedShares} paired shares until expiry`, "success");
    }
  }

  private async checkMarketExpiry(): Promise<void> {
    if (!this.market) {
      return;
    }

    const now = this.runtime.now();
    if (now >= this.market.endTimeMs) {
      this.pushLog("Market expired. Hedge cycle finished.", "info");
      await this.closeExpiredCycle(now);
      await this.stop();
    }
  }

  private async tryAdvanceToTradableMarket(): Promise<void> {
    const market = await this.loadMarketFromConfig();
    if (!market) {
      return;
    }

    const now = this.runtime.now();
    const timeRemainingMs = market.endTimeMs - now;
    this.market = market;

    if (timeRemainingMs <= ENTRY_CUTOFF_MS) {
      throw new Error(
        `Refusing to start on ${market.slug}: only ${Math.max(0, Math.floor(timeRemainingMs / 1000))}s remain, below the 3 minute cutoff.`,
      );
    }

    this.pushLog(`Loaded market: ${market.question}`, "success");
    this.cycle = this.createEmptyCycle();
    this.cycle.phase = "placing_orders";
    this.cycle.cycleStartedAt = now;
    await this.assertNoExistingExposure(market);
    await this.placeHedgeOrders();
  }

  private async loadMarketFromConfig(): Promise<Btc15mHedgeMarketView | null> {
    try {
      const market = await this.runtime.getMarketFromUrl(this.config.marketUrl);
      if (!market) {
        throw new Error("Could not load market from URL");
      }
      if (this.market?.slug !== market.slug) {
        this.pushLog(`Tracking market ${market.slug}`, "info");
      }
      this.lastError = null;
      return market;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.pushLog(`Failed to load market: ${this.lastError}`, "error");
      return null;
    }
  }

  private async closeExpiredCycle(closedAt: number): Promise<void> {
    if (this.cycle.upLeg.orderId && this.cycle.upLeg.orderStatus !== "matched") {
      await this.cancelOutstandingOrder(this.cycle.upLeg.orderId, "UP");
      this.cycle.upLeg.orderStatus = "cancelled";
    }
    if (this.cycle.downLeg.orderId && this.cycle.downLeg.orderStatus !== "matched") {
      await this.cancelOutstandingOrder(this.cycle.downLeg.orderId, "DOWN");
      this.cycle.downLeg.orderStatus = "cancelled";
    }

    if (this.cycle.upLeg.filledShares > 0 || this.cycle.downLeg.filledShares > 0) {
      const completedCycle: Btc15mHedgeCompletedCycle = {
        id: randomUUID(),
        marketSlug: this.market?.slug || "unknown",
        buyPrice: this.config.buyPrice,
        shares: this.config.shares,
        upFilled: this.cycle.upLeg.filledShares,
        downFilled: this.cycle.downLeg.filledShares,
        avgUpPrice: this.cycle.upLeg.avgEntryPrice,
        avgDownPrice: this.cycle.downLeg.avgEntryPrice,
        totalCostUsd: this.cycle.upLeg.filledCostUsd + this.cycle.downLeg.filledCostUsd,
        result: this.cycle.pairedShares > 0 ? "paired_hold" : "partial_fill",
        startedAt: this.cycle.cycleStartedAt || closedAt,
        closedAt,
      };

      this.completedCycles.push(completedCycle);
    }

    this.cycle = this.createEmptyCycle();
    this.cycle.phase = "waiting_market";
  }

  private async cancelOutstandingOrder(orderId: string, side: "UP" | "DOWN"): Promise<void> {
    try {
      await this.runtime.cancelOrder(orderId);
      this.pushLog(`Cancelled ${side} order`, "info");
    } catch (error) {
      this.pushLog(`Failed to cancel ${side} order: ${error}`, "warn");
    }
  }

  private async assertNoExistingExposure(market: Btc15mHedgeMarketView): Promise<void> {
    if (!this.runtime.getLiveStateForAsset || this.dryRun) {
      return;
    }

    const [upState, downState] = await Promise.all([
      this.runtime.getLiveStateForAsset(market.upTokenId),
      this.runtime.getLiveStateForAsset(market.downTokenId),
    ]);

    const upOpenSize = upState.position?.size ?? 0;
    const downOpenSize = downState.position?.size ?? 0;
    const upOpenOrders = upState.openOrders.length;
    const downOpenOrders = downState.openOrders.length;

    if (upOpenSize > 0 || downOpenSize > 0 || upOpenOrders > 0 || downOpenOrders > 0) {
      throw new Error(
        `Existing exposure detected for ${market.slug}: UP position=${upOpenSize}, DOWN position=${downOpenSize}, UP open orders=${upOpenOrders}, DOWN open orders=${downOpenOrders}. Refusing to place new hedge orders.`,
      );
    }
  }

  private createEmptyCycle(): Btc15mHedgeCycleState {
    return {
      phase: "waiting_market",
      cycleStartedAt: null,
      upLeg: this.createEmptyLeg("up"),
      downLeg: this.createEmptyLeg("down"),
      pairedShares: 0,
    };
  }

  private createEmptyLeg(side: "up" | "down"): Btc15mHedgeLegState {
    return {
      tokenId: null,
      side,
      orderId: null,
      orderPrice: null,
      orderSize: 0,
      orderStatus: null,
      filledShares: 0,
      filledCostUsd: 0,
      avgEntryPrice: null,
    };
  }

  private pushLog(message: string, type: "info" | "warn" | "error" | "success"): void {
    this.logs.push({
      timestamp: this.runtime.now(),
      message,
      type,
    });
    
    if (this.logs.length > MAX_LOG_ENTRIES) {
      this.logs = this.logs.slice(-MAX_LOG_ENTRIES);
    }
  }
}
