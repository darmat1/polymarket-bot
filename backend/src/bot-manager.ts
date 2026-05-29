import { WebSocket, WebSocketServer } from "ws";
import { getOpenPositions, placeMarketOrder, cancelOpenOrdersForToken } from "./app.js";
import { logEvent } from "./event-log.js";
import { matchWeatherStation } from "./weather/stations.js";

export interface BotTask {
  marketSlug: string;
  stationCode: string;
  targetTemp: number;
  targetDate: string; // e.g. "May 3, 2026"
  tempUnit: "C" | "F";  // temperature unit the market uses
  outcome: string;    // "Yes" or "No"
  tokenId: string;
  active: boolean;
  expectHigher?: boolean;
  timezone?: string;
  lastPollTime?: number;
  logs: { timestamp: number; message: string; type: "info" | "warn" | "error" | "success" }[];
}

const activeTasks = new Map<string, BotTask>();
let wss: WebSocketServer | null = null;
let pollTimeout: NodeJS.Timeout | null = null;

// Last known peak temp per task slug — used to compute adaptive poll interval
const taskLastPeakTemp = new Map<string, number>();

const weatherCache = new Map<string, any[]>();
const MAX_CACHE_SIZE = 100;
const CACHE_TTL_MS = 25 * 1000; // 25s — always fresh for the fastest 30s poll interval

const weatherLastFetched = new Map<string, number>();

// Per-station: predicted next METAR observation time (Unix seconds)
const stationNextExpectedObs = new Map<string, number>();

// Coordinates for fallback Open-Meteo lookups (lat, lon)
const STATION_COORDS: Record<string, [number, number]> = {
  LFPB: [48.9736, 2.4414],
  LFPG: [49.0097, 2.5479],
  EGLL: [51.477, -0.461],
  UUWW: [55.5961, 37.2675],
  UUEE: [55.9726, 37.4146],
  UUDD: [55.4086, 37.9063],
  KLGA: [40.7772, -73.8726],
  KJFK: [40.6398, -73.7789],
  CYYZ: [43.6777, -79.6248],
  KLAX: [33.9416, -118.4085],
  KORD: [41.9742, -87.9073],
  KATL: [33.6407, -84.4277],
  OMDB: [25.2528, 55.3644],
};

async function fetchFromMetarCentral(stationCode: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.metarcentral.com/v1/metar/?ids=${encodeURIComponent(stationCode)}`, {
      headers: { 'User-Agent': 'WeatherPolymarketBot/1.0' },
    });
    if (!res.ok) return null;
    const data = await res.json() as Array<{ temperature?: number }>;
    const t = data[0]?.temperature;
    return typeof t === 'number' ? t : null;
  } catch {
    return null;
  }
}

async function fetchFromOpenMeteo(lat: number, lon: number): Promise<number | null> {
  try {
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      current_weather: 'true',
      temperature_unit: 'celsius',
    });
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
    if (!res.ok) return null;
    const data = await res.json() as { current_weather?: { temperature?: number } };
    const t = data.current_weather?.temperature;
    return typeof t === 'number' ? t : null;
  } catch {
    return null;
  }
}

type LogFn = (msg: string, type?: "info" | "warn" | "error" | "success") => void;

export async function getOrFetchStationHistory(stationCode: string, log?: LogFn): Promise<any[]> {
  const now = Date.now();
  const lastFetched = weatherLastFetched.get(stationCode) || 0;
  let cached = weatherCache.get(stationCode) || [];

  if (now - lastFetched < CACHE_TTL_MS && cached.length > 0) {
    return cached;
  }

  // Primary: aviationweather.gov METAR history
  log?.(`→ Requesting aviationweather.gov METAR for ${stationCode}...`, "info");
  try {
    const url = `https://aviationweather.gov/api/data/metar?ids=${stationCode}&format=json&hours=48`;
    const res = await fetch(url, { headers: { 'User-Agent': 'WeatherPolymarketBot/1.0' } });
    if (res.ok) {
      const data = await res.json();
      if (data && data.length > 0) {
        weatherLastFetched.set(stationCode, now);
        const merged = [...cached];
        for (const obs of data) {
          if (!merged.some(m => m.obsTime === obs.obsTime)) {
            merged.push(obs);
          }
        }
        merged.sort((a, b) => b.obsTime - a.obsTime);
        if (merged.length > MAX_CACHE_SIZE) merged.splice(MAX_CACHE_SIZE);
        weatherCache.set(stationCode, merged);
        log?.(`✓ aviationweather.gov: ${data.length} obs returned`, "info");
        return merged;
      } else {
        log?.(`✗ aviationweather.gov: empty response (status ${res.status})`, "warn");
      }
    } else {
      log?.(`✗ aviationweather.gov: HTTP ${res.status}`, "warn");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[BotManager] aviationweather.gov failed for ${stationCode}:`, err);
    log?.(`✗ aviationweather.gov error: ${msg}`, "warn");
  }

  // Fallback 1: MetarCentral (single current temp)
  log?.(`→ Trying MetarCentral fallback for ${stationCode}...`, "info");
  let fallbackTempC: number | null = await fetchFromMetarCentral(stationCode);
  if (fallbackTempC !== null) {
    console.warn(`[BotManager] Using MetarCentral fallback for ${stationCode}: ${fallbackTempC}°C`);
    log?.(`✓ MetarCentral: ${fallbackTempC}°C`, "warn");
  } else {
    log?.(`✗ MetarCentral: no data`, "warn");
  }

  // Fallback 2: Open-Meteo (by coordinates)
  if (fallbackTempC === null) {
    const coords = STATION_COORDS[stationCode.toUpperCase()];
    if (coords) {
      log?.(`→ Trying Open-Meteo fallback (${coords[0]}, ${coords[1]})...`, "info");
      fallbackTempC = await fetchFromOpenMeteo(coords[0], coords[1]);
      if (fallbackTempC !== null) {
        console.warn(`[BotManager] Using Open-Meteo fallback for ${stationCode}: ${fallbackTempC}°C`);
        log?.(`✓ Open-Meteo: ${fallbackTempC}°C`, "warn");
      } else {
        log?.(`✗ Open-Meteo: no data`, "error");
      }
    } else {
      log?.(`✗ No coordinates for ${stationCode} — cannot use Open-Meteo`, "error");
    }
  }

  // Synthesize a minimal observation from the fallback temp so downstream code works
  if (fallbackTempC !== null) {
    const syntheticObs = { obsTime: Math.floor(now / 1000), temp: fallbackTempC };
    weatherLastFetched.set(stationCode, now);
    // Merge into cache (keep historical observations, add synthetic current)
    const merged = cached.filter(m => m.obsTime !== syntheticObs.obsTime);
    merged.unshift(syntheticObs);
    merged.sort((a, b) => b.obsTime - a.obsTime);
    if (merged.length > MAX_CACHE_SIZE) merged.splice(MAX_CACHE_SIZE);
    weatherCache.set(stationCode, merged);
    return merged;
  }

  log?.(`✗ All weather sources failed — using stale cache (${cached.length} obs)`, "error");
  return cached;
}

// Compute median interval (seconds) between consecutive observations.
// data must be sorted descending by obsTime.
function computeObsIntervalSec(data: any[]): number {
  const gaps: number[] = [];
  for (let i = 0; i < Math.min(data.length - 1, 8); i++) {
    const gap = data[i].obsTime - data[i + 1].obsTime;
    if (gap > 5 * 60 && gap < 4 * 60 * 60) gaps.push(gap); // 5 min – 4 h
  }
  if (gaps.length === 0) return 30 * 60; // default 30 min
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

// After each successful fetch, recompute predicted next obs time.
function updateNextExpectedObs(stationCode: string, data: any[], log?: LogFn): void {
  if (!data || data.length === 0) return;
  const code = stationCode.toUpperCase();
  const latestObsTime: number = data[0].obsTime;
  const intervalSec = computeObsIntervalSec(data);
  const nextExpected = latestObsTime + intervalSec;
  stationNextExpectedObs.set(code, nextExpected);

  const latestStr = new Date(latestObsTime * 1000).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  const nextStr   = new Date(nextExpected   * 1000).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  const intervalMin = Math.round(intervalSec / 60);
  log?.(`📡 Latest obs: ${latestStr} | interval: ${intervalMin}min | next expected: ~${nextStr}`, "info");
}

// How many ms until we should start polling aggressively (FAST_WINDOW_SEC before expected obs).
const FAST_WINDOW_SEC = 5 * 60; // start fast polling 5 min before expected obs
const OVERDUE_GRACE_SEC = 10 * 60; // keep fast polling up to 10 min after expected (in case delayed)

function getMsUntilFastWindow(stationCode: string): number {
  const nextExpected = stationNextExpectedObs.get(stationCode.toUpperCase());
  if (nextExpected === undefined) return 60 * 1000; // no data yet → slow poll
  const nowSec = Date.now() / 1000;
  const windowStart = nextExpected - FAST_WINDOW_SEC;
  const windowEnd   = nextExpected + OVERDUE_GRACE_SEC;

  if (nowSec >= windowStart && nowSec <= windowEnd) return 0; // IN window → fast poll now
  if (nowSec > windowEnd) return 60 * 1000; // well past → slow poll (next cycle will recompute)
  return (windowStart - nowSec) * 1000; // ms until window opens
}

function getAdaptiveDelayMs(diff: number, stationCode?: string): number {
  if (diff > 10) return 15 * 60 * 1000; // 15 min
  if (diff > 5)  return 10 * 60 * 1000; // 10 min
  if (diff > 2)  return  2 * 60 * 1000; // 2 min
  if (diff > 1)  return 30 * 1000;       // 30 sec
  // diff <= 1°: sleep until just before next expected METAR, then poll every 15s
  if (!stationCode) return 60 * 1000;
  const msUntilWindow = getMsUntilFastWindow(stationCode);
  if (msUntilWindow === 0) return 15 * 1000; // in fast window
  return msUntilWindow; // sleep until window opens
}

function getAdaptiveDelayStr(diff: number, stationCode?: string): string {
  if (diff > 1) {
    const sec = Math.round(getAdaptiveDelayMs(diff) / 1000);
    return sec >= 60 ? `${Math.round(sec / 60)}min` : `${sec}s`;
  }
  if (!stationCode) return '60s';
  const msUntilWindow = getMsUntilFastWindow(stationCode);
  if (msUntilWindow === 0) return '15s (METAR window)';
  const sec = Math.round(msUntilWindow / 1000);
  if (sec >= 60) return `${Math.round(sec / 60)}min (until next METAR)`;
  return `${sec}s (until next METAR)`;
}

function scheduleNextPoll(): void {
  if (pollTimeout) {
    clearTimeout(pollTimeout);
    pollTimeout = null;
  }

  const activeSlugs = Array.from(activeTasks.entries())
    .filter(([, t]) => t.active)
    .map(([slug]) => slug);

  if (activeSlugs.length === 0) return;

  let minDiff = Infinity;
  let minDiffStation: string | undefined;
  for (const slug of activeSlugs) {
    const task = activeTasks.get(slug)!;
    const peak = taskLastPeakTemp.get(slug);
    if (peak !== undefined) {
      const diff = Math.abs(task.targetTemp - peak);
      if (diff < minDiff) {
        minDiff = diff;
        minDiffStation = task.stationCode;
      }
    }
  }

  const delayMs = minDiff === Infinity ? 45 * 1000 : getAdaptiveDelayMs(minDiff, minDiffStation);
  const delaySec = Math.round(delayMs / 1000);
  const diffStr = minDiff === Infinity ? '?' : minDiff.toFixed(1);
  console.log(`[BotManager] Next poll in ${delaySec}s (closest diff: ${diffStr}°)`);

  pollTimeout = setTimeout(() => void pollActiveTasks(), delayMs);
}

export function initBotManager(serverWss: WebSocketServer) {
  wss = serverWss;

  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      try {
        JSON.parse(data.toString());
      } catch (e) {
        // Not JSON or other error
      }
    });
  });
}

export function activateBot(task: BotTask) {
  console.log(`[BotManager] Activating bot for ${task.marketSlug}:`, JSON.stringify(task, null, 2));
  
  activeTasks.set(task.marketSlug, { 
    ...task, 
    active: true,
    logs: [{ timestamp: Date.now(), message: `Bot activated for ${task.outcome} (Target: ${task.targetTemp}${task.tempUnit})`, type: "success" }]
  });
  
  // Immediate poll then schedule adaptively
  void pollSingleTask(task.marketSlug).then(() => scheduleNextPoll());
}

export function deactivateBot(marketSlug: string) {
  const task = activeTasks.get(marketSlug);
  if (task) {
    task.active = false;
    addBotLog(marketSlug, "Bot deactivated.", "info");
  }
  taskLastPeakTemp.delete(marketSlug);
  console.log(`Bot deactivated for ${marketSlug}`);
  scheduleNextPoll();
}

export function updateBotSettings(marketSlug: string, patch: { expectHigher?: boolean }): boolean {
  const task = activeTasks.get(marketSlug);
  if (!task || !task.active) return false;

  if (patch.expectHigher !== undefined) {
    task.expectHigher = patch.expectHigher;
    const msg = patch.expectHigher
      ? "Hold through target ON — bot will NOT sell when temp hits target"
      : "Hold through target OFF — bot WILL sell when temp hits target";
    addBotLog(marketSlug, `⚙ Settings updated: ${msg}`, "success");
    console.log(`[BotManager] ${marketSlug} settings updated:`, patch);
  }

  return true;
}

export function getBotStatus(marketSlug: string) {
  return activeTasks.get(marketSlug) || { active: false };
}

export function getAllActiveBots() {
  return Array.from(activeTasks.entries())
    .filter(([_, task]) => task.active)
    .map(([slug, _]) => slug);
}

function addBotLog(marketSlug: string, message: string, type: "info" | "warn" | "error" | "success" = "info") {
  const task = activeTasks.get(marketSlug);
  if (!task) return;
  if (!task.logs) task.logs = [];
  const logEntry = { timestamp: Date.now(), message, type };
  task.logs.unshift(logEntry);
  if (task.logs.length > 20) task.logs.pop();
  
  broadcast({
    type: "bot_log",
    marketSlug,
    log: logEntry
  });
}

async function pollActiveTasks() {
  const slugs = Array.from(activeTasks.keys());
  for (const slug of slugs) {
    await pollSingleTask(slug);
  }
  scheduleNextPoll();
}

async function pollSingleTask(marketSlug: string) {
  const task = activeTasks.get(marketSlug);
  if (!task || !task.active) return;

  task.lastPollTime = Date.now();
  
  broadcast({
    type: "bot_heartbeat",
    marketSlug: task.marketSlug,
    lastPollTime: task.lastPollTime
  });

  const botLog: LogFn = (msg, type) => addBotLog(marketSlug, msg, type ?? "info");

  try {
    addBotLog(marketSlug, `⟳ Polling weather (station: ${task.stationCode})`, "info");
    const data = await getOrFetchStationHistory(task.stationCode, botLog);
    
    if (!data || data.length === 0) {
      addBotLog(marketSlug, "Weather API returned no data", "warn");
      return;
    }

    // Attempt to derive timezone if missing
    if (!task.timezone) {
      const matched = matchWeatherStation(task.stationCode);
      if (matched?.timezone) {
        task.timezone = matched.timezone;
        console.log(`[BotManager] Derived timezone ${task.timezone} for station ${task.stationCode}`);
      }
    }

    addBotLog(marketSlug, `API returned ${data.length} items. Parsing for ${task.targetDate} (TZ: ${task.timezone || 'UTC'})...`, "info");

    // Filter by target date using local timezone
    const dayData = data.filter(obs => {
      try {
        const tz = task.timezone || 'UTC';
        const d = new Date(obs.obsTime * 1000);
        
        // Robust way to get YYYY-MM-DD in the target timezone
        const localDateStr = d.toLocaleDateString('en-CA', { timeZone: tz });
        return localDateStr === task.targetDate;
      } catch (e) {
        // Fallback to UTC if timezone is invalid
        const d = new Date(obs.obsTime * 1000);
        const iso = d.toISOString().split('T')[0];
        return iso === task.targetDate;
      }
    });

    if (dayData.length === 0) {
      addBotLog(marketSlug, `No data found for target date ${task.targetDate}. Waiting...`, "warn");
      return;
    }

    // Find highest temperature of the day so far
    let maxTempC = -Infinity;
    let peakObs = dayData[0];

    for (const obs of dayData) {
      const t = typeof obs.temp === "number" ? obs.temp : parseFloat(obs.temp);
      if (t > maxTempC) {
        maxTempC = t;
        peakObs = obs;
      }
    }

    if (maxTempC !== -Infinity) {
      const tempC = maxTempC;
      const tempF = (tempC * 9 / 5) + 32;
      // Polymarket/Wunderground resolve °F markets to whole degrees — round to avoid
      // float noise like 27.8°C = 82.04°F triggering > 82°F incorrectly
      const tempInMarketUnit = task.tempUnit === "F" ? Math.round(tempF) : tempC;
      
      const tz = task.timezone || 'UTC';
      const peakTimeStr = new Date(peakObs.obsTime * 1000).toLocaleTimeString('en-US', { 
        timeZone: tz,
        hour12: true,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });

      // Store peak for adaptive scheduling
      taskLastPeakTemp.set(marketSlug, tempInMarketUnit);

      const diff = Math.abs(task.targetTemp - tempInMarketUnit);
      const nextStr = getAdaptiveDelayStr(diff, task.stationCode);

      addBotLog(marketSlug, `Peak for today: ${tempC.toFixed(1)}°C / ${tempF.toFixed(1)}°F (at ${peakTimeStr} ${tz}) | diff=${diff.toFixed(1)}° → next poll in ${nextStr}`, "info");
      console.log(`[BotManager] ${marketSlug} peak ${tempC}°C | diff=${diff.toFixed(1)}° | next=${nextStr}`);

      // Broadcast to clients (use the peak observation for the UI)
      broadcast({
        type: "weather_update",
        marketSlug,
        observation: peakObs
      });

      // Latest (most recent) observation for today — dayData is sorted descending
      const latestObs = dayData[0];
      const latestTempC = typeof latestObs.temp === "number" ? latestObs.temp : parseFloat(String(latestObs.temp));
      const latestTempInMarketUnit = task.tempUnit === "F" ? Math.round(latestTempC * 9 / 5 + 32) : latestTempC;

      // Update predicted next obs time based on actual observation history
      updateNextExpectedObs(task.stationCode, data, botLog);

      await checkExitCondition(task, tempInMarketUnit, latestTempInMarketUnit);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Error polling task for ${marketSlug}:`, error);
    addBotLog(marketSlug, `Polling error: ${msg}`, "error");
  }
}

async function checkExitCondition(task: BotTask, peakTemp: number, latestTemp: number) {
  // peakTemp  — highest observation today (already in market's unit: C or F)
  // latestTemp — most recent observation today (same unit)
  //
  // expectHigher = false  (default):
  //   User holds "No" betting temp WON'T reach target.
  //   Sell immediately when peak >= target.
  //
  // expectHigher = true  ("Hold through target"):
  //   User holds "No" on "highest temp ≤ target" (betting temp WILL exceed target).
  //   • peak > target  → our position wins → deactivate, no sell
  //   • peak == target AND latest < target → temp peaked at target and is falling
  //                                          daily high locked at ≤ target → SELL
  //   • peak == target AND latest >= target → still at/above target → HOLD
  //   • peak < target  → no action

  const unitSymbol = task.tempUnit === "F" ? "°F" : "°C";

  if (task.expectHigher) {
    if (peakTemp > task.targetTemp) {
      // Temp exceeded target — our position wins
      const msg = `Peak ${peakTemp.toFixed(1)}${unitSymbol} exceeded target ${task.targetTemp}${unitSymbol}. Position wins! Deactivating.`;
      addBotLog(task.marketSlug, msg, "success");
      logEvent(task.marketSlug, msg, "success");
      broadcast({ type: "bot_exit", marketSlug: task.marketSlug, reason: msg });
      deactivateBot(task.marketSlug);
      return;
    }
    if (peakTemp === task.targetTemp && latestTemp < task.targetTemp) {
      // Daily max locked at exactly target, temp now falling — sell
      addBotLog(task.marketSlug, `Peak locked at ${peakTemp.toFixed(1)}${unitSymbol} (= target) and falling to ${latestTemp.toFixed(1)}${unitSymbol}. Triggering sell...`, "warn");
      // Fall through to sell logic below
    } else if (peakTemp === task.targetTemp && latestTemp >= task.targetTemp) {
      addBotLog(task.marketSlug, `Peak ${peakTemp.toFixed(1)}${unitSymbol} at target. Latest ${latestTemp.toFixed(1)}${unitSymbol} still at/above — holding.`, "info");
      return;
    } else {
      // peak < target — no action yet
      return;
    }
  } else {
    // expectHigher = false: sell if peak reached or exceeded target
    if (peakTemp < task.targetTemp) return;
  }

  // --- Sell path ---
  const currentTemp = peakTemp;
  console.warn(`EMERGENCY EXIT for ${task.marketSlug}: Temp ${currentTemp}${unitSymbol} reached target ${task.targetTemp}${unitSymbol}`);
    
    try {
      // 1. Get current position size
      const positions = await getOpenPositions();
      addBotLog(task.marketSlug, `Checking exit condition. Found ${positions.positions.length} positions.`, "info");
      
      const pos = positions.positions.find(p => {
        const pSlug = (p.slug || "").toLowerCase();
        const tSlug = (task.marketSlug || "").toLowerCase();
        // Robust matching: either exact, or one contains the other
        return pSlug === tSlug || pSlug.startsWith(tSlug) || tSlug.startsWith(pSlug) || p.eventSlug === tSlug;
      });
      
      if (!pos) {
        // If we hit target but position is gone, it might have been sold manually or by another task
        addBotLog(task.marketSlug, `Target hit, but no active position found for ${task.marketSlug}. Deactivating...`, "info");
        deactivateBot(task.marketSlug);
        return;
      }

      if (typeof pos.size === "number" && pos.size > 0) {
        // Prevent concurrent exit attempts for the same task
        if ((task as any).isExiting) return;
        (task as any).isExiting = true;

        const sizeToSell = Math.floor(Number(pos.size) * 100) / 100;
        const tokenIdToSell = pos.asset || task.tokenId; // Use asset ID from position if available
        
        console.log(`Selling ${sizeToSell} shares of ${task.marketSlug} (${task.outcome}) | Token: ${tokenIdToSell}`);
        
        const warnMsg = `EMERGENCY! Temp ${currentTemp.toFixed(1)}${unitSymbol} >= Target ${task.targetTemp}${unitSymbol}. Selling ${sizeToSell} shares...`;
        addBotLog(task.marketSlug, warnMsg, "warn");
        logEvent(task.marketSlug, warnMsg, "warn");
        
        // 2. Cancel any open limit orders for this token first (frees locked shares)
        try {
          const cancelled = await cancelOpenOrdersForToken(tokenIdToSell);
          if (cancelled > 0) {
            addBotLog(task.marketSlug, `Cancelled ${cancelled} open order(s) to free shares`, "info");
          }
        } catch (cancelErr) {
          console.warn(`[BotManager] Could not cancel open orders:`, (cancelErr as Error).message);
        }

        // 3. Market (taker) sell — FAK fills immediately at best available bid
        // skipLimits=true: BOT_MAX_ORDER_USDC is a buy guard, not a sell guard
        const sellResult: any = await placeMarketOrder({
          tokenId: tokenIdToSell,
          side: "sell",
          amount: sizeToSell,
          tickSize: "0.01",
          orderType: "FAK",
          skipLimits: true,
        });
        
        console.log("Sell result:", sellResult);
        
        // IMPORTANT: Deactivate IMMEDIATELY after submission to prevent duplicate orders 
        // in the next poll cycle if the position hasn't updated yet.
        deactivateBot(task.marketSlug);

        const successMsg = `Emergency exit executed. Order: ${sellResult?.orderId || 'submitted'} | Size: ${sizeToSell} | Price: 0.01`;
        addBotLog(task.marketSlug, successMsg, "success");
        logEvent(task.marketSlug, successMsg, "success");
        
        broadcast({
          type: "bot_exit",
          marketSlug: task.marketSlug,
          reason: `Temp ${currentTemp.toFixed(1)}${unitSymbol} hit target ${task.targetTemp}${unitSymbol}. Emergency sell executed.`,
          result: sellResult
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`Failed emergency sell for ${task.marketSlug}:`, error);
      const errMsg = `SELL FAILED: ${msg}. Bot stays active — will retry next poll.`;
      // Log to Activity Log — visible in the UI
      addBotLog(task.marketSlug, errMsg, "error");
      // Also persist to global event log
      logEvent(task.marketSlug, errMsg, "error");
      // Broadcast to frontend (no alert — shown in Event Log)
      broadcast({
        type: "bot_error",
        marketSlug: task.marketSlug,
        reason: `Emergency sell failed: ${msg}`,
      });
      // Do NOT deactivate — let the bot retry on the next poll cycle
    }
}

function broadcast(msg: any) {
  if (!wss) return;
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}
