import { type ForecastPoint, type ParsedWeatherMarket } from "../models.js";
import { getWeatherStations } from "./stations.js";

type OpenMeteoResponse = {
  daily?: {
    time?: string[];
    [key: string]: any; // To handle dynamic model keys
  };
};

const SOURCE_MODELS = [
  { source: "ecmwf" as const, model: "ecmwf_ifs025" },
  { source: "gfs" as const, model: "gfs_seamless" },
];

// Cache: cityKey_unit -> { days: Map<date, ForecastPoint[]>, expires: number }
const cityCache = new Map<string, { days: Map<string, ForecastPoint[]>; expires: number }>();
// Track inflight requests for the entire city forecast
const inflightCityRequests = new Map<string, Promise<Map<string, ForecastPoint[]>>>();

const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

export async function fetchForecastPoints(parsed: ParsedWeatherMarket): Promise<ForecastPoint[]> {
  const station = getWeatherStations().find((item) => item.key === parsed.cityKey);
  if (!station) {
    return [];
  }

  // 0. Skip future dates - we only care about realized or current day data
  const today = new Date().toISOString().split("T")[0];
  if (parsed.targetDate > today) {
    return [];
  }

  const cityUnitKey = `${parsed.cityKey}-${parsed.unit}`;
  const now = Date.now();

  // 1. Check if we have a valid city-wide cache
  const cached = cityCache.get(cityUnitKey);
  if (cached && cached.expires > now) {
    return cached.days.get(parsed.targetDate) ?? [];
  }

  // 2. If a request for this city is already in flight, wait for it
  const inflight = inflightCityRequests.get(cityUnitKey);
  if (inflight) {
    const fullForecast = await inflight;
    return fullForecast.get(parsed.targetDate) ?? [];
  }

  // 3. Initiate full city fetch
  const fetchPromise = (async () => {
    try {
      const fullForecast = await performFullCityForecastFetch(station, parsed);
      if (fullForecast.size > 0) {
        cityCache.set(cityUnitKey, {
          days: fullForecast,
          expires: Date.now() + CACHE_TTL,
        });
      }
      return fullForecast;
    } finally {
      inflightCityRequests.delete(cityUnitKey);
    }
  })();

  inflightCityRequests.set(cityUnitKey, fetchPromise);
  const result = await fetchPromise;
  return result.get(parsed.targetDate) ?? [];
}

async function performFullCityForecastFetch(
  station: ReturnType<typeof getWeatherStations>[number],
  parsed: ParsedWeatherMarket,
): Promise<Map<string, ForecastPoint[]>> {
  const dailyForecasts = new Map<string, ForecastPoint[]>();

  await Promise.all(
    SOURCE_MODELS.map(async ({ source, model }) => {
      const url = new URL("https://api.open-meteo.com/v1/forecast");
      url.searchParams.set("latitude", String(station.latitude));
      url.searchParams.set("longitude", String(station.longitude));
      url.searchParams.set("daily", "temperature_2m_max");
      // Fetch 7 days of forecast starting from today/start of forecast
      url.searchParams.set("forecast_days", "7");
      url.searchParams.set("timezone", "UTC");
      url.searchParams.set("models", model);
      url.searchParams.set("temperature_unit", parsed.unit === "F" ? "fahrenheit" : "celsius");

      const response = await fetch(url, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as OpenMeteoResponse;
      const times = payload.daily?.time ?? [];
      // The key in payload.daily will be something like "temperature_2m_max_ecmwf_ifs025" or just "temperature_2m_max"
      // Open-Meteo usually returns it as temperature_2m_max if only one model is requested per call
      const highs = payload.daily?.temperature_2m_max ?? [];

      times.forEach((date, index) => {
        const high = highs[index];
        if (typeof high === "number" && !Number.isNaN(high)) {
          const points = dailyForecasts.get(date) ?? [];
          points.push({
            source,
            targetDate: date,
            forecastHigh: high,
            unit: parsed.unit,
          });
          dailyForecasts.set(date, points);
        }
      });
    }),
  );

  return dailyForecasts;
}
