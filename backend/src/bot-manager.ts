import { WebSocket, WebSocketServer } from "ws";
import { getOpenPositions, placeLimitOrder } from "./app.js";
import { logEvent } from "./event-log.js";

export interface BotTask {
  marketSlug: string;
  stationCode: string;
  targetTemp: number;
  targetDate: string; // e.g. "May 3, 2026"
  tempUnit: "C" | "F";  // temperature unit the market uses
  outcome: string;    // "Yes" or "No"
  tokenId: string;
  active: boolean;
  lastPollTime?: number;
  logs: { timestamp: number; message: string; type: "info" | "warn" | "error" | "success" }[];
}

const activeTasks = new Map<string, BotTask>();
let wss: WebSocketServer | null = null;
let pollInterval: NodeJS.Timeout | null = null;

const weatherCache = new Map<string, any[]>();
const MAX_CACHE_SIZE = 100;

export function getCachedWeather(stationCode: string) {
  return weatherCache.get(stationCode) || [];
}

export function initBotManager(serverWss: WebSocketServer) {
  wss = serverWss;
  if (!pollInterval) {
    pollInterval = setInterval(pollActiveTasks, 5 * 60 * 1000); // 5 minutes
  }
}

export function activateBot(task: BotTask) {
  activeTasks.set(task.marketSlug, { 
    ...task, 
    active: true,
    logs: [{ timestamp: Date.now(), message: "Bot activated", type: "success" }]
  });
  console.log(`Bot activated for ${task.marketSlug}`);
  // Immediate poll for the newly activated task
  void pollSingleTask(task.marketSlug);
}

export function deactivateBot(marketSlug: string) {
  activeTasks.delete(marketSlug);
  console.log(`Bot deactivated for ${marketSlug}`);
}

export function getBotStatus(marketSlug: string) {
  return activeTasks.get(marketSlug) || { active: false };
}

export function getAllActiveBots() {
  return Array.from(activeTasks.keys());
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
}

async function pollSingleTask(marketSlug: string) {
  const task = activeTasks.get(marketSlug);
  if (!task || !task.active) return;

  task.lastPollTime = Date.now();
  addBotLog(marketSlug, "Polling weather data...", "info");
  
  broadcast({
    type: "bot_heartbeat",
    marketSlug: task.marketSlug,
    lastPollTime: task.lastPollTime
  });

  try {
    const url = `https://aviationweather.gov/api/data/metar?ids=${task.stationCode}&format=json&hours=6`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Weather API error: ${res.status}`);
    
    const data = await res.json();
    if (!data || data.length === 0) {
      addBotLog(marketSlug, "Weather API returned no data", "warn");
      return;
    }

    // Filter by target date (UTC comparison)
    // Simplify: instead of strict date match, just take the latest observation if it's within 24h
    const latestObs = data[0];
    const obsAgeMs = Date.now() - (latestObs.obsTime * 1000);
    const isRecent = obsAgeMs < 24 * 60 * 60 * 1000;

    addBotLog(marketSlug, `API returned ${data.length} items. Latest: ${new Date(latestObs.obsTime * 1000).toLocaleTimeString()}`, "info");

    if (isRecent) {
      const latest = latestObs;

      const tempC: number = typeof latest.temp === "number" ? latest.temp : parseFloat(latest.temp);
      const tempF = (tempC * 9 / 5) + 32;
      const tempInMarketUnit = task.tempUnit === "F" ? tempF : tempC;
      const unitSymbol = task.tempUnit === "F" ? "°F" : "°C";

      addBotLog(marketSlug, `Temp check: ${tempC.toFixed(1)}°C / ${tempF.toFixed(1)}°F`, "info");
      
      // Update cache
      const currentCache = weatherCache.get(task.stationCode) || [];
      const isNew = !currentCache.some(o => o.obsTime === latest.obsTime);
      if (isNew) {
        currentCache.unshift(latest);
        if (currentCache.length > MAX_CACHE_SIZE) currentCache.pop();
        weatherCache.set(task.stationCode, currentCache);
      }

      // Broadcast to clients
      broadcast({
        type: "weather_update",
        marketSlug,
        observation: latest
      });

      // Check exit condition using converted temperature
      await checkExitCondition(task, tempInMarketUnit);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Error polling task for ${marketSlug}:`, error);
    addBotLog(marketSlug, `Polling error: ${msg}`, "error");
  }
}

async function checkExitCondition(task: BotTask, currentTemp: number) {
  // currentTemp is already in the market's unit (C or F)
  // Logic: if Outcome is "No", we bet it WON'T reach targetTemp.
  // If currentTemp >= targetTemp, we must SELL.
  const isEmergency = task.outcome === "No" && currentTemp >= task.targetTemp;
  const unitSymbol = task.tempUnit === "F" ? "°F" : "°C";

  if (isEmergency) {
    console.warn(`EMERGENCY EXIT for ${task.marketSlug}: Temp ${currentTemp}${unitSymbol} reached target ${task.targetTemp}${unitSymbol}`);
    
    try {
      // 1. Get current position size
      const positions = await getOpenPositions();
      const pos = positions.positions.find(p => p.slug === task.marketSlug && p.outcome === task.outcome);
      
      if (pos && typeof pos.size === "number" && pos.size > 0) {
        const sizeToSell = Number(pos.size.toFixed(2));
        console.log(`Selling ${sizeToSell} shares of ${task.marketSlug} (${task.outcome})`);
        
        const warnMsg = `EMERGENCY! Temp ${currentTemp.toFixed(1)}${unitSymbol} >= Target ${task.targetTemp}${unitSymbol}. Selling ${sizeToSell} shares...`;
        addBotLog(task.marketSlug, warnMsg, "warn");
        logEvent(task.marketSlug, warnMsg, "warn");
        
        // 2. Place sell order at a low price (e.g. 0.01) to exit immediately
        const sellResult: any = await placeLimitOrder({
          tokenId: task.tokenId,
          side: "sell",
          price: 0.01, // Market-like exit
          size: sizeToSell,
          tickSize: "0.01",
          negRisk: true,
        });
        
        console.log("Sell result:", sellResult);
        const successMsg = `Emergency exit executed. Order: ${sellResult?.orderId || 'submitted'} | Size: ${sizeToSell} | Price: 0.01`;
        addBotLog(task.marketSlug, successMsg, "success");
        logEvent(task.marketSlug, successMsg, "success");
        
        broadcast({
          type: "bot_exit",
          marketSlug: task.marketSlug,
          reason: `Temp ${currentTemp.toFixed(1)}${unitSymbol} hit target ${task.targetTemp}${unitSymbol}. Emergency sell executed.`,
          result: sellResult
        });
        
        // Deactivate task after exit
        deactivateBot(task.marketSlug);
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
