// backend/src/neg-risk-split.ts
import { loadSettings } from "./config.js";
import { ClobPublicClient } from "./clob.js";

export interface SplitBin {
  label: string;
  yesTokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
}

export interface SplitAnalysis {
  eventSlug: string;
  eventTitle: string;
  resolutionDate: string;
  isNegRisk: boolean;
  negRiskConditionId: string | null;
  bins: SplitBin[];
  sumYesMid: number;
  arbOpportunity: "split" | "merge" | "none";
  isWeatherMarket: boolean;
}

export function parseEventSlug(url: string): string {
  const match = url.match(/polymarket\.com\/event\/([^/?#]+)/);
  if (!match) throw new Error("Could not parse Polymarket event URL");
  return match[1];
}

export async function analyzeNegRiskEvent(eventUrl: string): Promise<SplitAnalysis> {
  const settings = loadSettings();
  const eventSlug = parseEventSlug(eventUrl);

  const gammaHost = settings.gammaHost;

  const url = new URL("/events", gammaHost);
  url.searchParams.set("slug", eventSlug);
  url.searchParams.set("limit", "1");
  const eventsRes = await fetch(url.toString());
  if (!eventsRes.ok) throw new Error(`Gamma API error: ${eventsRes.status}`);
  const events = await eventsRes.json() as any[];
  if (!events || events.length === 0) throw new Error(`Event not found: ${eventSlug}`);

  const event = events[0];
  const markets: any[] = event.markets ?? [];
  const negRiskConditionId: string | null = event.negRiskId ?? null;
  const isNegRisk = !!negRiskConditionId && markets.length > 1;

  const clobHost = settings.polymarketHost;
  const clob = new ClobPublicClient(clobHost);

  const bins: SplitBin[] = await Promise.all(
    markets.map(async (m: any) => {
      const tokenIds: string[] = m.clobTokenIds ?? [];
      const yesTokenId = tokenIds[0] ?? "";

      let bestBid: number | null = null;
      let bestAsk: number | null = null;
      let midPrice: number | null = null;
      if (yesTokenId) {
        try {
          const top = await clob.getTopOfBook(yesTokenId);
          bestBid = top.bestBid;
          bestAsk = top.bestAsk;
          midPrice = top.midpoint;
        } catch { /* no liquidity */ }
      }

      return {
        label: m.groupItemTitle ?? m.outcomes?.[0] ?? m.question ?? "?",
        yesTokenId,
        bestBid,
        bestAsk,
        midPrice,
      };
    })
  );

  const sumYesMid = bins.reduce((s, b) => s + (b.midPrice ?? 0), 0);
  const ARB_THRESHOLD = 0.02;
  const arbOpportunity =
    sumYesMid < 1.0 - ARB_THRESHOLD ? "merge" :
    sumYesMid > 1.0 + ARB_THRESHOLD ? "split" : "none";

  const titleLower = (event.title ?? eventSlug).toLowerCase();
  const isWeatherMarket = titleLower.includes("temperature") ||
    titleLower.includes("highest temp") ||
    titleLower.includes("weather");

  return {
    eventSlug,
    eventTitle: event.title ?? eventSlug,
    resolutionDate: event.endDate ?? "",
    isNegRisk,
    negRiskConditionId,
    bins,
    sumYesMid,
    arbOpportunity,
    isWeatherMarket,
  };
}
