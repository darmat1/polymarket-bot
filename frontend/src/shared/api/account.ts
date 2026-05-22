import { getJson } from "./http";
import type { AccountSummaryPayload, UserWebSocketAuthPayload } from "../types/api";

export function getAccountSummary() {
  return getJson<AccountSummaryPayload>("/api/account-summary");
}

export function getUserWebSocketAuth() {
  return getJson<UserWebSocketAuthPayload>("/api/user-ws-auth");
}
