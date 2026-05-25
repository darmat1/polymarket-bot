import { PolymarketService } from "../polymarket-service.js";
import type { Settings } from "../config.js";
import { checkMarketUrl } from "./market-checker.js";
import { SimpleHedgeBot, type SimpleHedgeRuntime } from "./simple-hedge-strategy.js";
import type {
  Btc15mHedgeBotConfig,
  Btc15mHedgeBotStatus,
  Btc15mHedgeMarketView,
} from "./types.js";

export type {
  Btc15mHedgeBotConfig,
  Btc15mHedgeBotStatus,
} from "./types.js";

export interface StartBtc15mHedgeBotOptions {
  config: Btc15mHedgeBotConfig;
}

let activeBot: SimpleHedgeBot | null = null;

export async function startBtc15mHedgeBot(
  settings: Settings,
  options: StartBtc15mHedgeBotOptions,
): Promise<Btc15mHedgeBotStatus> {
  if (activeBot) {
    await stopBtc15mHedgeBot(settings);
  }

  const service = PolymarketService.getInstance(settings);
  await service.initialize();

  const runtime: SimpleHedgeRuntime = {
    now: () => Date.now(),
    
    getMarketFromUrl: async (url: string): Promise<Btc15mHedgeMarketView | null> => {
      const result = await checkMarketUrl(url, settings.gammaHost);
      
      if (!result.valid || !result.slug) {
        throw new Error(result.error || "Invalid market URL");
      }

      // If market is expired and we found a current one, use that
      if (result.isExpired && result.currentMarket) {
        return {
          slug: result.currentMarket.slug,
          question: result.currentMarket.question,
          startTimeMs: result.currentMarket.startTimeMs,
          endTimeMs: result.currentMarket.endTimeMs,
          priceToBeat: null,
          upTokenId: result.currentMarket.upTokenId,
          downTokenId: result.currentMarket.downTokenId,
        };
      }

      // If market is expired and no replacement found, refuse to start
      if (result.isExpired) {
        throw new Error(
          `Market "${result.slug}" is expired and no active replacement market was found. Please provide a URL to a currently active market.`,
        );
      }

      // Use the provided market
      if (!result.upTokenId || !result.downTokenId || !result.endTimeMs) {
        throw new Error("Market is missing required data");
      }

      return {
        slug: result.slug,
        question: result.question || result.slug,
        startTimeMs: result.startTimeMs || Date.now(),
        endTimeMs: result.endTimeMs,
        priceToBeat: null,
        upTokenId: result.upTokenId,
        downTokenId: result.downTokenId,
      };
    },

    placeLimitOrder: async (args) => {
      const order = (await service.placeLimitOrder({
        tokenId: args.tokenId,
        side: args.side,
        price: args.price,
        size: args.size,
      })) as { orderID?: string };
      return { orderId: order.orderID || "" };
    },

    getOrderStatus: async (orderId: string) => {
      const order = await service.getOrder(orderId);
      return {
        status: order.status,
        matched: parseFloat(order.size_matched) || 0,
        price: parseFloat(order.price) || 0,
      };
    },

    cancelOrder: async (orderId: string) => {
      await service.cancelOrder(orderId);
    },
    getLiveStateForAsset: async (tokenId: string) => service.getLiveStateForAsset(tokenId),
  };

  const bot = new SimpleHedgeBot({
    config: options.config,
    dryRun: settings.dryRun,
    runtime,
  });

  await bot.start();
  activeBot = bot;

  return bot.getStatus();
}

export async function stopBtc15mHedgeBot(
  settings: Settings,
): Promise<Btc15mHedgeBotStatus> {
  if (!activeBot) {
    return {
      enginePhase: "stopped",
      dryRun: settings.dryRun,
      config: { marketUrl: "", buyPrice: 0, shares: 0 },
      market: null,
      cycle: {
        phase: "waiting_market",
        cycleStartedAt: null,
        upLeg: {
          tokenId: null,
          side: "up",
          orderId: null,
          orderPrice: null,
          orderSize: 0,
          orderStatus: null,
          filledShares: 0,
          filledCostUsd: 0,
          avgEntryPrice: null,
        },
        downLeg: {
          tokenId: null,
          side: "down",
          orderId: null,
          orderPrice: null,
          orderSize: 0,
          orderStatus: null,
          filledShares: 0,
          filledCostUsd: 0,
          avgEntryPrice: null,
        },
        pairedShares: 0,
      },
      completedCycles: [],
      logs: [],
      updatedAt: Date.now(),
      lastError: null,
    };
  }

  await activeBot.stop();
  const status = activeBot.getStatus();
  activeBot = null;

  return status;
}

export async function getBtc15mHedgeBotStatus(
  settings: Settings,
): Promise<Btc15mHedgeBotStatus> {
  if (!activeBot) {
    return {
      enginePhase: "stopped",
      dryRun: settings.dryRun,
      config: { marketUrl: "", buyPrice: 0, shares: 0 },
      market: null,
      cycle: {
        phase: "waiting_market",
        cycleStartedAt: null,
        upLeg: {
          tokenId: null,
          side: "up",
          orderId: null,
          orderPrice: null,
          orderSize: 0,
          orderStatus: null,
          filledShares: 0,
          filledCostUsd: 0,
          avgEntryPrice: null,
        },
        downLeg: {
          tokenId: null,
          side: "down",
          orderId: null,
          orderPrice: null,
          orderSize: 0,
          orderStatus: null,
          filledShares: 0,
          filledCostUsd: 0,
          avgEntryPrice: null,
        },
        pairedShares: 0,
      },
      completedCycles: [],
      logs: [],
      updatedAt: Date.now(),
      lastError: null,
    };
  }

  return activeBot.getStatus();
}
