import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import {
  evaluateMarket,
  getAccountSummary,
  getOpenPositions,
  getRuntimeAuthDebug,
  scanMarkets,
  searchEvents,
  updateRuntimeAllowance,
  getMarketDetails,
  updateTokenAllowance,
} from "./app.js";
import {
  getRuntimeAuthState,
  initializeRuntimeApiCreds,
} from "./runtime-auth.js";
import { WebSocketServer } from "ws";
import { initBotManager, activateBot, deactivateBot, getBotStatus, getAllActiveBots, getCachedWeather, type BotTask } from "./bot-manager.js";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

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
        const cached = getCachedWeather(station);
        
        // Fetch fresh data from API
        const metarUrl = `https://aviationweather.gov/api/data/metar?ids=${station}&format=json&hours=168`;
        const metarRes = await fetch(metarUrl);
        let apiData = [];
        if (metarRes.ok) {
          apiData = await metarRes.json();
        }

        // Merge and deduplicate
        const merged = [...cached];
        for (const obs of apiData) {
          if (!merged.some(m => m.obsTime === obs.obsTime)) {
            merged.push(obs);
          }
        }
        // Sort by time descending
        merged.sort((a, b) => b.obsTime - a.obsTime);

        return json(res, 200, { history: merged });
      } catch (err: any) {
        return json(res, 500, { error: err.message });
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

    if (requestUrl.pathname === "/api/evaluate" && req.method === "POST") {
      const body = await readJsonBody(req);
      const fairProbabilityRaw = body.fairProbability;
      const fairProbability =
        typeof fairProbabilityRaw === "number"
          ? fairProbabilityRaw
          : typeof fairProbabilityRaw === "string" &&
              fairProbabilityRaw.trim() !== ""
            ? Number(fairProbabilityRaw)
            : undefined;
      const payload = await evaluateMarket({
        marketSlug: String(body.marketSlug ?? ""),
        outcome:
          typeof body.outcome === "string" && body.outcome !== ""
            ? body.outcome
            : undefined,
        fairProbability,
      });
      return json(res, 200, payload);
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
  await initializeRuntimeApiCreds();
  const authState = getRuntimeAuthState();

  const wss = new WebSocketServer({ server });
  initBotManager(wss);

  if (authState.credsSource === "derived") {
    console.log(
      "Derived runtime Polymarket L2 creds and cached them in memory.",
    );
  } else if (authState.credsSource === "env-fallback") {
    console.warn(
      `Runtime Polymarket L2 derive failed; using env credential fallback${authState.lastError ? `: ${authState.lastError}` : "."}`,
    );
  } else if (authState.signerAddress) {
    console.warn(
      `Runtime Polymarket L2 creds unavailable${authState.lastError ? `: ${authState.lastError}` : "."}`,
    );
  } else {
    console.log(
      "Skipping runtime Polymarket L2 creds derivation: no private key configured.",
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
