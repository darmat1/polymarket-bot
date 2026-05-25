import { getMarketDetails, placeMarketOrder } from "./app.js";
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

export function extractSlugFromUrl(url: string): string | null {
  const match = url.match(/\/event\/([^/?#\s]+)/i);
  return match?.[1] ?? null;
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

  const weather = icao ? await getCurrentTemperature(icao) : null;

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

export async function getCurrentTemperature(icao: string): Promise<WeatherTemperaturePayload | null> {
  const normalized = icao.trim().toUpperCase();
  let tempC = await getTemperatureFromNoaa(normalized);
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
  return {
    temperature_c: round(tempC, 1),
    rounded_c: tempC >= 0 ? Math.round(tempC) : -Math.round(Math.abs(tempC)),
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
  const executed: Array<{
    token_id: string;
    temp_threshold: number;
    amount: number;
    response: unknown;
  }> = [];

  for (const trigger of activeTriggers.values()) {
    if (trigger.icao !== normalizedIcao || trigger.executed || currentRounded < trigger.temp) {
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

async function getTemperatureFromNoaa(icao: string): Promise<number | null> {
  try {
    const response = await fetch(`https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(icao)}&format=json`);
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as Array<{ temp?: number }>;
    const value = data[0]?.temp;
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
