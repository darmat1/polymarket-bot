import { WebSocket, WebSocketServer } from "ws";

import { getBtcCandles, getCurrentBtc5mMarketSnapshot, type Btc5mMarketSnapshotPayload } from "./app.js";

const BTC5M_MONITOR_INTERVAL_MS = 15_000;

let wss: WebSocketServer | null = null;
let loopPromise: Promise<void> | null = null;
let latestSnapshot: Btc5mMarketSnapshotPayload | null = null;
let lastError: string | null = null;
const subscribers = new Set<WebSocket>();

export function initBtc5mMonitor(serverWss: WebSocketServer) {
  wss = serverWss;
  ensureLoop();
}

export function getLatestBtc5mSnapshot() {
  return latestSnapshot;
}

export function getBtc5mMonitorStatus() {
  return {
    active: loopPromise !== null,
    intervalMs: BTC5M_MONITOR_INTERVAL_MS,
    lastSnapshotAt: latestSnapshot?.prediction.generatedAt ?? null,
    marketSlug: latestSnapshot?.market.slug ?? null,
    lastError,
    subscribers: subscribers.size,
  };
}

async function ensureLoop() {
  if (loopPromise) {
    return loopPromise;
  }

  loopPromise = (async () => {
    while (true) {
      try {
        if (subscribers.size === 0) {
          lastError = null;
          await delay(BTC5M_MONITOR_INTERVAL_MS);
          continue;
        }

        const [snapshot, candles] = await Promise.all([
          getCurrentBtc5mMarketSnapshot({ includeAi: false }),
          getBtcCandles(60),
        ]);
        latestSnapshot = snapshot;
        lastError = null;
        broadcast({ type: "btc5m_snapshot", snapshot, candles });
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }

      await delay(BTC5M_MONITOR_INTERVAL_MS);
    }
  })();

  return loopPromise;
}

function broadcast(message: unknown) {
  if (!wss) {
    return;
  }

  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

export function bindBtc5mMonitorSubscriptions(serverWss: WebSocketServer) {
  serverWss.on("connection", (ws) => {
    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as { type?: string };
        if (message.type === "btc5m_subscribe") {
          subscribers.add(ws);
          return;
        }
        if (message.type === "btc5m_unsubscribe") {
          subscribers.delete(ws);
        }
      } catch {
        // Ignore non-JSON messages on the shared websocket.
      }
    });

    ws.on("close", () => {
      subscribers.delete(ws);
    });
  });
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
