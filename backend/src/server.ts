import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import {
  getAccountSummary,
  getOpenPositions,
  getRuntimeAuthDebug,
  getUserWebSocketAuth,
  placeLimitOrder,
  scanMarkets,
  searchEvents,
  updateRuntimeAllowance,
  getMarketDetails,
  updateTokenAllowance,
  getHourlyForecast,
} from "./app.js";
import {
  getRuntimeAuthState,
  initializeRuntimeApiCreds,
  forceReloadApiCreds,
} from "./runtime-auth.js";
import { WebSocketServer, WebSocket } from "ws";
import { initBotManager, activateBot, deactivateBot, getBotStatus, getAllActiveBots, getOrFetchStationHistory, type BotTask } from "./bot-manager.js";
import { getEventLog, clearEventLog, logEvent } from "./event-log.js";
import { loadSettings } from "./config.js";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getBtc5mBotStatus,
  startBtc5mBot,
  stopBtc5mBot,
} from "./btc5m-bot.js";
import {
  getBtc15mBotStatus,
  startBtc15mBot,
  stopBtc15mBot,
  resetBtc15mBudget,
  type Btc15mBotConfig,
} from "./btc15m/index.js";
import {
  getBtc15mAutoBotStatus,
  startBtc15mAutoBot,
  stopBtc15mAutoBot,
  resetBtc15mAutoBudget,
  hardResetBtc15mAutoBot,
  type Btc15mAutoBotConfig,
} from "./btc15m-auto/index.js";
import {
  getBtc15mHedgeBotStatus,
  startBtc15mHedgeBot,
  stopBtc15mHedgeBot,
  type Btc15mHedgeBotConfig,
} from "./btc15m-hedge/simple-index.js";
import { checkMarketUrl } from "./btc15m-hedge/market-checker.js";
import {
  checkWeatherPolymarketTriggers,
  clearWeatherPolymarketTriggers,
  extractSlugFromUrl,
  getCurrentTemperature,
  getWeatherPolymarketEvent,
  listWeatherPolymarketTriggers,
  setWeatherPolymarketTrigger,
} from "./weather-polymarket.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FRONTEND_DIST = join(__dirname, "..", "..", "frontend", "dist");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const port = Number(process.env.PORT ?? "3001");
let appWss: WebSocketServer | null = null;
let btc15mBroadcastInterval: NodeJS.Timeout | null = null;
let btc15mAutoBroadcastInterval: NodeJS.Timeout | null = null;

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );

    if (req.method === "OPTIONS") {
      return json(res, 204, null);
    }

    if (requestUrl.pathname === "/api/markets" && req.method === "GET") {
      const limit = Number(requestUrl.searchParams.get("limit") ?? "200");
      const markets = await scanMarkets({ limit });
      return json(res, 200, { markets });
    }

    if (requestUrl.pathname === "/api/search-events" && req.method === "GET") {
      const limit = Number(requestUrl.searchParams.get("limit") ?? "50");
      const search = requestUrl.searchParams.get("search") ?? "";
      const events = await searchEvents({ limit, search });
      return json(res, 200, { events });
    }

    if (requestUrl.pathname === "/api/station-history" && req.method === "GET") {
      const station = requestUrl.searchParams.get("station");
      if (!station) {
        return json(res, 400, { error: "Missing station parameter" });
      }
      try {
        const history = await getOrFetchStationHistory(station);
        return json(res, 200, { history });
      } catch (err) {
        return json(res, 500, { error: err instanceof Error ? err.message : "Internal error" });
      }
    }

    if (requestUrl.pathname === "/api/hourly-forecast" && req.method === "GET") {
      const slug = requestUrl.searchParams.get("slug");
      console.log(`[API] GET /api/hourly-forecast slug=${slug}`);
      if (!slug) {
        return json(res, 400, { error: "Missing slug parameter" });
      }
      try {
        const forecast = await getHourlyForecast(slug);
        return json(res, 200, { forecast });
      } catch (err) {
        return json(res, 500, { error: err instanceof Error ? err.message : "Internal error" });
      }
    }

    if (requestUrl.pathname === "/api/weather-polymarket/event" && req.method === "POST") {
      const body = await readJsonBody(req) as { url?: string };
      const url = String(body.url ?? "").trim();
      const slug = extractSlugFromUrl(url);
      if (!slug) {
        return json(res, 400, { error: "Invalid Polymarket event URL" });
      }
      const event = await getWeatherPolymarketEvent(slug);
      if (!event) {
        return json(res, 404, { error: "Event not found" });
      }
      return json(res, 200, event);
    }

    if (requestUrl.pathname === "/api/weather-polymarket/weather" && req.method === "POST") {
      const body = await readJsonBody(req) as { icao?: string };
      const icao = String(body.icao ?? "").trim().toUpperCase();
      if (!icao) {
        return json(res, 400, { error: "ICAO required" });
      }
      const weather = await getCurrentTemperature(icao);
      if (!weather) {
        return json(res, 404, { error: "No weather data from available sources" });
      }
      return json(res, 200, weather);
    }

    if (requestUrl.pathname === "/api/weather-polymarket/triggers" && req.method === "POST") {
      const body = await readJsonBody(req) as {
        token_id?: string;
        temp_threshold?: number;
        amount?: number;
        icao?: string;
        slug?: string | null;
      };
      if (!body.token_id || body.temp_threshold === undefined || !body.icao) {
        return json(res, 400, { error: "token_id, temp_threshold, and icao are required" });
      }
      const trigger = setWeatherPolymarketTrigger({
        token_id: String(body.token_id),
        temp_threshold: Number(body.temp_threshold),
        amount: Number(body.amount ?? 1),
        icao: String(body.icao),
        slug: body.slug ? String(body.slug) : null,
      });
      return json(res, 200, {
        status: "ok",
        trigger,
        message: `Trigger set: buy YES on ${trigger.amount} USDC at >= ${trigger.temp}°C`,
      });
    }

    if (requestUrl.pathname === "/api/weather-polymarket/triggers" && req.method === "GET") {
      const icao = requestUrl.searchParams.get("icao")?.trim().toUpperCase();
      if (!icao) {
        return json(res, 400, { error: "icao is required" });
      }
      return json(res, 200, { triggers: listWeatherPolymarketTriggers(icao) });
    }

    if (requestUrl.pathname === "/api/weather-polymarket/triggers" && req.method === "DELETE") {
      const body = await readJsonBody(req) as { icao?: string; token_id?: string };
      const icao = String(body.icao ?? "").trim().toUpperCase();
      if (!icao) {
        return json(res, 400, { error: "icao is required" });
      }
      const removed = clearWeatherPolymarketTriggers(
        icao,
        body.token_id ? String(body.token_id) : undefined,
      );
      return json(res, 200, {
        status: "ok",
        removed,
        message: `Removed ${removed.length} trigger(s) for ${icao}`,
      });
    }

    if (requestUrl.pathname === "/api/weather-polymarket/check-triggers" && req.method === "POST") {
      const body = await readJsonBody(req) as { icao?: string; current_rounded?: number };
      const icao = String(body.icao ?? "").trim().toUpperCase();
      const currentRounded = Number(body.current_rounded);
      if (!icao || !Number.isFinite(currentRounded)) {
        return json(res, 400, { error: "icao and current_rounded are required" });
      }
      const result = await checkWeatherPolymarketTriggers(icao, currentRounded);
      return json(res, 200, result);
    }

    if (requestUrl.pathname === "/api/weather-polymarket/trading-status" && req.method === "GET") {
      const runtime = getRuntimeAuthState();
      return json(res, 200, { ready: runtime.credsLoaded === true });
    }

    if (
      requestUrl.pathname === "/api/account-summary" &&
      req.method === "GET"
    ) {
      const summary = await getAccountSummary();
      return json(res, 200, summary);
    }

    if (requestUrl.pathname === "/api/market-details" && req.method === "GET") {
      const slug = requestUrl.searchParams.get("slug");
      if (!slug) {
        return json(res, 400, { error: "Missing slug parameter" });
      }
      const details = await getMarketDetails(slug);
      return json(res, 200, details);
    }

    if (requestUrl.pathname === "/api/positions" && req.method === "GET") {
      const payload = await getOpenPositions();
      return json(res, 200, payload);
    }

    if (
      requestUrl.pathname === "/api/debug/runtime-auth" &&
      req.method === "GET"
    ) {
      const payload = await getRuntimeAuthDebug();
      return json(res, 200, payload);
    }

    if (
      requestUrl.pathname === "/api/user-ws-auth" &&
      req.method === "GET"
    ) {
      const payload = await getUserWebSocketAuth();
      return json(res, 200, payload);
    }

    if (
      requestUrl.pathname === "/api/update-allowance" &&
      req.method === "POST"
    ) {
      const payload = await updateRuntimeAllowance();
      return json(res, 200, payload);
    }

    if (
      requestUrl.pathname === "/api/update-token-allowance" &&
      req.method === "POST"
    ) {
      const payload = await updateTokenAllowance();
      return json(res, 200, payload);
    }

    if (requestUrl.pathname === "/api/reload-creds" && req.method === "POST") {
      try {
        const creds = await forceReloadApiCreds();
        const state = getRuntimeAuthState();
        return json(res, 200, {
          ok: true,
          credsSource: state.credsSource,
          keyPreview: state.keyPreview,
          lastError: state.lastError,
          loaded: creds !== null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json(res, 500, { ok: false, error: message });
      }
    }

    if (requestUrl.pathname === "/api/bot/status" && req.method === "GET") {
      const slug = requestUrl.searchParams.get("slug");
      if (!slug) return json(res, 400, { error: "Missing slug" });
      return json(res, 200, getBotStatus(slug));
    }

    if (requestUrl.pathname === "/api/bot/activate" && req.method === "POST") {
      const body = await readJsonBody(req) as any;
      activateBot(body as BotTask);
      return json(res, 200, { ok: true });
    }

    if (requestUrl.pathname === "/api/bot/deactivate" && req.method === "POST") {
      const body = await readJsonBody(req) as any;
      if (!body.marketSlug) return json(res, 400, { error: "Missing marketSlug" });
      deactivateBot(body.marketSlug);
      return json(res, 200, { ok: true });
    }

    if (requestUrl.pathname === "/api/bot/active-slugs" && req.method === "GET") {
      return json(res, 200, { slugs: getAllActiveBots() });
    }

    if (requestUrl.pathname === "/api/btc5m/status" && req.method === "GET") {
      const payload = await getBtc5mBotStatus(loadSettings());
      return json(res, 200, payload);
    }

    if (requestUrl.pathname === "/api/btc5m/start" && req.method === "POST") {
      const payload = await startBtc5mBot(loadSettings());
      return json(res, 200, payload);
    }

    if (requestUrl.pathname === "/api/btc5m/stop" && req.method === "POST") {
      const payload = stopBtc5mBot(loadSettings());
      return json(res, 200, payload);
    }

    if (requestUrl.pathname === "/api/btc15m/status" && req.method === "GET") {
      const payload = await getBtc15mBotStatus(loadSettings());
      return json(res, 200, payload);
    }

    if (requestUrl.pathname === "/api/btc15m/start" && req.method === "POST") {
      const body = await readJsonBody(req) as { config?: Partial<Btc15mBotConfig> };
      const payload = await startBtc15mBot(loadSettings(), { configOverrides: body.config });
      return json(res, 200, payload);
    }

    if (requestUrl.pathname === "/api/btc15m/stop" && req.method === "POST") {
      const payload = await stopBtc15mBot(loadSettings());
      return json(res, 200, payload);
    }

    if (requestUrl.pathname === "/api/btc15m/reset-budget" && req.method === "POST") {
      try {
        const payload = await resetBtc15mBudget(loadSettings());
        return json(res, 200, payload);
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (requestUrl.pathname === "/api/btc15m-auto/status" && req.method === "GET") {
      const payload = await getBtc15mAutoBotStatus(loadSettings());
      return json(res, 200, payload);
    }

    if (requestUrl.pathname === "/api/btc15m-auto/start" && req.method === "POST") {
      const body = await readJsonBody(req) as { config?: Partial<Btc15mAutoBotConfig> };
      const payload = await startBtc15mAutoBot(loadSettings(), { configOverrides: body.config });
      return json(res, 200, payload);
    }

    if (requestUrl.pathname === "/api/btc15m-auto/stop" && req.method === "POST") {
      const payload = await stopBtc15mAutoBot(loadSettings());
      return json(res, 200, payload);
    }

    if (requestUrl.pathname === "/api/btc15m-auto/reset-budget" && req.method === "POST") {
      try {
        const payload = await resetBtc15mAutoBudget(loadSettings());
        return json(res, 200, payload);
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (requestUrl.pathname === "/api/btc15m-auto/hard-reset" && req.method === "POST") {
      try {
        const payload = await hardResetBtc15mAutoBot(loadSettings());
        return json(res, 200, payload);
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (requestUrl.pathname === "/api/btc15m-hedge/status" && req.method === "GET") {
      const payload = await getBtc15mHedgeBotStatus(loadSettings());
      return json(res, 200, payload);
    }

    if (requestUrl.pathname === "/api/btc15m-hedge/start" && req.method === "POST") {
      const body = await readJsonBody(req) as { config?: Btc15mHedgeBotConfig };
      if (!body.config) {
        return json(res, 400, { error: "config is required" });
      }
      if (!body.config.marketUrl || !body.config.buyPrice || !body.config.shares) {
        return json(res, 400, { error: "marketUrl, buyPrice, and shares are required" });
      }

      // Pre-validate: reject expired markets with no replacement
      const settings = loadSettings();
      const marketCheck = await checkMarketUrl(body.config.marketUrl, settings.gammaHost);
      if (marketCheck.isExpired && !marketCheck.currentMarket) {
        return json(res, 400, {
          error: `Market "${marketCheck.slug}" is expired and no active replacement was found. Please use a link to a currently active market.`,
        });
      }

      const payload = await startBtc15mHedgeBot(settings, { config: body.config });
      return json(res, 200, payload);
    }

    if (requestUrl.pathname === "/api/btc15m-hedge/stop" && req.method === "POST") {
      const payload = await stopBtc15mHedgeBot(loadSettings());
      return json(res, 200, payload);
    }

    if (requestUrl.pathname === "/api/btc15m-hedge/check-market" && req.method === "POST") {
      const body = await readJsonBody(req) as { marketUrl?: string };
      if (!body.marketUrl) {
        return json(res, 400, { error: "marketUrl is required" });
      }
      const settings = loadSettings();
      
      // Create temporary WebSocket for price fetching
      const { PolymarketMarketWs } = await import("./polymarket-market-ws.js");
      const tempWs = new PolymarketMarketWs(() => {});
      
      try {
        const result = await checkMarketUrl(body.marketUrl, settings.gammaHost, tempWs);
        return json(res, 200, result);
      } finally {
        // Clean up WebSocket connection
        tempWs.setTrackedAssets([]);
      }
    }

    if (requestUrl.pathname === "/api/event-log" && req.method === "GET") {
      const limit = Number(requestUrl.searchParams.get("limit") ?? "100");
      return json(res, 200, { entries: getEventLog(limit) });
    }

    if (requestUrl.pathname === "/api/event-log" && req.method === "DELETE") {
      clearEventLog();
      return json(res, 200, { ok: true });
    }

    if (requestUrl.pathname === "/api/bot/manual-sell" && req.method === "POST") {
      const body = await readJsonBody(req) as any;
      const { marketSlug, tokenId } = body;
      if (!marketSlug || !tokenId) {
        return json(res, 400, { error: "Missing marketSlug or tokenId" });
      }
      try {
        // Get position size from Polymarket
        const posPayload = await getOpenPositions();
        const pos = posPayload.positions.find(
          (p) => p.slug === marketSlug && p.asset === tokenId,
        );
        if (!pos || typeof pos.size !== "number" || pos.size <= 0) {
          return json(res, 400, { error: "No open position found for this token" });
        }
        const sizeToSell = Math.floor(pos.size * 100) / 100;

        const result = await placeLimitOrder({
          tokenId,
          side: "sell",
          price: 0.01,
          size: sizeToSell,
          tickSize: "0.01",
          negRisk: true,
        });

        const msg = `Manual sell: ${sizeToSell.toFixed(2)} shares @ 0.01 | Order: ${(result as any)?.orderId ?? "submitted"}`;
        logEvent(marketSlug, msg, "success", "manual");

        return json(res, 200, { ok: true, result, sizeToSell, message: msg });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logEvent(marketSlug, `Manual sell FAILED: ${msg}`, "error", "manual");
        return json(res, 500, { error: msg });
      }
    }

    // Weather session endpoints
    if (requestUrl.pathname === "/api/weather/session" && req.method === "POST") {
      try {
        const { event_url } = (await readJsonBody(req)) as { event_url?: string };
        if (!event_url || typeof event_url !== "string") {
          return json(res, 400, { error: "event_url is required" });
        }
        const { createWeatherSession } = await import("./weather-sessions.js");
        const session = await createWeatherSession(event_url);
        return json(res, 200, session);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error("[Weather] Create session error:", error);
        return json(res, 400, { error: message });
      }
    }

    if (requestUrl.pathname === "/api/weather/sessions" && req.method === "GET") {
      try {
        const { getWeatherSessions } = await import("./weather-sessions.js");
        const sessions = await getWeatherSessions();
        return json(res, 200, { sessions });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error("[Weather] List sessions error:", error);
        return json(res, 500, { error: message });
      }
    }

    if (requestUrl.pathname.startsWith("/api/weather/session/") && req.method === "DELETE") {
      try {
        const sessionId = requestUrl.pathname.split("/").pop();
        if (!sessionId) {
          return json(res, 400, { error: "sessionId is required" });
        }
        const { deleteWeatherSession } = await import("./weather-sessions.js");
        await deleteWeatherSession(sessionId);
        return json(res, 200, { success: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error("[Weather] Delete session error:", error);
        return json(res, 500, { error: message });
      }
    }

    // Static file serving from frontend/dist
    const isGet = req.method === "GET" || req.method === "HEAD";
    if (isGet && !requestUrl.pathname.startsWith("/api")) {
      let filePath = join(FRONTEND_DIST, requestUrl.pathname);
      if (requestUrl.pathname === "/") {
        filePath = join(FRONTEND_DIST, "index.html");
      }

      try {
        const content = await readFile(filePath);
        const ext = extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": contentType });
        return res.end(content);
      } catch (e) {
        // Fallback to index.html for SPA routing if file not found
        try {
          const indexContent = await readFile(join(FRONTEND_DIST, "index.html"));
          res.writeHead(200, { "Content-Type": "text/html" });
          return res.end(indexContent);
        } catch (innerE) {
          // Both file and index.html missing
        }
      }
    }

    json(res, 404, { error: "Not found" });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown server error";
    json(res, 500, { error: message });
  }
});

async function start(): Promise<void> {
  const settings = loadSettings();

  // Initialize database
  const { initDbPool, closeDb } = await import("./db/client.js");
  const { runMigrations } = await import("./db/migrate.js");
  try {
    initDbPool();
    console.log("[DB] Pool initialized");
    await runMigrations();
    console.log("[DB] Migrations completed");
  } catch (error) {
    console.error("[DB] Initialization failed:", error);
    process.exit(1);
  }

  // Start background temperature polling + trigger execution (browser-independent)
  const { startWeatherBackgroundService, stopWeatherBackgroundService } = await import("./weather-background.js");
  startWeatherBackgroundService();

  // Clean up on shutdown
  process.on("SIGINT", async () => {
    console.log("[Server] Shutting down...");
    stopWeatherBackgroundService();
    await closeDb();
    process.exit(0);
  });

  await initializeRuntimeApiCreds();
  const authState = getRuntimeAuthState();

  const wss = new WebSocketServer({ server });
  appWss = wss;

  // Weather market price WebSocket handler
  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url || '', 'ws://localhost');
    const sessionId = url.searchParams.get('sessionId');
    const slug = url.searchParams.get('slug');

    // Check if this is a weather WebSocket connection
    if (!url.pathname.includes('/weather') && (!sessionId || !slug)) {
      return; // Not a weather WS, let other handlers deal with it
    }

    if (!sessionId || !slug) {
      ws.close(1008, 'Missing sessionId or slug');
      return;
    }

    console.log(`[WS] Weather client connected for session ${sessionId}`);

    try {
      const { subscribeToMarketPrices, unsubscribeFromMarketPrices } = await import(
        './weather-polymarket-ws.js'
      );
      const { getSessionTriggers } = await import('./weather-sessions.js');

      await getSessionTriggers(sessionId); // Verify session exists

      const emitter = await subscribeToMarketPrices(sessionId, slug);

      const onPriceUpdate = (data: any) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(data));
        }
      };

      const onError = (error: any) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'error', message: (error as Error).message }));
        }
      };

      emitter.on('price_update', onPriceUpdate);
      emitter.on('error', onError);

      ws.on('close', () => {
        console.log(`[WS] Weather client disconnected for session ${sessionId}`);
        emitter.off('price_update', onPriceUpdate);
        emitter.off('error', onError);
        unsubscribeFromMarketPrices(sessionId, slug).catch(console.error);
      });

      ws.on('error', (error) => {
        console.error(`[WS] Client error:`, error);
      });
    } catch (error) {
      console.error(`[WS] Connection error:`, error);
      ws.close(1011, (error as Error).message);
    }
  });

  initBotManager(wss);
  startBtc15mBroadcastLoop();
  startBtc15mAutoBroadcastLoop();

  if (settings.enableScalper) {
    console.log("Scalper runtime enabled.");
  }

  if (authState.credsSource === "env") {
    console.log("Loaded runtime Polymarket L2 creds from env.");
  } else {
    console.warn(
      `Runtime Polymarket L2 creds unavailable${authState.lastError ? `: ${authState.lastError}` : "."}`,
    );
  }

  server.once("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[EADDRINUSE] Port ${port} is already in use. Stop the other server (Ctrl+C) or find PID: lsof -i :${port}. Or use a free port: PORT=3002 pnpm run serve`,
      );
    } else {
      console.error("HTTP server failed to start:", err);
    }
    process.exit(1);
  });

  server.listen(port, () => {
    console.log(`Polymarket API listening on http://localhost:${port}`);
  });
}

void start();

async function readJsonBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<
    string,
    unknown
  >;
}

function json(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function broadcast(payload: unknown): void {
  if (!appWss) {
    return;
  }
  const message = JSON.stringify(payload);
  for (const client of appWss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

function startBtc15mBroadcastLoop(): void {
  if (btc15mBroadcastInterval) {
    return;
  }
  btc15mBroadcastInterval = setInterval(() => {
    void publishBtc15mStatus();
  }, 500);
}

function startBtc15mAutoBroadcastLoop(): void {
  if (btc15mAutoBroadcastInterval) {
    return;
  }
  btc15mAutoBroadcastInterval = setInterval(() => {
    void publishBtc15mAutoStatus();
  }, 500);
}

async function publishBtc15mStatus(): Promise<void> {
  try {
    const payload = await getBtc15mBotStatus(loadSettings());
    if (!payload.market) {
      return;
    }
    broadcast({ type: "btc15m_status", payload });
  } catch {
  }
}

async function publishBtc15mAutoStatus(): Promise<void> {
  try {
    const payload = await getBtc15mAutoBotStatus(loadSettings());
    if (!payload.market) {
      return;
    }
    broadcast({ type: "btc15m_auto_status", payload });
  } catch {
  }
}
