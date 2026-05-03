import { WebSocket, WebSocketServer } from "ws";
import { getOpenPositions, placeLimitOrder } from "./app.js";

export interface BotTask {
  marketSlug: string;
  stationCode: string;
  targetTemp: number;
  targetDate: string; // e.g. "May 3, 2026"
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
      addBotLog(marketSlug, `Temp check: ${latest.temp}°C`, "info");
      
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

      // Check exit condition
      await checkExitCondition(task, latest.temp);
    }
  } catch (error) {
    console.error(`Error polling task for ${marketSlug}:`, error);
  }
}

async function checkExitCondition(task: BotTask, currentTemp: number) {
  // Logic: if Outcome is "No", we bet it WON'T reach targetTemp.
  // If currentTemp >= targetTemp, we must SELL.
  const isEmergency = task.outcome === "No" && currentTemp >= task.targetTemp;
  
  if (isEmergency) {
    console.warn(`EMERGENCY EXIT for ${task.marketSlug}: Temp ${currentTemp} reached target ${task.targetTemp}`);
    
    try {
      // 1. Get current position size
      const positions = await getOpenPositions();
      const pos = positions.positions.find(p => p.slug === task.marketSlug && p.outcome === task.outcome);
      
      if (pos && typeof pos.size === "number" && pos.size > 0) {
        const sizeToSell = pos.size;
        console.log(`Selling ${sizeToSell} shares of ${task.marketSlug} (${task.outcome})`);
        
        addBotLog(task.marketSlug, `EMERGENCY! Temp ${currentTemp}°C >= Target ${task.targetTemp}°C. Selling position...`, "warn");
        
        // 2. Place sell order at a low price (e.g. 0.01) to exit immediately
        const sellResult: any = await placeLimitOrder({
          tokenId: task.tokenId,
          side: "sell",
          price: 0.01, // Market-like exit
          size: sizeToSell,
          tickSize: "0.01"
        });
        
        console.log("Sell result:", sellResult);
        addBotLog(task.marketSlug, `Emergency exit successful. Order: ${sellResult?.orderId || 'submitted'}`, "success");
        
        broadcast({
          type: "bot_exit",
          marketSlug: task.marketSlug,
          reason: `Temp ${currentTemp} hit target ${task.targetTemp}. Emergency sell executed.`,
          result: sellResult
        });
        
        // Deactivate task after exit
        deactivateBot(task.marketSlug);
      }
    } catch (error) {
      console.error(`Failed emergency sell for ${task.marketSlug}:`, error);
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
