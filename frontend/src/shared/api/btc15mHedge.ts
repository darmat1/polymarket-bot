import { getJson, post, postJson } from "./http";
import type { Btc15mHedgeBotConfig, Btc15mHedgeStatusPayload, CheckMarketPayload } from "../types/api";

export function getBtc15mHedgeStatus() {
  return getJson<Btc15mHedgeStatusPayload>("/api/btc15m-hedge/status");
}

export function startBtc15mHedgeBot(config: Btc15mHedgeBotConfig) {
  return postJson<Btc15mHedgeStatusPayload>("/api/btc15m-hedge/start", { config });
}

export function stopBtc15mHedgeBot() {
  return post<Btc15mHedgeStatusPayload>("/api/btc15m-hedge/stop");
}

export function checkMarket(marketUrl: string) {
  return postJson<CheckMarketPayload>("/api/btc15m-hedge/check-market", { marketUrl });
}
