import { loadSettings } from "./config.js";
import { GammaClient, parseMarket } from "./gamma.js";
import type { IMarket } from "./models.js";

export class MarketScanner {
  private readonly settings = loadSettings();
  private readonly gamma = new GammaClient(this.settings.gammaHost);

  async fetchMarkets(limit = 250): Promise<IMarket[]> {
    const rawMarkets = await this.gamma.listMarkets(limit, true, false, 0);
    return rawMarkets
      .map(parseMarket)
      .filter((market): market is IMarket => market !== null)
      .filter((market) => market.active && !market.closed)
      .filter((market) => (market.liquidity ?? 0) >= this.settings.minLiquidity);
  }

  async refreshTrackedMarkets(markets: IMarket[]): Promise<Map<string, IMarket>> {
    const refreshed = await Promise.all(
      markets.map(async (market) => {
        try {
          const raw = await this.gamma.getMarketBySlug(market.slug);
          return parseMarket(raw) as IMarket | null;
        } catch {
          return market;
        }
      }),
    );

    return new Map(
      refreshed
        .filter((market): market is IMarket => market !== null)
        .map((market) => [market.marketId, market]),
    );
  }
}
