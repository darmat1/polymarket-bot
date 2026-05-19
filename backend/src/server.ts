import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import {
  getAccountSummary,
  getOpenPositions,
  getRuntimeAuthDebug,
  getScalperOpenOrders,
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
import { WebSocketServer } from "ws";
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
  getScalperStatus,
  reconcileScalperState,
  startScalperStrategy,
  stopScalperStrategy,
} from "./scalper/scalper-strategy.js";

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

    if (requestUrl.pathname === "/api/scalper/status" && req.method === "GET") {
      await reconcileScalperState(loadSettings());
      return json(res, 200, getScalperStatus());
    }

    if (requestUrl.pathname === "/api/scalper/open-orders" && req.method === "GET") {
      await reconcileScalperState(loadSettings());
      const payload = await getScalperOpenOrders();
      return json(res, 200, payload);
    }

    if (requestUrl.pathname === "/api/scalper/start" && req.method === "POST") {
      const settings = loadSettings();
      await startScalperStrategy(settings);
      return json(res, 200, { ok: true, active: true });
    }

    if (requestUrl.pathname === "/api/scalper/stop" && req.method === "POST") {
      stopScalperStrategy();
      await reconcileScalperState(loadSettings());
      return json(res, 200, { ok: true, active: false });
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
  await initializeRuntimeApiCreds();
  const authState = getRuntimeAuthState();

  const wss = new WebSocketServer({ server });
  initBotManager(wss);

  if (settings.enableScalper) {
    await startScalperStrategy(settings);
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
  res.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(payload === null ? "" : JSON.stringify(payload));
}
