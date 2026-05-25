import { GammaClient } from "../gamma.js";
import { PolymarketMarketWs } from "../polymarket-market-ws.js";
import type { SearchEventSummary } from "../models.js";

export interface CheckMarketResult {
  valid: boolean;
  slug: string | null;
  question: string | null;
  crypto: string | null;
  timeframe: string | null;
  startTimeMs: number | null;
  endTimeMs: number | null;
  isExpired: boolean;
  upTokenId: string | null;
  downTokenId: string | null;
  upPrice: number | null;
  downPrice: number | null;
  currentMarket: {
    slug: string;
    question: string;
    startTimeMs: number;
    endTimeMs: number;
    upTokenId: string;
    downTokenId: string;
  } | null;
  error: string | null;
}

export async function checkMarketUrl(
  marketUrl: string,
  gammaHost: string,
  marketWs?: PolymarketMarketWs,
): Promise<CheckMarketResult> {
  try {
    // Extract slug from URL
    const slug = extractSlugFromUrl(marketUrl);
    if (!slug) {
      return {
        valid: false,
        slug: null,
        question: null,
        crypto: null,
        timeframe: null,
        startTimeMs: null,
        endTimeMs: null,
        isExpired: false,
        upTokenId: null,
        downTokenId: null,
        upPrice: null,
        downPrice: null,
        currentMarket: null,
        error: "Could not extract slug from URL",
      };
    }

    // Fetch market data
    const gamma = new GammaClient(gammaHost);
    const raw = await gamma.getMarketBySlug(slug);

    // Parse market info
    const question = typeof raw.question === "string" ? raw.question : null;
    const endTimeMs = parseDateMs(raw.endDate ?? raw.endDateIso ?? raw.end_time);
    const startTimeMs = parseDateMs(raw.startDate ?? raw.startDateIso ?? raw.start_time);

    if (!Number.isFinite(endTimeMs)) {
      return {
        valid: false,
        slug,
        question,
        crypto: null,
        timeframe: null,
        startTimeMs: null,
        endTimeMs: null,
        isExpired: false,
        upTokenId: null,
        downTokenId: null,
        upPrice: null,
        downPrice: null,
        currentMarket: null,
        error: "Could not parse market end time",
      };
    }

    // Detect crypto and timeframe
    const crypto = detectCrypto(slug, question);
    const timeframe = detectTimeframe(slug, question);

    console.log("[checkMarketUrl] slug=%s crypto=%s timeframe=%s isExpired=%s", slug, crypto, timeframe, endTimeMs < Date.now());

    // Parse tokens
    const tokens = parseOutcomeTokens(raw);
    console.log("[checkMarketUrl] tokens=%s", tokens ? `up=${tokens.up} down=${tokens.down}` : "null");

    if (!tokens) {
      return {
        valid: false,
        slug,
        question,
        crypto,
        timeframe,
        startTimeMs,
        endTimeMs,
        isExpired: false,
        upTokenId: null,
        downTokenId: null,
        upPrice: null,
        downPrice: null,
        currentMarket: null,
        error: "Could not parse UP/DOWN tokens",
      };
    }

    // Check if expired
    const now = Date.now();
    const isExpired = endTimeMs < now;

    let currentMarket = null;
    let upPrice: number | null = null;
    let downPrice: number | null = null;

    if (isExpired && crypto) {
      // Try to find current market (timeframe may be null)
      currentMarket = await findCurrentMarket(gamma, crypto, timeframe);
      
      // Get prices for current market if found
      if (currentMarket && marketWs) {
        const prices = await getPricesFromWs(marketWs, currentMarket.upTokenId, currentMarket.downTokenId);
        upPrice = prices.upPrice;
        downPrice = prices.downPrice;
      }
    } else if (!isExpired && marketWs) {
      // Get prices for the provided market
      const prices = await getPricesFromWs(marketWs, tokens.up, tokens.down);
      upPrice = prices.upPrice;
      downPrice = prices.downPrice;
    }

    return {
      valid: true,
      slug,
      question,
      crypto,
      timeframe,
      startTimeMs,
      endTimeMs,
      isExpired,
      upTokenId: tokens.up,
      downTokenId: tokens.down,
      upPrice,
      downPrice,
      currentMarket,
      error: null,
    };
  } catch (error) {
    return {
      valid: false,
      slug: null,
      question: null,
      crypto: null,
      timeframe: null,
      startTimeMs: null,
      endTimeMs: null,
      isExpired: false,
      upTokenId: null,
      downTokenId: null,
      upPrice: null,
      downPrice: null,
      currentMarket: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function extractSlugFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    
    // Find 'event' or 'market' in the path and take the next part as slug
    const eventIndex = parts.findIndex(p => p === "event" || p === "market");
    if (eventIndex >= 0 && eventIndex < parts.length - 1) {
      return parts[eventIndex + 1];
    }
    
    // Handle direct slug (last part of path)
    if (parts.length >= 1) {
      return parts[parts.length - 1];
    }
    
    return null;
  } catch {
    // Maybe it's just a slug
    const trimmed = url.trim();
    if (trimmed && !trimmed.includes("/") && !trimmed.includes(" ")) {
      return trimmed;
    }
    return null;
  }
}

function detectCrypto(slug: string, question: string | null): string | null {
  const text = `${slug} ${question || ""}`.toLowerCase();
  
  if (text.includes("btc") || text.includes("bitcoin")) return "BTC";
  if (text.includes("eth") || text.includes("ethereum")) return "ETH";
  if (text.includes("sol") || text.includes("solana")) return "SOL";
  if (text.includes("matic") || text.includes("polygon")) return "MATIC";
  if (text.includes("avax") || text.includes("avalanche")) return "AVAX";
  if (text.includes("hype") || text.includes("hyperliquid")) return "HYPE";
  if (text.includes("doge") || text.includes("dogecoin")) return "DOGE";
  if (text.includes("xrp") || text.includes("ripple")) return "XRP";
  if (text.includes("ada") || text.includes("cardano")) return "ADA";
  if (text.includes("dot") || text.includes("polkadot")) return "DOT";
  
  return null;
}

function detectTimeframe(slug: string, question: string | null): string | null {
  const text = `${slug} ${question || ""}`.toLowerCase();
  
  if (text.includes("5m") || text.includes("5-minute") || text.includes("5 minute")) return "5m";
  if (text.includes("15m") || text.includes("15-minute") || text.includes("15 minute")) return "15m";
  if (text.includes("30m") || text.includes("30-minute") || text.includes("30 minute")) return "30m";
  if (text.includes("1h") || text.includes("1-hour") || text.includes("1 hour")) return "1h";
  if (text.includes("4h") || text.includes("4-hour") || text.includes("4 hour")) return "4h";
  if (text.includes("daily") || text.includes("1d") || text.includes("24h")) return "1d";
  
  return null;
}

function parseOutcomeTokens(raw: Record<string, unknown>): { up: string; down: string } | null {
  const clobTokenIds = parseStringArray(raw.clobTokenIds ?? raw.tokenIds);
  const outcomes = parseStringArray(raw.outcomes);
  
  if (clobTokenIds.length !== 2 || outcomes.length !== 2) {
    return null;
  }

  const upIndex = outcomes.findIndex((outcome) => /^(up|yes)$/i.test(outcome.trim()));
  const downIndex = outcomes.findIndex((outcome) => /^(down|no)$/i.test(outcome.trim()));
  
  if (upIndex < 0 || downIndex < 0 || upIndex === downIndex) {
    return null;
  }

  return {
    up: clobTokenIds[upIndex],
    down: clobTokenIds[downIndex],
  };
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  if (typeof value !== "string") {
    return [];
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    // fall through
  }

  return trimmed
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((part) => part.trim().replace(/^"+|"+$/g, ""))
    .filter(Boolean);
}

function parseDateMs(value: unknown): number {
  if (typeof value === "number") {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

async function findCurrentMarket(
  gamma: GammaClient,
  crypto: string,
  timeframe: string | null,
): Promise<{
  slug: string;
  question: string;
  startTimeMs: number;
  endTimeMs: number;
  upTokenId: string;
  downTokenId: string;
} | null> {
  try {
    const cryptoName = CRYPTO_FULL_NAMES[crypto.toLowerCase()] || crypto;
    const now = Date.now();
    const slugPrefix = slugPrefixFor(crypto, timeframe);

    console.log("[findCurrentMarket] crypto=%s cryptoName=%s timeframe=%s", crypto, cryptoName, timeframe);

    // Step 1: scan slug candidates directly (most reliable)
    const slugCandidates = await scanMarketSlugs(gamma, slugPrefix, timeframe, now);
    console.log("[findCurrentMarket] slug scan found %d candidates", slugCandidates.length);

    // Step 2: also search events (finds markets not in slug pattern)
    const searchCandidates = await searchEventsForMarket(gamma, crypto, cryptoName, timeframe, now);
    console.log("[findCurrentMarket] search found %d candidates", searchCandidates.length);

    // Merge all candidates
    const allCandidates = [...slugCandidates, ...searchCandidates];

    // Deduplicate by slug
    const seen = new Set<string>();
    const unique = allCandidates.filter((c) => {
      if (seen.has(c.slug)) return false;
      seen.add(c.slug);
      return true;
    });

    if (unique.length === 0) return null;

    // Sort: active first (windowStart <= now < endTime), then closest windowStart
    unique.sort((a, b) => {
      const aWinStart = parseSlugTimestamp(a.slug);
      const bWinStart = parseSlugTimestamp(b.slug);
      const aActive = aWinStart <= now && a.endTimeMs > now ? 0 : 1;
      const bActive = bWinStart <= now && b.endTimeMs > now ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      // Both future: closest window start wins
      return Math.abs(aWinStart - now) - Math.abs(bWinStart - now);
    });

    console.log("[findCurrentMarket] BEST candidate: slug=%s winStartMs=%d endMs=%d now=%d",
      unique[0].slug, parseSlugTimestamp(unique[0].slug), unique[0].endTimeMs, now);

    return unique[0];
  } catch (e) {
    console.error("[findCurrentMarket] Error:", e);
    return null;
  }
}

async function scanMarketSlugs(
  gamma: GammaClient,
  slugPrefix: string,
  timeframe: string | null,
  now: number,
): Promise<Array<{
  slug: string;
  question: string;
  startTimeMs: number;
  endTimeMs: number;
  upTokenId: string;
  downTokenId: string;
}>> {
  const intervalSeconds = timeframe ? parseInt(timeframe) * 60 : 5 * 60;
  const nowUnixSeconds = Math.floor(now / 1000);
  const alignedMs = Math.floor(nowUnixSeconds / intervalSeconds) * intervalSeconds;

  const candidates: Array<{
    ts: number;
    slug: string;
    startTimeMs: number;
    endTimeMs: number;
    upTokenId: string;
    downTokenId: string;
    question: string;
  }> = [];

  // Scan a wide range: past 30 min + future 2 hours
  const range = Math.max(Math.ceil(7200 / intervalSeconds), 12);
  for (let i = -6; i <= range; i++) {
    const ts = alignedMs + i * intervalSeconds;
    const slug = `${slugPrefix}${ts}`;
    try {
      const raw = await gamma.getMarketBySlug(slug);
      const endTimeMs = parseDateMs(raw.endDate ?? raw.endDateIso ?? raw.end_time);
      if (!Number.isFinite(endTimeMs)) continue;
      const tokens = parseOutcomeTokens(raw);
      if (!tokens) continue;
      const startTimeMs = parseDateMs(raw.startDate ?? raw.startDateIso ?? raw.start_time);
      candidates.push({
        ts,
        slug,
        question: typeof raw.question === "string" ? raw.question : "",
        startTimeMs: Number.isFinite(startTimeMs) ? startTimeMs : Infinity,
        endTimeMs,
        upTokenId: tokens.up,
        downTokenId: tokens.down,
      });
    } catch {
      // market doesn't exist at this slug
    }
  }

  return candidates;
}

async function searchEventsForMarket(
  gamma: GammaClient,
  crypto: string,
  cryptoName: string,
  timeframe: string | null,
  now: number,
): Promise<Array<{
  slug: string;
  question: string;
  startTimeMs: number;
  endTimeMs: number;
  upTokenId: string;
  downTokenId: string;
}>> {
  const timeframeKeywords = timeframe
    ? [timeframe, timeframe.replace("m", "-minute").replace("h", "-hour")]
    : null;

  const queries = [`${cryptoName} up or down`, `${crypto} up or down`];
  if (timeframe) {
    queries.push(`up or down ${timeframe}`);
  }

  const allCandidates: Array<{
    slug: string;
    question: string;
    startTimeMs: number;
    endTimeMs: number;
    upTokenId: string;
    downTokenId: string;
  }> = [];

  for (const query of queries) {
    try {
      const events = await gamma.searchEvents(query, 20);
      const found = await extractCandidatesFromEvents(gamma, events, now, timeframeKeywords, timeframe);
      allCandidates.push(...found);
      if (allCandidates.length > 0) break;
    } catch {
      // search failed, try next query
    }
  }

  // Broad search if nothing found
  if (allCandidates.length === 0) {
    try {
      const broadEvents = await gamma.searchEvents(cryptoName, 50);
      const found = await extractCandidatesFromEvents(gamma, broadEvents, now, timeframeKeywords, timeframe);
      allCandidates.push(...found);
    } catch {
      // broad search failed
    }
  }

  return allCandidates;
}

function slugPrefixFor(crypto: string, timeframe: string | null): string {
  const base = `${crypto.toLowerCase()}-updown`;
  return timeframe ? `${base}-${timeframe.toLowerCase()}-` : `${base}-`;
}

function parseSlugTimestamp(slug: string): number {
  const parts = slug.split("-");
  const last = parts[parts.length - 1];
  const ts = parseInt(last, 10);
  return Number.isFinite(ts) ? ts * 1000 : Infinity;
}

async function extractCandidatesFromEvents(
  gamma: GammaClient,
  events: SearchEventSummary[],
  now: number,
  timeframeKeywords: string[] | null,
  timeframe: string | null,
): Promise<Array<{
  slug: string;
  question: string;
  startTimeMs: number;
  endTimeMs: number;
  upTokenId: string;
  downTokenId: string;
}>> {
  const candidates: Array<{
    slug: string;
    question: string;
    startTimeMs: number;
    endTimeMs: number;
    upTokenId: string;
    downTokenId: string;
  }> = [];

  for (const event of events) {
    for (const market of event.markets) {
      const endTimeMs = parseDateMs(market.endDateIso);
      if (!Number.isFinite(endTimeMs) || endTimeMs < now) {
        continue;
      }

      if (timeframeKeywords) {
        const text = `${market.slug} ${market.question}`.toLowerCase();
        if (!timeframeKeywords.some((kw) => text.includes(kw))) {
          continue;
        }
        if (timeframe) {
          const exactRe = new RegExp(`(^|\\D)${timeframe}(\\D|$)`);
          if (!exactRe.test(text)) {
            continue;
          }
        }
      }

      const startTimeMs = parseDateMs(market.startDateIso);

      // Try to get token IDs from raw data first
      const rawData = (market as any).raw ?? market;
      let tokens = parseOutcomeTokens(rawData);

      // Fallback: fetch market directly to get real CLOB token IDs
      if (!tokens) {
        try {
          const freshRaw = await gamma.getMarketBySlug(market.slug);
          tokens = parseOutcomeTokens(freshRaw);
        } catch {
          // market not found, skip
        }
      }

      if (tokens) {
        candidates.push({
          slug: market.slug,
          question: market.question,
          startTimeMs: Number.isFinite(startTimeMs) ? startTimeMs : Infinity,
          endTimeMs,
          upTokenId: tokens.up,
          downTokenId: tokens.down,
        });
      }
    }
  }

  return candidates;
}

const CRYPTO_FULL_NAMES: Record<string, string> = {
  btc: "Bitcoin",
  eth: "Ethereum",
  sol: "Solana",
  matic: "Polygon",
  avax: "Avalanche",
  hype: "Hyperliquid",
  doge: "Dogecoin",
  xrp: "XRP",
  ada: "Cardano",
  dot: "Polkadot",
};

async function getPricesFromWs(
  marketWs: PolymarketMarketWs,
  upTokenId: string,
  downTokenId: string,
): Promise<{ upPrice: number | null; downPrice: number | null }> {
  return new Promise((resolve) => {
    let upPrice: number | null = null;
    let downPrice: number | null = null;
    let receivedCount = 0;

    const timeout = setTimeout(() => {
      resolve({ upPrice, downPrice });
    }, 5000); // 5 second timeout

    const originalOnEvent = marketWs["onEvent"];
    const wrappedOnEvent = (event: any) => {
      originalOnEvent(event);
      
      if (event.kind === "book") {
        if (event.assetId === upTokenId && event.bestAsk !== null) {
          upPrice = event.bestAsk;
          receivedCount++;
        }
        if (event.assetId === downTokenId && event.bestAsk !== null) {
          downPrice = event.bestAsk;
          receivedCount++;
        }
        
        if (receivedCount >= 2) {
          clearTimeout(timeout);
          resolve({ upPrice, downPrice });
        }
      }
    };

    // Temporarily replace the event handler
    (marketWs as any).onEvent = wrappedOnEvent;
    
    // Subscribe to both tokens
    marketWs.setTrackedAssets([upTokenId, downTokenId]);
    
    // Restore original handler after timeout
    setTimeout(() => {
      (marketWs as any).onEvent = originalOnEvent;
    }, 5100);
  });
}
