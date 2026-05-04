export type EventLogEntry = {
  id: number;
  timestamp: number;
  marketSlug: string;
  type: "info" | "success" | "warn" | "error";
  trigger: "auto" | "manual";
  message: string;
};

let nextId = 1;
const MAX_ENTRIES = 200;
const entries: EventLogEntry[] = [];

export function logEvent(
  marketSlug: string,
  message: string,
  type: EventLogEntry["type"] = "info",
  trigger: EventLogEntry["trigger"] = "auto",
): EventLogEntry {
  const entry: EventLogEntry = {
    id: nextId++,
    timestamp: Date.now(),
    marketSlug,
    type,
    trigger,
    message,
  };
  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) {
    entries.length = MAX_ENTRIES;
  }
  return entry;
}

export function getEventLog(limit = 100): EventLogEntry[] {
  return entries.slice(0, limit);
}

export function clearEventLog(): void {
  entries.length = 0;
}
