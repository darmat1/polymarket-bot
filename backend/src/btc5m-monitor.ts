import { WebSocket, WebSocketServer } from "ws";

import { getCurrentBtc5mMarketSnapshot, type Btc5mMarketSnapshotPayload } from "./app.js";

const BTC5M_MONITOR_INTERVAL_MS = 15_000;

let wss: WebSocketServer | null = null;
let loopPromise: Promise<void> | null = null;
let latestSnapshot: Btc5mMarketSnapshotPayload | null = null;
let lastError: string | null = null;

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
  };
}

async function ensureLoop() {
  if (loopPromise) {
    return loopPromise;
  }

  loopPromise = (async () => {
    while (true) {
      try {
        const snapshot = await getCurrentBtc5mMarketSnapshot();
        latestSnapshot = snapshot;
        lastError = null;
        broadcast({ type: "btc5m_snapshot", snapshot });
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

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
