import { getJson, post, postJson } from "./http";
import type { Btc15mStartConfig, Btc15mStatusPayload } from "../types/api";

export function getBtc15mStatus() {
  return getJson<Btc15mStatusPayload>("/api/btc15m/status");
}

export function resetBtc15mBudget() {
  return post<Btc15mStatusPayload>("/api/btc15m/reset-budget");
}

export function toggleBtc15mBot(active: boolean, config: Btc15mStartConfig) {
  if (active) {
    return post<Btc15mStatusPayload>("/api/btc15m/stop");
  }

  return postJson<Btc15mStatusPayload>("/api/btc15m/start", { config });
}
