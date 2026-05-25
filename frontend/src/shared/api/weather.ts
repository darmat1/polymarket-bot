import { deleteJson, postJson, getJson } from "./http";
import type {
  WeatherPolymarketCheckTriggersPayload,
  WeatherPolymarketClearTriggersPayload,
  WeatherPolymarketEventPayload,
  MarketDetailsPayload,
  WeatherPolymarketSetTriggerPayload,
  WeatherPolymarketTradingStatusPayload,
  WeatherPolymarketTriggersPayload,
  WeatherPolymarketWeather,
} from "../types/api";

export function getWeatherPolymarketEvent(url: string) {
  return postJson<WeatherPolymarketEventPayload>("/api/weather-polymarket/event", { url });
}

export function getWeatherPolymarketWeather(icao: string) {
  return postJson<WeatherPolymarketWeather>("/api/weather-polymarket/weather", { icao });
}

export function getWeatherPolymarketTradingStatus() {
  return getJson<WeatherPolymarketTradingStatusPayload>("/api/weather-polymarket/trading-status");
}

export function setWeatherPolymarketTrigger(payload: {
  token_id: string;
  temp_threshold: number;
  amount: number;
  icao: string;
  slug?: string | null;
}) {
  return postJson<WeatherPolymarketSetTriggerPayload>("/api/weather-polymarket/triggers", payload);
}

export function listWeatherPolymarketTriggers(icao: string) {
  const params = new URLSearchParams({ icao });
  return getJson<WeatherPolymarketTriggersPayload>(
    `/api/weather-polymarket/triggers?${params.toString()}`,
  );
}

export function clearWeatherPolymarketTriggers(icao: string, token_id?: string) {
  return deleteJson<WeatherPolymarketClearTriggersPayload>("/api/weather-polymarket/triggers", {
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ icao, token_id }),
  });
}

export function checkWeatherPolymarketTriggers(icao: string, current_rounded: number) {
  return postJson<WeatherPolymarketCheckTriggersPayload>(
    "/api/weather-polymarket/check-triggers",
    { icao, current_rounded },
  );
}

export function getMarketDetails(slug: string) {
  const params = new URLSearchParams({ slug });
  return getJson<MarketDetailsPayload>(`/api/market-details?${params.toString()}`);
}
