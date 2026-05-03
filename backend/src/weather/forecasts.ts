import { type ForecastPoint, type ParsedWeatherMarket } from "../models.js";
import { getWeatherStations } from "./stations.js";

type OpenMeteoResponse = {
  daily?: {
    time?: string[];
    temperature_2m_max?: number[];
  };
};

const SOURCE_MODELS = [
  { source: "ecmwf" as const, model: "ecmwf_ifs025" },
  { source: "gfs" as const, model: "gfs_seamless" },
];

export async function fetchForecastPoints(parsed: ParsedWeatherMarket): Promise<ForecastPoint[]> {
  const station = getWeatherStations().find((item) => item.key === parsed.cityKey);
  if (!station) {
    return [];
  }

  const points = await Promise.all(
    SOURCE_MODELS.map(async ({ source, model }) => {
      const url = new URL("https://api.open-meteo.com/v1/forecast");
      url.searchParams.set("latitude", String(station.latitude));
      url.searchParams.set("longitude", String(station.longitude));
      url.searchParams.set("daily", "temperature_2m_max");
      url.searchParams.set("start_date", parsed.targetDate);
      url.searchParams.set("end_date", parsed.targetDate);
      url.searchParams.set("timezone", "UTC");
      url.searchParams.set("models", model);
      url.searchParams.set("temperature_unit", parsed.unit === "F" ? "fahrenheit" : "celsius");

      const response = await fetch(url, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as OpenMeteoResponse;
      const times = payload.daily?.time ?? [];
      const highs = payload.daily?.temperature_2m_max ?? [];
      const index = times.findIndex((value) => value === parsed.targetDate);
      const forecastHigh = index >= 0 ? highs[index] : highs[0];

      if (typeof forecastHigh !== "number" || Number.isNaN(forecastHigh)) {
        return null;
      }

      return {
        source,
        targetDate: parsed.targetDate,
        forecastHigh,
        unit: parsed.unit,
      } satisfies ForecastPoint;
    }),
  );

  return points.filter((point): point is ForecastPoint => point !== null);
}
