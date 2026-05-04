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
import { fetchForecastPoints } from "./weather/forecasts.js";
import { parseWeatherMarket } from "./weather/parser.js";
import { estimateWeatherProbability } from "./weather/probability.js";
import { createPublicClient, erc20Abi, formatUnits, http } from "viem";
import { polygon } from "viem/chains";
import { ethers } from "ethers";

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
  dry_run: boolean;
  source: "wallet-usdc";
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
  const parsed = parseWeatherMarket(market);
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

  if (!rawMarket) {
    throw new Error("Market not found");
  }

  let extractedData = null;
  if (settings.groqApiKey && rawMarket.description && rawMarket.question) {
    try {
      const prompt = `
Extract structured information from the following market data.
Return ONLY a JSON object with the following schema, and no other text or formatting.
{
  "url": "<exact Event URL provided below>",
  "res_source": "<resolution source url if available>",
  "city": "<city name if applicable>",
  "t": "<temperature value if applicable>",
  "t_sys": "<'C' or 'F' — detect from description: if it mentions 'Fahrenheit' or 'degrees F', use 'F'; otherwise use 'C'>",
  "day": "<date string if applicable>",
  "station_code": "<weather station code extracted by the following rules, in priority order:
    1. If res_source contains 'weather.gov' and has a '?site=' query parameter, use that value (e.g. '?site=UUWW' → 'UUWW').
    2. If res_source is a wunderground.com URL like 'https://www.wunderground.com/history/daily/us/ca/los-angeles/KLAX', use the LAST path segment (e.g. 'KLAX').
    3. Otherwise null.>"
}

Market Question: ${rawMarket.question}
Market Slug: ${rawMarket.slug}
Event URL: https://polymarket.com/event/${Array.isArray(rawMarket.events) && rawMarket.events.length > 0 ? rawMarket.events[0].slug : rawMarket.slug}
Market Description: ${rawMarket.description}
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
          extractedData = JSON.parse(content);
        }
      } else {
        console.error("Groq API error", await response.text());
      }
    } catch (e) {
      console.error("Failed to parse Groq response", e);
    }
  }

  return {
    question: rawMarket.question,
    description: rawMarket.description,
    slug: rawMarket.slug,
    extractedData
  };
}

export async function getAccountSummary(): Promise<AccountSummaryPayload> {
  const settings = loadSettings();

  if (!settings.privateKey) {
    return {
      address: null,
      usdc_balance: null,
      dry_run: settings.dryRun,
      source: "wallet-usdc",
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

  return {
    address: accountAddress,
    usdc_balance: formatUnits(balance, 6),
    dry_run: settings.dryRun,
    source: "wallet-usdc",
  };
}

export async function getOpenPositions(): Promise<OpenPositionsPayload> {
  const settings = loadSettings();
  const funder = settings.funderAddress?.trim();
  let user: string;
  let wallet_source: "funder" | "eoa";

  if (funder) {
    user = funder;
    wallet_source = "funder";
  } else if (settings.privateKey) {
    const normalized = settings.privateKey.startsWith("0x")
      ? settings.privateKey
      : `0x${settings.privateKey}`;
    user = new ethers.Wallet(normalized).address;
    wallet_source = "eoa";
  } else {
    return { user: null, wallet_source: null, positions: [] };
  }

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
  const positions = rows.filter((row) => typeof row.size === "number" && row.size > 0);

  return { user, wallet_source, positions };
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
}): Promise<unknown> {
  const settings = loadSettings();
  const notional = params.price * params.size;

  if (notional > settings.maxOrderUsdc) {
    throw new Error(
      `Order notional ${notional.toFixed(2)} exceeds BOT_MAX_ORDER_USDC=${settings.maxOrderUsdc.toFixed(2)}`,
    );
  }

  if (settings.dryRun) {
    return {
      dry_run: true,
      token_id: params.tokenId,
      side: params.side,
      price: params.price,
      size: params.size,
      tick_size: params.tickSize,
    };
  }

  const client = await getRuntimeTradingClient();
  return client.placeLimitOrder(params);
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
