import { deleteJson, getJson } from "./http";
import type { ActiveBotSlugsPayload, EventLogPayload } from "../types/api";

export function getEventLog(limit = 50) {
  return getJson<EventLogPayload>(`/api/event-log?limit=${limit}`);
}

export function clearEventLog() {
  return deleteJson<Record<string, never>>("/api/event-log");
}

export function getActiveBotSlugs() {
  return getJson<ActiveBotSlugsPayload>("/api/bot/active-slugs");
}
