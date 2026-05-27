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

export interface ScalperOpenOrderPayload {
  orderId: string;
  marketSlug: string | null;
  marketUrl: string | null;
  outcome: string | null;
  tokenId: string;
  side: string;
  price: string;
  originalSize: string;
  matchedSize: string;
  status: string;
  createdAt: number;
}

export interface ScalperOpenOrdersResponse {
  active: boolean;
  orders: ScalperOpenOrderPayload[];
}

export interface UserWebSocketAuthPayload {
  available: boolean;
  source: "env" | "unavailable";
  auth: {
    apiKey: string;
    secret: string;
    passphrase: string;
  } | null;
  key_preview: string | null;
  passphrase_preview: string | null;
  last_error: string | null;
}

const extractionCache = new Map<string, { data: any; expires: number }>();
const EXTRACTION_TTL = 30 * 60 * 1000; // 30 minutes

// Cache negRisk status to avoid repeated API calls before each order (latency killer)
const negRiskCache = new Map<string, boolean>();
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
        extractedData = normalizeWeatherExtraction(JSON.parse(content), {
          marketSlug,
          description,
        });
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
  return rows.filter(isLivePositionRow);
}

function isLivePositionRow(row: PolymarketPositionRow): boolean {
  if (typeof row.size !== "number" || row.size <= 0) {
    return false;
  }

  if (row.redeemable === true) {
    return false;
  }

  if (typeof row.currentValue === "number" && row.currentValue <= 0) {
    return false;
  }

  if (typeof row.curPrice === "number" && row.curPrice <= 0) {
    return false;
  }

  return true;
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
function normalizeWeatherExtraction(payload: any, context?: {
  marketSlug?: string;
  description?: string;
}) {
  const base = payload?.market_parameters && typeof payload.market_parameters === "object"
    ? payload.market_parameters
    : payload;

  const fallbackUrl = context?.marketSlug ? `https://polymarket.com/event/${context.marketSlug}` : null;
  const fallbackResSource = extractFirstHttpUrl(
    typeof base?.res_source === "string" ? base.res_source : context?.description,
  );

  return {
    city: base?.city ?? base?.location ?? null,
    timezone: base?.timezone ?? null,
    t: typeof base?.t === "number" ? base.t : typeof base?.target_temperature === "number" ? base.target_temperature : null,
    t_sys: base?.t_sys ?? base?.temperature_unit ?? null,
    day: base?.day ?? base?.date ?? null,
    station_code: base?.station_code ?? null,
    url: typeof base?.url === "string" ? base.url : fallbackUrl,
    res_source: typeof base?.res_source === "string" ? base.res_source : fallbackResSource,
  };
}

function extractFirstHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const match = value.match(/https?:\/\/[^\s)"'>]+/i);
  return match?.[0] ?? null;
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
    
    // Auto-detect negRisk with cache to avoid extra API round-trip before order
    let isNegRisk: boolean;
    if (params.negRisk !== undefined) {
      isNegRisk = params.negRisk;
    } else if (negRiskCache.has(params.tokenId)) {
      isNegRisk = negRiskCache.get(params.tokenId)!;
    } else {
      isNegRisk = await client.getNegRisk(params.tokenId);
      negRiskCache.set(params.tokenId, isNegRisk);
    }
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

export async function placeMarketOrder(params: {
  tokenId: string;
  side: "buy" | "sell";
  amount: number;
  tickSize?: "0.1" | "0.01" | "0.001" | "0.0001";
  negRisk?: boolean;
  orderType?: "FOK" | "FAK";
}): Promise<unknown> {
  const settings = loadSettings();

  if (params.amount > settings.maxOrderUsdc) {
    throw new Error(
      `Order amount ${params.amount.toFixed(2)} exceeds BOT_MAX_ORDER_USDC=${settings.maxOrderUsdc.toFixed(2)}`,
    );
  }

  const client = await getRuntimeTradingClient();
  // Use cached negRisk to avoid extra API round-trip before order
  let isNegRisk: boolean;
  if (params.negRisk !== undefined) {
    isNegRisk = params.negRisk;
  } else if (negRiskCache.has(params.tokenId)) {
    isNegRisk = negRiskCache.get(params.tokenId)!;
  } else {
    isNegRisk = await client.getNegRisk(params.tokenId);
    negRiskCache.set(params.tokenId, isNegRisk);
  }
  console.log(`[Trading] Token ${params.tokenId} negRisk status: ${isNegRisk}`);

  if (settings.dryRun) {
    return {
      dry_run: true,
      token_id: params.tokenId,
      side: params.side,
      amount: params.amount,
      tick_size: params.tickSize ?? "0.01",
      negRisk: isNegRisk,
      orderType: params.orderType ?? "FOK",
    };
  }

  const { OrderType } = await import("@polymarket/clob-client");
  const orderTypeEnum = params.orderType === "FAK" ? OrderType.FAK : OrderType.FOK;

  return client.placeMarketOrder({
    tokenId: params.tokenId,
    side: params.side,
    amount: params.amount,
    tickSize: (params.tickSize as any) ?? "0.01",
    negRisk: isNegRisk,
    orderType: orderTypeEnum,
  });
}
