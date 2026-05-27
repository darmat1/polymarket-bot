import { getMarketDetails, placeMarketOrder, extractWeatherMarketData } from "./app.js";
import { matchWeatherStation } from "./weather/stations.js";

type WeatherPolymarketOutcome = {
  slug: string;
  question: string;
  yes_price: number;
  no_price: number;
  volume: number;
  liquidity: number;
  active: boolean;
  yes_token_id: string | null;
  no_token_id: string | null;
};

export type WeatherPolymarketEventPayload = {
  title: string;
  slug: string;
  end_date: string;
  description: string;
  total_volume: number;
  liquidity: number;
  markets: WeatherPolymarketOutcome[];
  airport: {
    name: string | null;
    icao: string;
    weather: WeatherTemperaturePayload | null;
  } | null;
};

export type WeatherTemperaturePayload = {
  temperature_c: number;
  rounded_c: number;
  // Native unit for this station (F or C) — used for trigger comparison
  temperature_native: number;
  rounded_native: number;
  unit: "F" | "C";
  daily_max_native: number | null; // today's observed max in native unit
};

export type WeatherPolymarketTrigger = {
  token_id: string;
  temp: number;
  amount: number;
  executed: boolean;
  slug: string | null;
  icao: string;
};

const ICAO_COORDS: Record<string, [number, number]> = {
  UUWW: [55.5961, 37.2675],
  UUEE: [55.9726, 37.4146],
  UUDD: [55.4086, 37.9063],
  RKSI: [37.4635, 126.44],
  KLGA: [40.7772, -73.8726],
  KJFK: [40.6398, -73.7789],
  CYYZ: [43.6777, -79.6248],
  KLAX: [33.9416, -118.4085],
  KSFO: [37.6213, -122.379],
  KORD: [41.9742, -87.9073],
  KATL: [33.6407, -84.4277],
  KDEN: [39.8561, -104.6737],
  KSEA: [47.4502, -122.3088],
  KMIA: [25.7932, -80.2906],
  KBOS: [42.3656, -71.0096],
  KPHX: [33.4342, -112.0116],
  KIAH: [29.9844, -95.3414],
  KMSP: [44.882, -93.2217],
  EGLL: [51.47, -0.4543],
  LFPG: [49.0097, 2.5479],
  EDDF: [50.0379, 8.5622],
  DNMM: [6.577, 3.321],
  FAOR: [-26.1392, 28.246],
  OMDB: [25.2528, 55.3644],
};

const GAMMA_API = "https://gamma-api.polymarket.com";
const activeTriggers = new Map<string, WeatherPolymarketTrigger>();

// Groq-extracted metadata cache per ICAO: timezone + unit
const icaoMetaCache = new Map<string, { timezone: string; unit: "F" | "C"; fetchedAt: number }>();
const ICAO_META_TTL = 60 * 60 * 1000; // 1 hour — market questions don't change

/**
 * Get timezone and unit for an ICAO station.
 * Looks up event_data from DB, calls Groq on the first market question.
 * Falls back to unit detected from question text, and UTC timezone.
 */
async function getIcaoMeta(icao: string): Promise<{ timezone: string; unit: "F" | "C" }> {
  const now = Date.now();
  const cached = icaoMetaCache.get(icao);
  if (cached && now - cached.fetchedAt < ICAO_META_TTL) {
    return { timezone: cached.timezone, unit: cached.unit };
  }

  let timezone = "UTC";
  let unit: "F" | "C" = "C";

  try {
    const { getDb } = await import("./db/client.js");
    const db = getDb();
    const result = await db.query<{ event_data: any }>(
      `SELECT event_data FROM weather_sessions WHERE icao = $1 AND event_data IS NOT NULL ORDER BY updated_at DESC LIMIT 1`,
      [icao]
    );
    const markets: any[] = result.rows[0]?.event_data?.markets ?? [];

    // Extract unit directly from question text (fast, no API call)
    for (const m of markets) {
      if (/°F/i.test(m.question ?? "")) { unit = "F"; break; }
      if (/°C/i.test(m.question ?? "")) { unit = "C"; break; }
    }

    // Call Groq for timezone using the first market question
    if (markets.length > 0) {
      const first = markets[0];
      const extracted = await extractWeatherMarketData(
        first.question ?? "",
        first.description ?? first.question ?? "",
        first.slug,
        null,
      );
      if (extracted?.timezone) timezone = extracted.timezone;
      if (extracted?.t_sys === "F") unit = "F";
      else if (extracted?.t_sys === "C") unit = "C";
    }
  } catch { /* keep defaults */ }

  icaoMetaCache.set(icao, { timezone, unit, fetchedAt: now });
  return { timezone, unit };
}

export function extractSlugFromUrl(url: string): string | null {
  // Handles /event/<slug>, /uk/event/<slug>, /us/event/<slug>, etc.
  const match = url.match(/\/event\/([^/?#\s]+)/i);
  return match?.[1] ?? null;
}

// Normalize any Polymarket URL to canonical https://polymarket.com/event/<slug>
export function normalizePolymarketUrl(url: string): string {
  const slug = extractSlugFromUrl(url);
  if (!slug) return url;
  return `https://polymarket.com/event/${slug}`;
}

export async function getWeatherPolymarketEvent(slug: string): Promise<WeatherPolymarketEventPayload | null> {
  const response = await fetch(`${GAMMA_API}/events?slug=${encodeURIComponent(slug)}`, {
    headers: {
      accept: "application/json",
      "user-agent": "Mozilla/5.0",
    },
  });
  if (!response.ok) {
    throw new Error(`Gamma API failed: ${response.status}`);
  }
  const data = (await response.json()) as Array<Record<string, unknown>>;
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }

  const raw = data[0] ?? {};
  const description = String(raw.description ?? "");
  const markets = Array.isArray(raw.markets) ? raw.markets : [];
  const parsedMarkets = markets
    .map((market) => parseMarket(market as Record<string, unknown>))
    .filter(Boolean) as WeatherPolymarketOutcome[];

  let [airportName, icao] = extractAirportFromDescription(description);

  if (!icao) {
    const firstActiveMarket = parsedMarkets.find((market) => market.active);
    if (firstActiveMarket?.slug) {
      try {
        const details = await getMarketDetails(firstActiveMarket.slug);
        const extracted = details?.extractedData;
        if (extracted?.station_code) {
          icao = extracted.station_code;
          airportName = extracted.city ?? airportName ?? extracted.station_code;
        }
      } catch {
        // best-effort fallback only
      }
    }
  }

  const unitHint = detectUnitFromMarkets(parsedMarkets);
  const weather = icao ? await getCurrentTemperature(icao, unitHint) : null;

  return {
    title: String(raw.title ?? raw.slug ?? ""),
    slug: String(raw.slug ?? ""),
    end_date: String(raw.endDate ?? ""),
    description,
    total_volume: sumOr(raw.volume, markets, "volume"),
    liquidity: sumOr(raw.liquidity, markets, "liquidity"),
    markets: parsedMarkets,
    airport: icao
      ? {
          name: airportName,
          icao,
          weather,
        }
      : null,
  };
}

function cToF(c: number): number {
  return c * 9 / 5 + 32;
}

// Cache: icao -> { data: obs[], fetchedAt: number }
// Single fetch covers both current temp and daily max.
const metarHistoryCache = new Map<string, { data: any[]; fetchedAt: number }>();
const METAR_CACHE_TTL = 60 * 1000; // 60 seconds — matches weather polling cycle

/**
 * How many hours have elapsed since local midnight in the given timezone.
 * Add 1 as buffer so the API doesn't clip the earliest observation.
 * Minimum 1, maximum 25.
 */
function hoursSinceMidnightLocal(timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0");
  return Math.min(25, Math.max(1, Math.ceil(h + m / 60) + 1));
}

/** Fetch (or return cached) METAR history since 00:00 local time for an ICAO station. */
async function getMetarHistory(icao: string, timezone: string): Promise<any[] | null> {
  const now = Date.now();
  const cached = metarHistoryCache.get(icao);
  if (cached && now - cached.fetchedAt < METAR_CACHE_TTL && cached.data.length > 0) {
    return cached.data;
  }
  try {
    const hours = hoursSinceMidnightLocal(timezone);
    const url = `https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(icao)}&format=json&hours=${hours}`;
    const res = await fetch(url, { headers: { "User-Agent": "WeatherPolymarketBot/1.0" } });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    metarHistoryCache.set(icao, { data, fetchedAt: now });
    return data;
  } catch {
    return null;
  }
}


/** Daily max temperature from METAR history filtered to today in local timezone. */
function getDailyMaxFromHistory(observations: any[], timezone: string, unit: "F" | "C"): number | null {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: timezone });
  const todayObs = observations.filter((obs: any) => {
    const d = new Date((obs.obsTime ?? 0) * 1000);
    return d.toLocaleDateString("en-CA", { timeZone: timezone }) === today;
  });
  if (todayObs.length === 0) return null;
  let maxC = -Infinity;
  for (const obs of todayObs) {
    const t = typeof obs.temp === "number" ? obs.temp : parseFloat(String(obs.temp ?? ""));
    if (Number.isFinite(t) && t > maxC) maxC = t;
  }
  if (maxC === -Infinity) return null;
  return unit === "F" ? round((maxC * 9) / 5 + 32, 1) : round(maxC, 1);
}

export async function getCurrentTemperature(icao: string, unitHint?: "F" | "C"): Promise<WeatherTemperaturePayload | null> {
  const normalized = icao.trim().toUpperCase();
  // Determine station unit and timezone via Groq extraction (cached per ICAO)
  const meta = await getIcaoMeta(normalized);
  const unit: "F" | "C" = unitHint ?? meta.unit;
  const timezone = meta.timezone;

  // Fetch METAR history since 00:00 local time — reuse for current temp AND daily max
  const metarObs = await getMetarHistory(normalized, timezone);

  let tempC = await getTemperatureFromNws(normalized);
  if (tempC === null && metarObs) {
    // Most recent observation = current temp
    const t = metarObs[0]?.temp;
    if (typeof t === "number") tempC = t;
  }
  if (tempC === null) {
    tempC = await getTemperatureFromMetarCentral(normalized);
  }
  if (tempC === null) {
    const coords = ICAO_COORDS[normalized];
    if (coords) {
      tempC = await getTemperatureFromOpenMeteo(coords[0], coords[1]);
    }
  }
  if (tempC === null) {
    return null;
  }

  const tempNative = unit === "F" ? cToF(tempC) : tempC;

  // Daily max comes from the same METAR history — no extra request
  const daily_max_native = metarObs ? getDailyMaxFromHistory(metarObs, timezone, unit) : null;
  const reportedMax = daily_max_native !== null
    ? Math.max(daily_max_native, round(tempNative, 1))
    : null;

  return {
    temperature_c: round(tempC, 1),
    rounded_c: tempC >= 0 ? Math.round(tempC) : -Math.round(Math.abs(tempC)),
    temperature_native: round(tempNative, 1),
    rounded_native: Math.round(tempNative),
    unit,
    daily_max_native: reportedMax,
  };
}

export function setWeatherPolymarketTrigger(trigger: {
  token_id: string;
  temp_threshold: number;
  amount: number;
  icao: string;
  slug?: string | null;
}): WeatherPolymarketTrigger {
  const normalizedIcao = trigger.icao.trim().toUpperCase();
  const key = `${normalizedIcao}_${trigger.token_id}`;
  const value: WeatherPolymarketTrigger = {
    token_id: trigger.token_id,
    temp: Math.round(trigger.temp_threshold),
    amount: trigger.amount,
    executed: false,
    slug: trigger.slug ?? null,
    icao: normalizedIcao,
  };
  activeTriggers.set(key, value);
  return value;
}

export function listWeatherPolymarketTriggers(icao: string): WeatherPolymarketTrigger[] {
  const normalizedIcao = icao.trim().toUpperCase();
  return Array.from(activeTriggers.values()).filter((trigger) => trigger.icao === normalizedIcao);
}

export function clearWeatherPolymarketTriggers(icao: string, tokenId?: string): WeatherPolymarketTrigger[] {
  const normalizedIcao = icao.trim().toUpperCase();
  const removed: WeatherPolymarketTrigger[] = [];
  for (const [key, trigger] of activeTriggers.entries()) {
    if (trigger.icao !== normalizedIcao) {
      continue;
    }
    if (tokenId && trigger.token_id !== tokenId) {
      continue;
    }
    removed.push(trigger);
    activeTriggers.delete(key);
  }
  return removed;
}

export async function checkWeatherPolymarketTriggers(icao: string, currentRounded: number) {
  const normalizedIcao = icao.trim().toUpperCase();

  // Convert current temp to native unit for this station before comparing
  const meta = await getIcaoMeta(normalizedIcao);
  const unit = meta.unit;
  const currentNative = unit === "F" ? Math.round(cToF(currentRounded)) : currentRounded;

  const executed: Array<{
    token_id: string;
    temp_threshold: number;
    amount: number;
    response: unknown;
  }> = [];

  for (const trigger of activeTriggers.values()) {
    if (trigger.icao !== normalizedIcao || trigger.executed || currentNative < trigger.temp) {
      continue;
    }
    const response = await placeMarketOrder({
      tokenId: trigger.token_id,
      side: "buy",
      amount: trigger.amount,
      tickSize: "0.01",
    });
    trigger.executed = true;
    executed.push({
      token_id: trigger.token_id,
      temp_threshold: trigger.temp,
      amount: trigger.amount,
      response,
    });
  }

  return { executed };
}

function detectUnitFromMarkets(markets: WeatherPolymarketOutcome[]): "F" | "C" {
  for (const m of markets) {
    if (/°F/i.test(m.question)) return "F";
    if (/°C/i.test(m.question)) return "C";
  }
  return "C";
}

function parseMarket(raw: Record<string, unknown>): WeatherPolymarketOutcome | null {
  const outcomeNames = parseJsonArray(raw.outcomes);
  const outcomePrices = parseJsonArray(raw.outcomePrices).map((value) => Number(value) || 0);
  const tokenIds = parseJsonArray(raw.clobTokenIds).map((value) => String(value));

  if (outcomeNames.length === 0) {
    return null;
  }

  const yesIndex = outcomeNames.findIndex((name) => String(name).toLowerCase() === "yes");
  const noIndex = outcomeNames.findIndex((name) => String(name).toLowerCase() === "no");
  const fallbackYesIndex = yesIndex >= 0 ? yesIndex : 0;
  const fallbackNoIndex = noIndex >= 0 ? noIndex : 1;

  return {
    slug: String(raw.slug ?? ""),
    question: String(raw.question ?? ""),
    yes_price: outcomePrices[fallbackYesIndex] ?? 0,
    no_price: outcomePrices[fallbackNoIndex] ?? 0,
    volume: Number(raw.volume ?? 0) || 0,
    liquidity: Number(raw.liquidity ?? 0) || 0,
    active: Boolean(raw.active ?? true),
    yes_token_id: tokenIds[fallbackYesIndex] ?? null,
    no_token_id: tokenIds[fallbackNoIndex] ?? null,
  };
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function extractAirportFromDescription(description: string): [string | null, string | null] {
  if (!description) {
    return [null, null];
  }
  const siteMatch = description.match(/[?&]site=([A-Z]{4})\b/);
  const pathMatch = description.match(/\/([A-Z]{4})(?:[/?#."]|$)/);
  const stationMatch = matchWeatherStation(description);
  const icaoCandidates = Array.from(description.matchAll(/\b([A-Z]{4})\b/g))
    .map((match) => match[1])
    .filter((code) => code !== "NOAA");
  const nameMatch = description.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Intl\s+)?Airport)/);
  const icao =
    siteMatch?.[1] ??
    pathMatch?.[1] ??
    stationMatch?.station ??
    icaoCandidates[0] ??
    null;
  const airportName =
    nameMatch?.[1] ??
    stationMatch?.label ??
    (icao ? `Airport ${icao}` : null);
  return [airportName, icao];
}

async function getTemperatureFromNws(icao: string): Promise<number | null> {
  try {
    const response = await fetch(
      `https://api.weather.gov/stations/${encodeURIComponent(icao)}/observations/latest`,
      {
        headers: {
          Accept: "application/geo+json",
          "User-Agent": "WeatherPolymarketBot/1.0",
        },
      }
    );
    if (!response.ok) return null;
    const data = (await response.json()) as { properties?: { temperature?: { value?: number | null } } };
    const value = data.properties?.temperature?.value;
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}


async function getTemperatureFromMetarCentral(icao: string): Promise<number | null> {
  try {
    const response = await fetch(`https://api.metarcentral.com/v1/metar/?ids=${encodeURIComponent(icao)}`);
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as Array<{ temperature?: number }>;
    const value = data[0]?.temperature;
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}

async function getTemperatureFromOpenMeteo(lat: number, lon: number): Promise<number | null> {
  try {
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      current_weather: "true",
      temperature_unit: "celsius",
    });
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as { current_weather?: { temperature?: number } };
    const value = data.current_weather?.temperature;
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sumOr(rootValue: unknown, markets: unknown[], key: "volume" | "liquidity"): number {
  const direct = Number(rootValue ?? 0);
  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }
  return markets.reduce<number>((sum, market) => {
    const raw = typeof market === "object" && market !== null ? (market as Record<string, unknown>)[key] : 0;
    return sum + (Number(raw ?? 0) || 0);
  }, 0);
}
