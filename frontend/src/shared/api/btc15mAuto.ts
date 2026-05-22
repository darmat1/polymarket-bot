import { getJson, post, postJson } from "./http";
import type { Btc15mAutoStartConfig, Btc15mAutoStatusPayload } from "../types/api";

export function getBtc15mAutoStatus() {
  return getJson<Btc15mAutoStatusPayload>("/api/btc15m-auto/status");
}

export function resetBtc15mAutoBudget() {
  return post<Btc15mAutoStatusPayload>("/api/btc15m-auto/reset-budget");
}

export function hardResetBtc15mAutoBot() {
  return post<Btc15mAutoStatusPayload>("/api/btc15m-auto/hard-reset");
}

export function toggleBtc15mAutoBot(active: boolean, config: Btc15mAutoStartConfig) {
  if (active) {
    return post<Btc15mAutoStatusPayload>("/api/btc15m-auto/stop");
  }

  return postJson<Btc15mAutoStatusPayload>("/api/btc15m-auto/start", { config });
}
