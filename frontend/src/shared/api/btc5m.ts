import { getJson, post } from "./http";
import type { Btc5mBotStatus } from "../types/api";

export function getBtc5mStatus() {
  return getJson<Btc5mBotStatus>("/api/btc5m/status");
}

export function toggleBtc5mBot(active: boolean) {
  return post<Btc5mBotStatus>(active ? "/api/btc5m/stop" : "/api/btc5m/start");
}
