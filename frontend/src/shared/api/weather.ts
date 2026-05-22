import { getJson } from "./http";
import type {
  HourlyForecastPayload,
  MarketDetailsPayload,
  SearchEventsPayload,
  StationHistoryPayload,
} from "../types/api";

export function searchWeatherEvents(search: string) {
  const params = new URLSearchParams();
  if (search.trim()) {
    params.set("search", search.trim());
  }

  return getJson<SearchEventsPayload>(`/api/search-events?${params.toString()}`);
}

export function getHourlyForecast(slug: string) {
  const params = new URLSearchParams({
    slug,
    past_days: "1",
  });
  return getJson<HourlyForecastPayload>(`/api/hourly-forecast?${params.toString()}`);
}

export function getStationHistory(stationCode: string) {
  const params = new URLSearchParams({ station: stationCode });
  return getJson<StationHistoryPayload>(`/api/station-history?${params.toString()}`);
}

export function getMarketDetails(slug: string) {
  const params = new URLSearchParams({ slug });
  return getJson<MarketDetailsPayload>(`/api/market-details?${params.toString()}`);
}
