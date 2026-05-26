/**
 * Monitors open positions after a trigger buy:
 * - Sells immediately if YES bid >= 0.95
 * - Sells at best price if 10 minutes have elapsed since purchase
 */

import { PolymarketMarketWs } from './polymarket-market-ws.js';
import { getDb } from './db/client.js';

const CHECK_INTERVAL_MS = 15_000;

interface MonitoredPosition {
  triggerId: string;
  sessionId: string;
  tokenId: string;
  executedAt: Date;
  exitPrice: number;   // e.g. 0.99
  exitMinutes: number; // e.g. 10
}

// tokenId -> position
const positions = new Map<string, MonitoredPosition>();
// current best bid per token from WebSocket
const currentBids = new Map<string, number>();

let ws: PolymarketMarketWs | null = null;
let checkInterval: ReturnType<typeof setInterval> | null = null;

export async function startPositionMonitor(): Promise<void> {
  // Load existing unmonitored executed positions on startup
  const db = getDb();
  const result = await db.query(
    `SELECT id, session_id, token_id, executed_at, exit_price, exit_minutes
     FROM weather_triggers
     WHERE executed = TRUE AND closed = FALSE AND executed_at IS NOT NULL`
  );

  for (const row of result.rows) {
    positions.set(row.token_id, {
      triggerId: row.id,
      sessionId: row.session_id,
      tokenId: row.token_id,
      executedAt: new Date(row.executed_at),
      exitPrice: Number(row.exit_price),
      exitMinutes: Number(row.exit_minutes),
    });
  }

  if (positions.size > 0) {
    console.log(`[PosMon] Loaded ${positions.size} unmonitored position(s) from DB`);
  }

  rebuildWs();

  checkInterval = setInterval(() => void checkTimeouts(), CHECK_INTERVAL_MS);
  void checkTimeouts();
}

export function addPosition(position: MonitoredPosition): void {
  positions.set(position.tokenId, position);
  console.log(`[PosMon] Monitoring position for token ${position.tokenId}`);
  rebuildWs();
  // Check immediately in case it's already at/above take profit
  const bid = currentBids.get(position.tokenId) ?? 0;
  if (bid >= position.exitPrice) {
    void sellPosition(position, bid, 'take_profit');
  }
}

export function stopPositionMonitor(): void {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
  if (ws) {
    ws.setTrackedAssets([]);
    ws = null;
  }
}

function rebuildWs(): void {
  const tokenIds = Array.from(positions.keys());

  if (tokenIds.length === 0) {
    if (ws) {
      ws.setTrackedAssets([]);
      ws = null;
    }
    return;
  }

  if (!ws) {
    ws = new PolymarketMarketWs((event) => {
      if (event.kind !== 'book') return;

      const bid = event.bestBid ?? 0;
      currentBids.set(event.assetId, bid);

      const position = positions.get(event.assetId);
      if (!position) return;

      if (bid >= position.exitPrice) {
        console.log(`[PosMon] Take profit triggered: ${event.assetId} bid=${bid} >= ${position.exitPrice}`);
        void sellPosition(position, bid, 'take_profit');
      }
    });
  }

  ws.setTrackedAssets(tokenIds);
}

async function checkTimeouts(): Promise<void> {
  const now = Date.now();
  for (const [, position] of positions) {
    const ageMs = now - position.executedAt.getTime();
    if (ageMs >= position.exitMinutes * 60 * 1000) {
      const bid = currentBids.get(position.tokenId) ?? 0;
      console.log(
        `[PosMon] Timeout: ${position.tokenId} held ${Math.round(ageMs / 1000)}s, bid=${bid}`
      );
      void sellPosition(position, bid, 'timeout');
    }
  }
}

async function sellPosition(
  position: MonitoredPosition,
  currentBid: number,
  reason: 'take_profit' | 'timeout'
): Promise<void> {
  // Remove immediately to prevent double-sell
  positions.delete(position.tokenId);
  currentBids.delete(position.tokenId);
  rebuildWs();

  const db = getDb();

  try {
    // Get current share size from open positions
    const { getOpenPositions } = await import('./app.js');
    const openPositionsPayload = await getOpenPositions();
    const pos = openPositionsPayload.positions.find((p: any) => p.asset === position.tokenId);
    const size = pos?.size ?? 0;

    if (size <= 0) {
      console.warn(`[PosMon] No open position found for token ${position.tokenId}, skipping sell`);
      await db.query(`UPDATE weather_triggers SET closed = TRUE, closed_at = NOW() WHERE id = $1`, [position.triggerId]);
      return;
    }

    // Use limit order at current bid for immediate fill
    const sellPrice = reason === 'take_profit'
      ? position.exitPrice
      : Math.max(currentBid, 0.01);

    const { placeLimitOrder } = await import('./app.js');
    await placeLimitOrder({
      tokenId: position.tokenId,
      side: 'sell',
      price: sellPrice,
      size,
      tickSize: '0.01',
    });

    await db.query(
      `UPDATE weather_triggers SET closed = TRUE, closed_at = NOW() WHERE id = $1`,
      [position.triggerId]
    );

    console.log(
      `[PosMon] ✓ Sold position (${reason}): token ${position.tokenId}, size=${size}, price=${sellPrice}`
    );
  } catch (err) {
    console.error(`[PosMon] Failed to sell position ${position.triggerId}:`, (err as Error).message);
    // Re-add to monitoring if sell failed
    positions.set(position.tokenId, position);
    rebuildWs();
  }
}
