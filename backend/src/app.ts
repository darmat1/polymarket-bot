import { ClobPublicClient } from "./clob.js";
import { loadSettings } from "./config.js";
import { GammaClient, parseMarket } from "./gamma.js";
import {
  type MarketSummary,
  type OutcomeToken,
  type ParsedWeatherMarket,
  type SearchEventSummary,
  type WeatherProbabilityResult,
} from "./models.js";
import { getRuntimeAuthState, getRuntimeTradingClient, initializeRuntimeApiCreds } from "./runtime-auth.js";
import { evaluateBinaryOutcome } from "./strategy.js";
import { TradingClient } from "./trading.js";
import { fetchForecastPoints, fetchHourlyForecast } from "./weather/forecasts.js";
import { parseWeatherMarket } from "./weather/parser.js";
import { matchWeatherStation } from "./weather/stations.js";
import { estimateWeatherProbability } from "./weather/probability.js";
import { createPublicClient, erc20Abi, formatUnits, http } from "viem";
import { polygon } from "viem/chains";
import { ethers } from "ethers";

const CTF_ADDRESS = "0x4d97dcd97ec945f40cf65f87097cae4b54fafa76";
const CTF_ABI = [
  "event ConditionPreparation(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint outcomeSlotCount)",
];

export interface ScanMarketsOptions {
  limit?: number;
  search?: string;
}

export interface SearchEventsOptions {
  limit?: number;
  search: string;
}

export interface EvaluatedMarketPayload {
  market: string;
  slug: string;
  outcome: string;
  token_id: string;
  best_bid: number | null;
  best_ask: number | null;
  spread_bps: number | null;
  fair_probability: number;
  model_probability: number | null;
  fair_probability_source: "manual" | "weather-model";
  weather_analysis: {
    city: string;
    station: string;
    target_date: string;
    bucket: string;
    blended_forecast_high: number;
    sigma: number;
    sources: string[];
  } | null;
  decision: {
    should_trade: boolean;
    side: "buy" | "sell";
    target_price: number;
    edge_bps: number;
    reason: string;
  };
}

export interface AccountSummaryPayload {
  address: string | null;
  usdc_balance: string | null;
  available_to_trade: string | null;
  portfolio_value: string | null;
  dry_run: boolean;
  source: "polymarket-account";
}

const POLYMARKET_DATA_API = "https://data-api.polymarket.com";

/** Row shape from GET https://data-api.polymarket.com/positions */
export interface PolymarketPositionRow {
  proxyWallet?: string;
  asset?: string;
  conditionId?: string;
  size?: number;
  avgPrice?: number;
  initialValue?: number;
  currentValue?: number;
  cashPnl?: number;
  percentPnl?: number;
  curPrice?: number;
  redeemable?: boolean;
  title?: string;
  slug?: string;
  eventSlug?: string;
  outcome?: string;
  endDate?: string;
  icon?: string;
}

export interface OpenPositionsPayload {
  user: string | null;
  wallet_source: "funder" | "eoa" | null;
  positions: PolymarketPositionRow[];
}

export interface RuntimeAuthDebugPayload {
  runtime: ReturnType<typeof getRuntimeAuthState>;
  balance_allowance: unknown;
}

export interface UserWebSocketAuthPayload {
  available: boolean;
  source: "derived" | "env-fallback" | "unavailable";
  auth: {
    apiKey: string;
    secret: string;
    passphrase: string;
  } | null;
  key_preview: string | null;
  passphrase_preview: string | null;
  last_error: string | null;
}

export interface ScannerEventPayload {
  type: "scanner_event";
  conditionId: string;
  oracle: string;
  questionId: string;
  outcomeSlotCount: string;
  txHash: string;
  blockNumber: number;
  timestamp: number;
  title?: string;
  slug?: string;
  source?: "blockchain" | "gamma-recent";
}

export interface BtcMinuteCandle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Btc5mMarketSnapshotPayload {
  market: {
    slug: string;
    question: string;
    startTime: number | null;
    endTime: number | null;
    status: "live" | "upcoming" | "recent";
    selectionReason: "actual-live" | "nearest-upcoming" | "latest-recent";
    selectionLabel: "Actual Live" | "Nearest Upcoming" | "Latest Recent";
    yesOutcome: OutcomeToken | null;
    noOutcome: OutcomeToken | null;
  };
  pricing: {
    marketStartPrice: number | null;
    marketEndPrice: number | null;
    currentBtcPrice: number | null;
    marketPriceChangePct: number | null;
  };
  prediction: {
    source: "groq" | "heuristic" | "unavailable";
    direction: "up" | "down" | "neutral";
    confidence: number | null;
    summary: string | null;
    reasoning: string[];
    generatedAt: number | null;
    aiStatus: "available" | "unavailable";
    aiError: string | null;
    heuristic: {
      direction: "up" | "down" | "neutral";
      confidence: number | null;
      summary: string | null;
    };
    groq: {
      direction: "up" | "down" | "neutral";
      confidence: number | null;
      summary: string | null;
    } | null;
  };
  book: {
    yes: {
      bestBid: number | null;
      bestAsk: number | null;
      midpoint: number | null;
      spreadBps: number | null;
    } | null;
    no: {
      bestBid: number | null;
      bestAsk: number | null;
      midpoint: number | null;
      spreadBps: number | null;
    } | null;
  };
  quotes: {
    up: number | null;
    down: number | null;
  };
}

const extractionCache = new Map<string, { data: any; expires: number }>();
const EXTRACTION_TTL = 30 * 60 * 1000; // 30 minutes
const btcPredictionCache = new Map<string, { data: Btc5mMarketSnapshotPayload["prediction"]; expires: number }>();
const btcAiPredictionCache = new Map<string, { data: Btc5mMarketSnapshotPayload["prediction"] | null; signal: string; expires: number }>();
const btc5mSnapshotCache = new Map<string, { data: Btc5mMarketSnapshotPayload; expires: number }>();
const BTC_PREDICTION_TTL = 15 * 1000;
const BTC_AI_PREDICTION_TTL = 2 * 60 * 1000;
const BTC_5M_SNAPSHOT_TTL = 15 * 1000;
const BTC_5M_WINDOW_MS = 5 * 60 * 1000;
const BTC_5M_MAX_UPCOMING_LOOKAHEAD_MS = 10 * 60 * 1000;
const GROQ_RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000;

let groqCooldownUntil = 0;
let groqCooldownReason: string | null = null;

export async function extractWeatherMarketData(
  question: string,
  description: string,
  marketSlug?: string,
  marketEndDateIso?: string | null,
): Promise<any> {
  const cacheKey = marketSlug || question;
  const now = Date.now();
  const cached = extractionCache.get(cacheKey);
  if (cached && cached.expires > now) {
    return cached.data;
  }

  const settings = loadSettings();
  if (!settings.groqApiKey) return null;
  if (isGroqCoolingDown()) return null;

  let extractedData = null;
  try {
    const prompt = `
Extract weather market parameters in JSON format:
{
  "city": "string",
  "timezone": "string (IANA format)",
  "t": number (the target temperature value; if it is a range, ALWAYS use the LOWER value of the range),
  "t_sys": "C" or "F",
  "day": "YYYY-MM-DD",
  "station_code": "string (4-letter ICAO code, e.g. KJFK)"
}

Market Question: ${question}
Market Description: ${description}
Current Reference Time (UTC): ${new Date().toISOString()}
    `;

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${settings.groqApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        response_format: { type: "json_object" }
      })
    });

    if (response.ok) {
      const result = await response.json() as any;
      const content = result.choices[0]?.message?.content;
      if (content) {
        extractedData = normalizeWeatherExtraction(JSON.parse(content));
        extractionCache.set(cacheKey, {
          data: extractedData,
          expires: getWeatherExtractionExpiry(now, marketEndDateIso),
        });
      }
    } else {
      const errorText = await response.text();
      registerGroqFailure(response.status, `Groq weather extraction failed: ${response.status} ${response.statusText} ${errorText}`);
      console.error("AI extraction failed", response.status, response.statusText, errorText);
    }
  } catch (e) {
    console.error("AI extraction failed", e);
  }
  return extractedData;
}

export async function scanMarkets(options: ScanMarketsOptions = {}): Promise<MarketSummary[]> {
  const settings = loadSettings();
  const gamma = new GammaClient(settings.gammaHost);
  const limit = options.limit ?? 200;
  const search = options.search?.trim();
  const results = await gamma.listMarkets(limit, true, false);
  const markets = results.map(parseMarket).filter((market): market is MarketSummary => market !== null);

  if (!search) {
    return markets;
  }

  const normalizedSearch = search.toLowerCase();
  return markets.filter((market) =>
    [market.slug, market.question, market.category, ...market.outcomes.map((outcome) => outcome.label)]
      .join(" ")
      .toLowerCase()
      .includes(normalizedSearch),
  );
}

export async function searchEvents(options: SearchEventsOptions): Promise<SearchEventSummary[]> {
  const settings = loadSettings();
  const gamma = new GammaClient(settings.gammaHost);
  const limit = options.limit ?? 50;
  const search = options.search.trim();

  if (!search) {
    return [];
  }

  return (await gamma.searchEvents(search, limit)).filter((event) => event.active && !event.closed);
}

export async function getHourlyForecast(marketSlug: string) {
  const settings = loadSettings();
  const gamma = new GammaClient(settings.gammaHost);
  const rawMarket = await gamma.getMarketBySlug(marketSlug);
  const market = parseMarket(rawMarket);
  if (!market) return [];

  const extractedData = await extractWeatherMarketData(
    market.question,
    market.description,
    market.slug,
    market.endDateIso,
  );
  let parsed = parseWeatherMarket(market, extractedData) ?? parseWeatherMarket(market);
  if (parsed) {
    return await fetchHourlyForecast(parsed);
  }

  // Fallback: just try to match station and date for visual forecast
  const station = matchWeatherStation(`${market.question} ${market.slug}`);
  if (station) {
    const targetDate = market.endDateIso?.slice(0, 10) || new Date().toISOString().slice(0, 10);
    return await fetchHourlyForecast({
      cityKey: station.key,
      cityLabel: station.label,
      station: station.station,
      targetDate,
      unit: station.unit, // default to station unit
      bucket: { kind: "exact", lowerInclusive: 0, upperInclusive: 0, label: "Visual" } // dummy bucket
    });
  }

  return [];
}

export async function getCurrentBtc5mMarketSnapshot(options?: {
  includeAi?: boolean;
}): Promise<Btc5mMarketSnapshotPayload> {
  const settings = loadSettings();
  const gamma = new GammaClient(settings.gammaHost);
  const eventMarkets = await getCandidateBtc5mMarkets(gamma);
  const includeAi = options?.includeAi ?? true;

  const selection = pickCurrentBtc5mMarket(eventMarkets);
  if (!selection) {
    throw new Error("No active BTC 5m market found");
  }

  const cached = btc5mSnapshotCache.get(getBtc5mSnapshotCacheKey(selection.market.slug, includeAi));
  const now = Date.now();
  if (cached && cached.expires > now) {
    return cached.data;
  }

  return buildBtc5mMarketSnapshot(selection.market, selection, { includeAi });
}

export async function getBtc5mMarketSnapshotBySlug(
  slug: string,
  options?: {
    includeAi?: boolean;
  },
): Promise<Btc5mMarketSnapshotPayload> {
  const settings = loadSettings();
  const gamma = new GammaClient(settings.gammaHost);
  const rawMarket = await gamma.getMarketBySlug(slug);
  const market = parseMarket(rawMarket);
  const includeAi = options?.includeAi ?? true;

  if (!market || !isBtc5mMarket(market)) {
    throw new Error(`BTC 5m market not found for slug ${slug}`);
  }

  const now = Date.now();
  const startTime = getMarketStartTime(market);
  const endTime = getMarketEndTime(market);

  return buildBtc5mMarketSnapshot(market, {
    reason:
      startTime !== null && endTime !== null && startTime <= now && endTime > now
        ? "actual-live"
        : startTime !== null && startTime > now
          ? "nearest-upcoming"
          : "latest-recent",
    label:
      startTime !== null && endTime !== null && startTime <= now && endTime > now
        ? "Actual Live"
        : startTime !== null && startTime > now
          ? "Nearest Upcoming"
          : "Latest Recent",
  }, { includeAi });
}

async function buildBtc5mMarketSnapshot(
  market: MarketSummary,
  selection: {
    reason: Btc5mMarketSnapshotPayload["market"]["selectionReason"];
    label: Btc5mMarketSnapshotPayload["market"]["selectionLabel"];
  },
  options?: {
    includeAi?: boolean;
  },
): Promise<Btc5mMarketSnapshotPayload> {
  const includeAi = options?.includeAi ?? true;
  const cacheKey = getBtc5mSnapshotCacheKey(market.slug, includeAi);
  const cached = btc5mSnapshotCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expires > now) {
    return cached.data;
  }

  const settings = loadSettings();
  const clob = new ClobPublicClient(settings.polymarketHost);

  const candles = await getBtcCandles(180);
  const yesOutcome = pickBinaryOutcome(market.outcomes, ["Yes", "Up"]);
  const noOutcome = pickBinaryOutcome(market.outcomes, ["No", "Down"]);
  const yesBook = yesOutcome ? await getTopOfBookSafe(clob, yesOutcome.tokenId) : null;
  const noBook = noOutcome ? await getTopOfBookSafe(clob, noOutcome.tokenId) : null;
  const startTime = getMarketStartTime(market);
  const endTime = getMarketEndTime(market);
  const marketStartPrice = startTime ? getReferenceBtcPrice(candles, startTime) : null;
  const marketEndPrice = endTime !== null && endTime <= now ? getReferenceBtcPrice(candles, endTime) : null;
  const currentBtcPrice = candles.length > 0 ? candles[candles.length - 1]?.close ?? null : null;
  const upQuote = getOutcomeQuote(market, ["Up", "Yes"]);
  const downQuote = getOutcomeQuote(market, ["Down", "No"]);
  const marketPriceChangePct =
    marketStartPrice !== null && currentBtcPrice !== null && marketStartPrice !== 0
      ? ((currentBtcPrice - marketStartPrice) / marketStartPrice) * 100
      : null;
  const prediction = await getBtc5mPrediction({
    market,
    candles,
    marketStartPrice,
    currentBtcPrice,
    marketPriceChangePct,
    yesMidpoint: yesBook?.midpoint ?? null,
    noMidpoint: noBook?.midpoint ?? null,
  }, {
    includeAi,
  });

  const snapshot = {
    market: {
      slug: market.slug,
      question: market.question,
      startTime,
      endTime,
      status:
        startTime !== null && endTime !== null && startTime <= now && endTime > now
          ? "live"
          : startTime !== null && startTime > now
            ? "upcoming"
            : "recent",
      selectionReason: selection.reason,
      selectionLabel: selection.label,
      yesOutcome,
      noOutcome,
    },
    pricing: {
      marketStartPrice,
      marketEndPrice,
      currentBtcPrice,
      marketPriceChangePct,
    },
    prediction,
    book: {
      yes: yesBook
        ? {
            bestBid: yesBook.bestBid,
            bestAsk: yesBook.bestAsk,
            midpoint: yesBook.midpoint,
            spreadBps: yesBook.spreadBps,
          }
        : null,
      no: noBook
        ? {
            bestBid: noBook.bestBid,
            bestAsk: noBook.bestAsk,
            midpoint: noBook.midpoint,
            spreadBps: noBook.spreadBps,
          }
        : null,
    },
    quotes: {
      up: upQuote,
      down: downQuote,
    },
  } satisfies Btc5mMarketSnapshotPayload;

  btc5mSnapshotCache.set(cacheKey, {
    data: snapshot,
    expires: now + BTC_5M_SNAPSHOT_TTL,
  });

  return snapshot;
}

export async function getBtcCandles(limit = 60): Promise<BtcMinuteCandle[]> {
  const url = new URL("https://api.binance.com/api/v3/klines");
  url.searchParams.set("symbol", "BTCUSDT");
  url.searchParams.set("interval", "1m");
  url.searchParams.set("limit", String(Math.max(1, Math.min(limit, 500))));

  const response = await fetch(url, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Binance candles request failed: ${response.status} ${response.statusText}`);
  }

  const rows = (await response.json()) as unknown[];
  return rows
    .filter((row): row is unknown[] => Array.isArray(row) && row.length >= 7)
    .map((row) => ({
      openTime: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      closeTime: Number(row[6]),
    }))
    .filter((row) => Number.isFinite(row.openTime) && Number.isFinite(row.close));
}

export async function evaluateMarket(params: {
  marketSlug: string;
  outcome?: string;
  fairProbability?: number;
}): Promise<EvaluatedMarketPayload> {
  const settings = loadSettings();
  const gamma = new GammaClient(settings.gammaHost);
  const clob = new ClobPublicClient(settings.polymarketHost);

  const rawMarket = await gamma.getMarketBySlug(params.marketSlug);
  const market = parseMarket(rawMarket);
  if (!market) {
    throw new Error("Could not parse market outcomes/token IDs");
  }

  const outcome = pickOutcome(market.outcomes, params.outcome);
  const book = await clob.getTopOfBook(outcome.tokenId);
  const manualFairProbability =
    typeof params.fairProbability === "number" && Number.isFinite(params.fairProbability)
      ? params.fairProbability
      : null;
  const weatherAnalysis = await deriveWeatherProbability(market);
  const fairProbability = manualFairProbability ?? weatherAnalysis?.probability ?? null;

  if (fairProbability === null) {
    throw new Error("Fair probability is required for non-weather markets, or weather parsing/forecasting must succeed.");
  }

  const decision = evaluateBinaryOutcome({
    fairProbability,
    topOfBook: book,
    minEdgeBps: settings.minEdgeBps,
    maxSpreadBps: settings.maxSpreadBps,
  });

  return {
    market: market.question,
    slug: market.slug,
    outcome: outcome.label,
    token_id: outcome.tokenId,
    best_bid: book.bestBid,
    best_ask: book.bestAsk,
    spread_bps: book.spreadBps,
    fair_probability: fairProbability,
    model_probability: weatherAnalysis?.probability ?? null,
    fair_probability_source: manualFairProbability !== null ? "manual" : "weather-model",
    weather_analysis: weatherAnalysis
      ? {
          city: weatherAnalysis.parsed.cityLabel,
          station: weatherAnalysis.parsed.station,
          target_date: weatherAnalysis.parsed.targetDate,
          bucket: weatherAnalysis.parsed.bucket.label,
          blended_forecast_high: weatherAnalysis.result.blendedForecastHigh,
          sigma: weatherAnalysis.result.sigma,
          sources: weatherAnalysis.result.components.map((component) => component.source),
        }
      : null,
    decision: {
      should_trade: decision.shouldTrade,
      side: decision.side,
      target_price: decision.targetPrice,
      edge_bps: decision.edgeBps,
      reason: decision.reason,
    },
  };
}

async function deriveWeatherProbability(
  market: MarketSummary,
): Promise<{ parsed: ParsedWeatherMarket; result: WeatherProbabilityResult; probability: number } | null> {
  const extractedData = await extractWeatherMarketData(
    market.question,
    market.description,
    market.slug,
    market.endDateIso,
  );
  const parsed = parseWeatherMarket(market, extractedData) ?? parseWeatherMarket(market);
  if (!parsed) {
    return null;
  }

  const forecasts = await fetchForecastPoints(parsed);
  const result = estimateWeatherProbability(parsed, forecasts);
  if (!result) {
    return null;
  }

  return {
    parsed,
    result,
    probability: result.probability,
  };
}

export async function deriveApiCreds(): Promise<Record<string, string>> {
  const creds = await initializeRuntimeApiCreds();
  if (!creds) {
    throw new Error("POLYMARKET_PRIVATE_KEY is required");
  }

  return {
    POLYMARKET_API_KEY: creds.key,
    POLYMARKET_API_SECRET: creds.secret,
    POLYMARKET_API_PASSPHRASE: creds.passphrase,
  };
}

export async function getMarketDetails(slug: string) {
  const settings = loadSettings();
  const gamma = new GammaClient(settings.gammaHost);
  const rawMarket = await gamma.getMarketBySlug(slug);

  const market = parseMarket(rawMarket);
  if (!market) {
    throw new Error("Market not found");
  }

  const extractedData = await extractWeatherMarketData(
    market.question,
    market.description,
    market.slug,
    market.endDateIso,
  );

  return {
    question: market.question,
    description: market.description,
    slug: market.slug,
    extractedData
  };
}

export async function getAccountSummary(): Promise<AccountSummaryPayload> {
  const settings = loadSettings();

  if (!settings.privateKey) {
    return {
      address: null,
      usdc_balance: null,
      available_to_trade: null,
      portfolio_value: null,
      dry_run: settings.dryRun,
      source: "polymarket-account",
    };
  }

  const normalized = settings.privateKey.startsWith("0x")
    ? settings.privateKey
    : `0x${settings.privateKey}`;
  const accountAddress = new ethers.Wallet(normalized).address;
  const client = createPublicClient({
    chain: polygon,
    transport: http(),
  });

  const balance = await client.readContract({
    address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [accountAddress as `0x${string}`],
  });

  const { user } = resolvePolymarketUser(settings);
  let availableToTrade: string | null = null;
  let portfolioValue: string | null = null;

  try {
    const runtimeClient = await getRuntimeTradingClient();
    const balanceAllowance = await runtimeClient.getBalanceAllowance();
    availableToTrade = formatUsdcMicro(balanceAllowance?.balance);
  } catch {
    availableToTrade = null;
  }

  try {
    const positions = await fetchOpenPositions(user);
    const positionsValue = positions.reduce(
      (sum, row) => sum + (typeof row.currentValue === "number" ? row.currentValue : 0),
      0,
    );
    portfolioValue = (
      (availableToTrade === null ? 0 : Number(availableToTrade)) + positionsValue
    ).toFixed(2);
  } catch {
    portfolioValue = availableToTrade;
  }

  return {
    address: user,
    usdc_balance: formatUnits(balance, 6),
    available_to_trade: availableToTrade,
    portfolio_value: portfolioValue,
    dry_run: settings.dryRun,
    source: "polymarket-account",
  };
}

export async function getOpenPositions(): Promise<OpenPositionsPayload> {
  const settings = loadSettings();
  if (!settings.privateKey && !settings.funderAddress?.trim()) {
    return { user: null, wallet_source: null, positions: [] };
  }

  const { user, wallet_source } = resolvePolymarketUser(settings);
  const positions = await fetchOpenPositions(user);

  return { user, wallet_source, positions };
}

function resolvePolymarketUser(settings: ReturnType<typeof loadSettings>): {
  user: string;
  wallet_source: "funder" | "eoa";
} {
  const funder = settings.funderAddress?.trim();

  if (funder) {
    return { user: funder, wallet_source: "funder" };
  }

  if (!settings.privateKey) {
    throw new Error("Private key not configured");
  }

  const normalized = settings.privateKey.startsWith("0x")
    ? settings.privateKey
    : `0x${settings.privateKey}`;

  return {
    user: new ethers.Wallet(normalized).address,
    wallet_source: "eoa",
  };
}

async function fetchOpenPositions(user: string): Promise<PolymarketPositionRow[]> {
  const url = new URL("/positions", POLYMARKET_DATA_API);
  url.searchParams.set("user", user);
  url.searchParams.set("sizeThreshold", "0");
  url.searchParams.set("limit", "500");
  url.searchParams.set("sortBy", "CURRENT");
  url.searchParams.set("sortDirection", "DESC");

  const res = await fetch(url);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const errBody = (await res.json()) as { error?: string };
      if (errBody.error) {
        detail = errBody.error;
      }
    } catch {
      /* ignore non-JSON error bodies */
    }
    throw new Error(`Polymarket positions: ${detail}`);
  }

  const rows = (await res.json()) as PolymarketPositionRow[];
  return rows.filter((row) => typeof row.size === "number" && row.size > 0);
}

function formatUsdcMicro(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    return null;
  }

  try {
    return formatUnits(BigInt(value), 6);
  } catch {
    return null;
  }
}

function isBtc5mMarket(market: MarketSummary): boolean {
  return market.slug.startsWith("btc-updown-5m-");
}

async function getCandidateBtc5mMarkets(gamma: GammaClient): Promise<MarketSummary[]> {
  const seen = new Map<string, MarketSummary>();

  const directMatches = await getDirectBtc5mMarkets(gamma);
  for (const market of directMatches) {
    if (!seen.has(market.slug)) {
      seen.set(market.slug, market);
    }
  }

  if (seen.size >= 3) {
    return Array.from(seen.values());
  }

  const queries = ["btc-updown-5m", "bitcoin up or down", "bitcoin up down"];

  for (const query of queries) {
    const events = await gamma.searchEvents(query, 50);
    for (const market of events.flatMap((event) => event.markets)) {
      if (isBtc5mMarket(market) && !seen.has(market.slug)) {
        seen.set(market.slug, market);
      }
    }
  }

  return Array.from(seen.values());
}

async function getDirectBtc5mMarkets(gamma: GammaClient): Promise<MarketSummary[]> {
  const slugs = buildBtc5mProbeSlugs(Date.now());
  const matches = await Promise.all(
    slugs.map(async (slug) => {
      try {
        const rawMarket = await gamma.getMarketBySlug(slug);
        const market = parseMarket(rawMarket);
        return market && isBtc5mMarket(market) ? market : null;
      } catch {
        return null;
      }
    }),
  );

  return matches.filter((market): market is MarketSummary => market !== null);
}

function buildBtc5mProbeSlugs(now: number): string[] {
  const currentBucketStart = now - (now % BTC_5M_WINDOW_MS);
  const timestamps = new Set<number>();

  for (let offset = -6; offset <= 2; offset += 1) {
    timestamps.add(currentBucketStart + offset * BTC_5M_WINDOW_MS);
  }

  return Array.from(timestamps)
    .sort((a, b) => a - b)
    .map((timestamp) => `btc-updown-5m-${Math.floor(timestamp / 1000)}`);
}

function pickCurrentBtc5mMarket(markets: MarketSummary[]): {
  market: MarketSummary;
  reason: Btc5mMarketSnapshotPayload["market"]["selectionReason"];
  label: Btc5mMarketSnapshotPayload["market"]["selectionLabel"];
} | null {
  const now = Date.now();
  const withTimes = markets
    .map((market) => ({
      market,
      startTime: getMarketStartTime(market),
      endTime: getMarketEndTime(market),
    }))
    .filter((entry) => entry.endTime !== null);

  const live = withTimes
    .filter((entry) => entry.startTime !== null && entry.endTime !== null && entry.startTime <= now && entry.endTime > now)
    .sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));
  if (live[0]) {
    return {
      market: live[0].market,
      reason: "actual-live",
      label: "Actual Live",
    };
  }

  const upcoming = withTimes
    .filter((entry) => entry.startTime !== null && entry.startTime > now)
    .sort((a, b) => (a.startTime ?? Number.MAX_SAFE_INTEGER) - (b.startTime ?? Number.MAX_SAFE_INTEGER));
  if (upcoming[0] && (upcoming[0].startTime ?? Number.MAX_SAFE_INTEGER) - now <= BTC_5M_MAX_UPCOMING_LOOKAHEAD_MS) {
    return {
      market: upcoming[0].market,
      reason: "nearest-upcoming",
      label: "Nearest Upcoming",
    };
  }

  const recent = withTimes
    .filter((entry) => (entry.endTime ?? 0) <= now)
    .sort((a, b) => (b.endTime ?? 0) - (a.endTime ?? 0));
  if (recent[0]) {
    return {
      market: recent[0].market,
      reason: "latest-recent",
      label: "Latest Recent",
    };
  }

  return upcoming[0]
    ? {
        market: upcoming[0].market,
        reason: "nearest-upcoming",
        label: "Nearest Upcoming",
      }
    : null;
}

function getMarketStartTime(market: MarketSummary): number | null {
  const rawStart =
    parseTimeValue(market.raw.eventStartTime) ??
    parseTimeValue(market.raw.startTime) ??
    parseNestedEventStartTime(market.raw) ??
    parseTimeValue(market.raw.startDate);
  if (rawStart !== null) {
    return rawStart;
  }

  const slugMatch = market.slug.match(/btc-updown-5m-(\d+)$/);
  if (!slugMatch) {
    return null;
  }

  const timestamp = Number(slugMatch[1]);
  return Number.isFinite(timestamp) ? timestamp * 1000 : null;
}

function getMarketEndTime(market: MarketSummary): number | null {
  const rawEnd = parseTimeValue(market.raw.endDate) ?? parseTimeValue(market.endDateIso);
  if (rawEnd !== null) {
    return rawEnd;
  }

  const startTime = getMarketStartTime(market);
  return startTime === null ? null : startTime + BTC_5M_WINDOW_MS;
}

function parseNestedEventStartTime(raw: Record<string, unknown>): number | null {
  const events = raw.events;
  if (!Array.isArray(events)) {
    return null;
  }

  for (const item of events) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const value = parseTimeValue((item as Record<string, unknown>).startTime);
    if (value !== null) {
      return value;
    }
  }

  return null;
}

function parseTimeValue(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function pickBinaryOutcome(outcomes: OutcomeToken[], labels: string[]): OutcomeToken | null {
  const normalized = labels.map((label) => label.toLowerCase());
  return outcomes.find((outcome) => normalized.includes(outcome.label.toLowerCase())) ?? null;
}

function getOutcomeQuote(market: MarketSummary, labels: string[]): number | null {
  const prices = normalizeNumberList(market.raw.outcomePrices);
  if (prices.length === 0) {
    return null;
  }

  const normalized = labels.map((label) => label.toLowerCase());
  const index = market.outcomes.findIndex((outcome) => normalized.includes(outcome.label.toLowerCase()));
  const price = index >= 0 ? prices[index] : null;
  return typeof price === "number" && Number.isFinite(price) ? price : null;
}

function getReferenceBtcPrice(candles: BtcMinuteCandle[], timestamp: number): number | null {
  const exactCandle = candles.find((candle) => candle.openTime <= timestamp && candle.closeTime >= timestamp);
  if (exactCandle) {
    return exactCandle.open;
  }

  const priorCandle = [...candles]
    .reverse()
    .find((candle) => candle.openTime <= timestamp);
  return priorCandle?.close ?? candles[0]?.open ?? null;
}

async function getTopOfBookSafe(clob: ClobPublicClient, tokenId: string) {
  try {
    return await clob.getTopOfBook(tokenId);
  } catch {
    return null;
  }
}

function normalizeNumberList(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item));
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => Number(item))
          .filter((item) => Number.isFinite(item));
      }
    } catch {
      return value
        .trim()
        .replace(/^\[/, "")
        .replace(/\]$/, "")
        .split(",")
        .map((part) => Number(part.trim().replace(/^"+|"+$/g, "")))
        .filter((item) => Number.isFinite(item));
    }
  }

  return [];
}

async function getBtc5mPrediction(params: {
  market: MarketSummary;
  candles: BtcMinuteCandle[];
  marketStartPrice: number | null;
  currentBtcPrice: number | null;
  marketPriceChangePct: number | null;
  yesMidpoint: number | null;
  noMidpoint: number | null;
}, options?: {
  includeAi?: boolean;
}): Promise<Btc5mMarketSnapshotPayload["prediction"]> {
  const includeAi = options?.includeAi ?? true;
  const cacheKey = getBtc5mPredictionCacheKey(params.market.slug, includeAi);
  const now = Date.now();
  const cached = btcPredictionCache.get(cacheKey);
  if (cached && cached.expires > now) {
    return cached.data;
  }

  const settings = loadSettings();
  const heuristicPrediction = buildHeuristicBtcPrediction(params);
  let groqPrediction: Btc5mMarketSnapshotPayload["prediction"] | null = null;
  let aiError: string | null = settings.groqApiKey ? null : "GROQ_API_KEY is not configured";
  let prediction = heuristicPrediction;

  if (!includeAi) {
    const backgroundPrediction = {
      ...heuristicPrediction,
      aiStatus: "unavailable",
      aiError: "AI disabled for background BTC updates",
      heuristic: {
        direction: heuristicPrediction.direction,
        confidence: heuristicPrediction.confidence,
        summary: heuristicPrediction.summary,
      },
      groq: null,
    } satisfies Btc5mMarketSnapshotPayload["prediction"];

    btcPredictionCache.set(cacheKey, {
      data: backgroundPrediction,
      expires: now + BTC_PREDICTION_TTL,
    });
    return backgroundPrediction;
  }

  const signal = buildBtcAiSignal(params, heuristicPrediction);
  const cachedAi = btcAiPredictionCache.get(cacheKey);
  if (cachedAi && cachedAi.expires > now && cachedAi.signal === signal) {
    groqPrediction = cachedAi.data;
    if (groqPrediction) {
      prediction = groqPrediction;
      aiError = null;
    } else if (isGroqCoolingDown()) {
      aiError = groqCooldownReason;
    }
  } else if (settings.groqApiKey && !isGroqCoolingDown()) {
    try {
      groqPrediction = await getGroqBtcPrediction(settings.groqApiKey, params);
      if (groqPrediction) {
        prediction = groqPrediction;
        aiError = null;
      } else {
        aiError = "AI provider returned no usable prediction";
      }
    } catch (error) {
      aiError = error instanceof Error ? error.message : String(error);
      // Heuristic fallback is intentional for short-lived 5m panels.
    }
    btcAiPredictionCache.set(cacheKey, {
      data: groqPrediction,
      signal,
      expires: now + BTC_AI_PREDICTION_TTL,
    });
  } else if (isGroqCoolingDown()) {
    aiError = groqCooldownReason;
  }

  const enrichedPrediction = {
    ...prediction,
    aiStatus: groqPrediction ? "available" : "unavailable",
    aiError,
    heuristic: {
      direction: heuristicPrediction.direction,
      confidence: heuristicPrediction.confidence,
      summary: heuristicPrediction.summary,
    },
    groq: groqPrediction
      ? {
          direction: groqPrediction.direction,
          confidence: groqPrediction.confidence,
          summary: groqPrediction.summary,
        }
      : null,
  } satisfies Btc5mMarketSnapshotPayload["prediction"];

  btcPredictionCache.set(cacheKey, {
    data: enrichedPrediction,
    expires: now + BTC_PREDICTION_TTL,
  });
  return enrichedPrediction;
}

function buildHeuristicBtcPrediction(params: {
  candles: BtcMinuteCandle[];
  marketPriceChangePct: number | null;
  yesMidpoint: number | null;
  noMidpoint: number | null;
}): Btc5mMarketSnapshotPayload["prediction"] {
  const recentCandles = params.candles.slice(-5);
  const first = recentCandles[0]?.open ?? null;
  const last = recentCandles[recentCandles.length - 1]?.close ?? null;
  const shortMove =
    first !== null && last !== null && first !== 0 ? ((last - first) / first) * 100 : 0;
  const marketMove = params.marketPriceChangePct ?? 0;
  const biasScore = shortMove * 0.7 + marketMove * 0.3;
  const bookBias =
    params.yesMidpoint !== null && params.noMidpoint !== null
      ? params.yesMidpoint - params.noMidpoint
      : 0;
  const combinedScore = biasScore + bookBias * 100 * 0.15;
  const direction = combinedScore > 0.03 ? "up" : combinedScore < -0.03 ? "down" : "neutral";
  const confidence = Math.min(0.74, Math.max(0.35, Math.abs(combinedScore) * 4 + 0.35));

  const summary =
    direction === "neutral"
      ? "Short-term momentum is mixed; edge is weak."
      : direction === "up"
        ? "Short-term BTC momentum slightly favors an up close."
        : "Short-term BTC momentum slightly favors a down close.";

  return {
    source: "heuristic",
    direction,
    confidence,
    summary,
    reasoning: [
      `5m momentum: ${marketMove >= 0 ? "+" : ""}${marketMove.toFixed(2)}%`,
      `recent 1m drift: ${shortMove >= 0 ? "+" : ""}${shortMove.toFixed(2)}%`,
      params.yesMidpoint !== null && params.noMidpoint !== null
        ? `book bias up-down: ${(params.yesMidpoint - params.noMidpoint).toFixed(3)}`
        : "book bias unavailable",
    ],
    generatedAt: Date.now(),
    aiStatus: "unavailable",
    aiError: null,
    heuristic: {
      direction,
      confidence,
      summary,
    },
    groq: null,
  };
}

async function getGroqBtcPrediction(
  groqApiKey: string,
  params: {
    market: MarketSummary;
    candles: BtcMinuteCandle[];
    marketStartPrice: number | null;
    currentBtcPrice: number | null;
    marketPriceChangePct: number | null;
    yesMidpoint: number | null;
    noMidpoint: number | null;
  },
): Promise<Btc5mMarketSnapshotPayload["prediction"] | null> {
  const recentCandles = params.candles.slice(-8).map((candle) => ({
    t: new Date(candle.closeTime).toISOString(),
    o: candle.open,
    h: candle.high,
    l: candle.low,
    c: candle.close,
    v: candle.volume,
  }));
  const prompt = `
You are making a short-horizon forecast for a Polymarket BTC 5-minute Up/Down market.
Return strict JSON:
{
  "direction": "up" | "down" | "neutral",
  "confidence": number,
  "summary": "string",
  "reasoning": ["string", "string", "string"]
}

Rules:
- Focus only on the next 5-minute market direction.
- Be conservative. Use "neutral" if edge is weak.
- Confidence must be between 0 and 1.
- Keep summary short.
- Do not mention placing trades.

Market: ${params.market.question}
Slug: ${params.market.slug}
Start BTC: ${params.marketStartPrice ?? "n/a"}
Current BTC: ${params.currentBtcPrice ?? "n/a"}
Move since market start (%): ${params.marketPriceChangePct ?? "n/a"}
Yes midpoint: ${params.yesMidpoint ?? "n/a"}
No midpoint: ${params.noMidpoint ?? "n/a"}
Recent 1m candles: ${JSON.stringify(recentCandles)}
  `.trim();

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${groqApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const message = `Groq BTC prediction failed: ${response.status} ${response.statusText} ${errorText}`;
    registerGroqFailure(response.status, message);
    throw new Error(message);
  }

  const result = (await response.json()) as any;
  const content = result.choices?.[0]?.message?.content;
  if (!content) {
    return null;
  }

  const parsed = JSON.parse(content) as {
    direction?: string;
    confidence?: number;
    summary?: string;
    reasoning?: unknown;
  };
  const direction =
    parsed.direction === "up" || parsed.direction === "down" || parsed.direction === "neutral"
      ? parsed.direction
      : "neutral";
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : null;
  const reasoning = Array.isArray(parsed.reasoning)
    ? parsed.reasoning.filter((item): item is string => typeof item === "string").slice(0, 4)
    : [];

  return {
    source: "groq",
    direction,
    confidence,
    summary: typeof parsed.summary === "string" ? parsed.summary : null,
    reasoning,
    generatedAt: Date.now(),
    aiStatus: "available",
    aiError: null,
    heuristic: {
      direction: "neutral",
      confidence: null,
      summary: null,
    },
    groq: null,
  };
}

function normalizeWeatherExtraction(payload: any) {
  const base = payload?.market_parameters && typeof payload.market_parameters === "object"
    ? payload.market_parameters
    : payload;

  return {
    city: base?.city ?? base?.location ?? null,
    timezone: base?.timezone ?? null,
    t: typeof base?.t === "number" ? base.t : typeof base?.target_temperature === "number" ? base.target_temperature : null,
    t_sys: base?.t_sys ?? base?.temperature_unit ?? null,
    day: base?.day ?? base?.date ?? null,
    station_code: base?.station_code ?? null,
  };
}

function getWeatherExtractionExpiry(now: number, marketEndDateIso?: string | null) {
  if (!marketEndDateIso) {
    return now + EXTRACTION_TTL;
  }

  const endMs = Date.parse(marketEndDateIso);
  if (!Number.isFinite(endMs)) {
    return now + EXTRACTION_TTL;
  }

  return Math.max(now + 60_000, endMs);
}

function buildBtcAiSignal(
  params: {
    marketPriceChangePct: number | null;
    yesMidpoint: number | null;
    noMidpoint: number | null;
  },
  heuristicPrediction: { direction: "up" | "down" | "neutral"; confidence: number | null },
) {
  return JSON.stringify({
    direction: heuristicPrediction.direction,
    confidenceBucket: heuristicPrediction.confidence === null ? null : Math.round(heuristicPrediction.confidence * 10),
    marketMoveBucket: params.marketPriceChangePct === null ? null : Math.round(params.marketPriceChangePct * 100),
    yesMidBucket: params.yesMidpoint === null ? null : Math.round(params.yesMidpoint * 100),
    noMidBucket: params.noMidpoint === null ? null : Math.round(params.noMidpoint * 100),
  });
}

function getBtc5mSnapshotCacheKey(slug: string, includeAi: boolean) {
  return `${slug}:${includeAi ? "ai" : "heuristic"}`;
}

function getBtc5mPredictionCacheKey(slug: string, includeAi: boolean) {
  return `${slug}:${includeAi ? "ai" : "heuristic"}`;
}

function isGroqCoolingDown() {
  return groqCooldownUntil > Date.now();
}

function registerGroqFailure(status: number, reason: string) {
  if (status === 429) {
    groqCooldownUntil = Date.now() + GROQ_RATE_LIMIT_COOLDOWN_MS;
    groqCooldownReason = reason;
  }
}

export async function getRuntimeAuthDebug(): Promise<RuntimeAuthDebugPayload> {
  const runtime = getRuntimeAuthState();

  if (!runtime.credsLoaded) {
    return {
      runtime,
      balance_allowance: null,
    };
  }

  try {
    const client = await getRuntimeTradingClient();
    const balance = await client.getBalanceAllowance();
    return {
      runtime,
      balance_allowance: balance,
    };
  } catch (error) {
    return {
      runtime,
      balance_allowance: {
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function getUserWebSocketAuth(): Promise<UserWebSocketAuthPayload> {
  const runtime = getRuntimeAuthState();
  const creds = await initializeRuntimeApiCreds();

  if (!creds) {
    return {
      available: false,
      source: runtime.credsSource,
      auth: null,
      key_preview: runtime.keyPreview,
      passphrase_preview: runtime.passphrasePreview,
      last_error: runtime.lastError,
    };
  }

  return {
    available: true,
    source: runtime.credsSource,
    auth: {
      apiKey: creds.key,
      secret: creds.secret,
      passphrase: creds.passphrase,
    },
    key_preview: runtime.keyPreview,
    passphrase_preview: runtime.passphrasePreview,
    last_error: runtime.lastError,
  };
}

export async function updateRuntimeAllowance(): Promise<{ ok: true }> {
  const client = await getRuntimeTradingClient();
  await client.updateBalanceAllowance();
  return { ok: true };
}

export async function updateTokenAllowance(): Promise<{ ok: true }> {
  const client = await getRuntimeTradingClient();
  await client.updateTokenAllowance();
  return { ok: true };
}

export async function getRecentScannerEvents(limit = 10): Promise<ScannerEventPayload[]> {
  const gammaFallback = await getRecentGammaScannerEvents(limit);
  try {
    const rpcUrl = process.env.POLYGON_RPC_URL || "https://polygon-bor-rpc.publicnode.com";
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl, {
      name: "polygon",
      chainId: 137,
    });
    const contract = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(currentBlock - 40_000, 0);
    const filter = contract.filters.ConditionPreparation();
    const maxBlockRange = 10_000;
    const eventChunks = await Promise.all(
      Array.from(
        { length: Math.ceil((currentBlock - fromBlock + 1) / maxBlockRange) },
        (_, index) => {
          const chunkStart = fromBlock + index * maxBlockRange;
          const chunkEnd = Math.min(chunkStart + maxBlockRange - 1, currentBlock);
          return contract.queryFilter(filter, chunkStart, chunkEnd);
        },
      ),
    );
    const events = eventChunks.flat();
    const recentEvents = events.slice(-limit).reverse();

    if (recentEvents.length === 0) {
      return gammaFallback;
    }

    return Promise.all(
      recentEvents.map(async (event) => {
        const block = await event.getBlock();

        return {
          type: "scanner_event" as const,
          conditionId: String(event.args?.conditionId ?? ""),
          oracle: String(event.args?.oracle ?? ""),
          questionId: String(event.args?.questionId ?? ""),
          outcomeSlotCount: String(event.args?.outcomeSlotCount ?? ""),
          txHash: event.transactionHash,
          blockNumber: event.blockNumber,
          timestamp: block.timestamp * 1000,
          source: "blockchain" as const,
        };
      }),
    );
  } catch (error) {
    console.warn(
      "Scanner history fallback to Gamma due to blockchain history failure:",
      error instanceof Error ? error.message : error,
    );
    return gammaFallback;
  }
}

async function getRecentGammaScannerEvents(limit: number): Promise<ScannerEventPayload[]> {
  const settings = loadSettings();
  const gamma = new GammaClient(settings.gammaHost);
  const scanLimit = Math.max(limit * 25, 250);
  const markets = (await gamma.listMarkets(scanLimit, true, false))
    .filter((market): market is Record<string, unknown> => typeof market === "object" && market !== null)
    .sort((a, b) => {
      const aTime = Date.parse(String(a.createdAt ?? a.startDate ?? a.updatedAt ?? 0));
      const bTime = Date.parse(String(b.createdAt ?? b.startDate ?? b.updatedAt ?? 0));
      return bTime - aTime;
    })
    .slice(0, limit);

  return markets.map((market) => ({
    type: "scanner_event" as const,
    conditionId: String(market.conditionId ?? ""),
    oracle: String(market.marketMakerAddress ?? CTF_ADDRESS),
    questionId: String(market.questionID ?? ""),
    outcomeSlotCount: String(normalizeOutcomeSlotCount(market.outcomes)),
    txHash: String(market.transactionHash ?? ""),
    blockNumber: 0,
    timestamp: Date.parse(String(market.createdAt ?? market.startDate ?? market.updatedAt ?? Date.now())),
    title: String(market.question ?? ""),
    slug: String(market.slug ?? ""),
    source: "gamma-recent" as const,
  }));
}

function normalizeOutcomeSlotCount(outcomes: unknown): number {
  if (Array.isArray(outcomes)) {
    return outcomes.length;
  }
  if (typeof outcomes === "string") {
    try {
      const parsed = JSON.parse(outcomes);
      return Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      return outcomes
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean).length;
    }
  }
  return 0;
}

export async function placeLimitOrder(params: {
  tokenId: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  tickSize: "0.1" | "0.01" | "0.001" | "0.0001";
  negRisk?: boolean;
}): Promise<unknown> {
  const settings = loadSettings();
  const notional = params.price * params.size;

  if (notional > settings.maxOrderUsdc) {
    throw new Error(
      `Order notional ${notional.toFixed(2)} exceeds BOT_MAX_ORDER_USDC=${settings.maxOrderUsdc.toFixed(2)}`,
    );
  }

    const client = await getRuntimeTradingClient();
    
    // Auto-detect negRisk if not provided
    const isNegRisk = params.negRisk !== undefined ? params.negRisk : await client.getNegRisk(params.tokenId);
    console.log(`[Trading] Token ${params.tokenId} negRisk status: ${isNegRisk}`);

    if (settings.dryRun) {
      return {
        dry_run: true,
        token_id: params.tokenId,
        side: params.side,
        price: params.price,
        size: params.size,
        tick_size: params.tickSize,
        negRisk: isNegRisk
      };
    }

    return client.placeLimitOrder({
      ...params,
      negRisk: isNegRisk
    });
}

export function pickOutcome(outcomes: OutcomeToken[], requestedLabel?: string): OutcomeToken {
  if (!requestedLabel) {
    return outcomes[0];
  }

  const outcome = outcomes.find((item) => item.label.toLowerCase() === requestedLabel.toLowerCase());
  if (!outcome) {
    const available = outcomes.map((item) => item.label).join(", ");
    throw new Error(`Unknown outcome '${requestedLabel}'. Available: ${available}`);
  }

  return outcome;
}
