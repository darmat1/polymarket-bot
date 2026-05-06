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
  expectHigher?: boolean;
  lastPollTime?: number;
  logs: { timestamp: number; message: string; type: "info" | "warn" | "error" | "success" }[];
}

const activeTasks = new Map<string, BotTask>();
let wss: WebSocketServer | null = null;
let pollInterval: NodeJS.Timeout | null = null;

const weatherCache = new Map<string, any[]>();
const MAX_CACHE_SIZE = 100;

const weatherLastFetched = new Map<string, number>();

export async function getOrFetchStationHistory(stationCode: string): Promise<any[]> {
  const now = Date.now();
  const lastFetched = weatherLastFetched.get(stationCode) || 0;
  let cached = weatherCache.get(stationCode) || [];

  // If fetched in the last 120 seconds and we have data, use cache to prevent API spam
  if (now - lastFetched < 120 * 1000 && cached.length > 0) {
    return cached;
  }

  try {
    const url = `https://aviationweather.gov/api/data/metar?ids=${stationCode}&format=json&hours=48`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data && data.length > 0) {
        weatherLastFetched.set(stationCode, now);
        
        // Merge and deduplicate
        const merged = [...cached];
        for (const obs of data) {
          if (!merged.some(m => m.obsTime === obs.obsTime)) {
            merged.push(obs);
          }
        }
        // Sort descending
        merged.sort((a, b) => b.obsTime - a.obsTime);
        if (merged.length > MAX_CACHE_SIZE) {
          merged.splice(MAX_CACHE_SIZE);
        }
        weatherCache.set(stationCode, merged);
        return merged;
      }
    }
  } catch (err) {
    console.error(`Failed to fetch unified weather for ${stationCode}:`, err);
  }
  
  return cached;
}

export function initBotManager(serverWss: WebSocketServer) {
  wss = serverWss;

  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "scanner_event") {
          // Broadcast to all clients
          const payload = JSON.stringify(msg);
          wss?.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(payload);
            }
          });
        }
      } catch (e) {
        // Not JSON or other error
      }
    });
  });

  if (!pollInterval) {
    pollInterval = setInterval(pollActiveTasks, 2 * 60 * 1000); // 2 minutes
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
    const data = await getOrFetchStationHistory(task.stationCode);
    
    if (!data || data.length === 0) {
      addBotLog(marketSlug, "Weather API returned no data", "warn");
      return;
    }

    addBotLog(marketSlug, `API returned ${data.length} items. Parsing for ${task.targetDate}...`, "info");

    // Filter by target date
    const targetDate = new Date(task.targetDate);
    const dayData = data.filter(obs => {
      const d = new Date(obs.obsTime * 1000);
      return d.getUTCDate() === targetDate.getUTCDate() &&
             d.getUTCMonth() === targetDate.getUTCMonth() &&
             d.getUTCFullYear() === targetDate.getUTCFullYear();
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
      const tempInMarketUnit = task.tempUnit === "F" ? tempF : tempC;
      
      addBotLog(marketSlug, `Peak for today: ${tempC.toFixed(1)}°C / ${tempF.toFixed(1)}°F (Latest: ${new Date(dayData[0].obsTime * 1000).toLocaleTimeString()})`, "info");

      // Broadcast to clients (use the peak observation for the UI)
      broadcast({
        type: "weather_update",
        marketSlug,
        observation: peakObs
      });

      // Check exit condition using the peak temperature
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
  // If currentTemp >= targetTemp, we must SELL, UNLESS expectHigher is true.
  // Simplify: if temp reaches target, we trigger the exit (sell).
  let isEmergency = currentTemp >= task.targetTemp;
  
  if (isEmergency && task.expectHigher) {
    // If 'Expect Higher' is ON, we don't sell yet.
    isEmergency = false; 
    addBotLog(task.marketSlug, `Temp ${currentTemp.toFixed(1)} hit target, but 'Hold through target' is ON. Holding...`, "info");
  }
  const unitSymbol = task.tempUnit === "F" ? "°F" : "°C";

  if (isEmergency) {
    console.warn(`EMERGENCY EXIT for ${task.marketSlug}: Temp ${currentTemp}${unitSymbol} reached target ${task.targetTemp}${unitSymbol}`);
    
    try {
      // 1. Get current position size
      const positions = await getOpenPositions();
      addBotLog(task.marketSlug, `Found ${positions.positions.length} total open positions. Looking for ${task.marketSlug} outcome ${task.outcome}...`, "info");
      
      const pos = positions.positions.find(p => {
        const slugMatch = p.slug === task.marketSlug;
        // Case-insensitive match for outcome
        const outcomeMatch = p.outcome?.toLowerCase() === task.outcome.toLowerCase();
        return slugMatch && outcomeMatch;
      });
      
      if (!pos) {
        addBotLog(task.marketSlug, `Could not find an active position for ${task.outcome}. (Available in API: ${positions.positions.map(p => `${p.slug}:${p.outcome}`).join(", ")})`, "warn");
        return;
      }

      if (typeof pos.size === "number" && pos.size > 0) {
        const sizeToSell = Number(pos.size.toFixed(2));
        const tokenIdToSell = pos.asset || task.tokenId; // Use asset ID from position if available
        
        console.log(`Selling ${sizeToSell} shares of ${task.marketSlug} (${task.outcome}) | Token: ${tokenIdToSell}`);
        
        const warnMsg = `EMERGENCY! Temp ${currentTemp.toFixed(1)}${unitSymbol} >= Target ${task.targetTemp}${unitSymbol}. Selling ${sizeToSell} shares...`;
        addBotLog(task.marketSlug, warnMsg, "warn");
        logEvent(task.marketSlug, warnMsg, "warn");
        
        // 2. Place sell order at a low price (e.g. 0.01) to exit immediately
        const sellResult: any = await placeLimitOrder({
          tokenId: tokenIdToSell,
          side: "sell",
          price: 0.01, // Market-like exit
          size: sizeToSell,
          tickSize: "0.01",
          negRisk: true,
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
