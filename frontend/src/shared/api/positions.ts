import { getJson, postJson } from "./http";
import type {
  ActivateMarketBotPayload,
  BasicOkPayload,
  ManualSellPayload,
  MarketBotStatusPayload,
  OpenPositionsPayload,
} from "../types/api";

export function getPositions() {
  return getJson<OpenPositionsPayload>("/api/positions");
}

export function submitManualSell(marketSlug: string, tokenId: string) {
  return postJson<ManualSellPayload>("/api/bot/manual-sell", {
    marketSlug,
    tokenId,
  });
}

export function getMarketBotStatus(slug: string) {
  const params = new URLSearchParams({ slug });
  return getJson<MarketBotStatusPayload>(`/api/bot/status?${params.toString()}`);
}

export function activateMarketBot(payload: ActivateMarketBotPayload) {
  return postJson<BasicOkPayload>("/api/bot/activate", payload);
}

export function deactivateMarketBot(marketSlug: string) {
  return postJson<BasicOkPayload>("/api/bot/deactivate", { marketSlug });
}

export function updateBotSettings(marketSlug: string, patch: { expectHigher?: boolean }) {
  return postJson<BasicOkPayload>("/api/bot/update-settings", { marketSlug, ...patch });
}

export function getStationHistory(stationCode: string) {
  const params = new URLSearchParams({ station: stationCode });
  return getJson<{ history: Array<{ obsTime: number; temp: number }> }>(`/api/station-history?${params.toString()}`);
}
