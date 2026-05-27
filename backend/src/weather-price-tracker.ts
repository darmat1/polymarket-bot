/**
 * Tracks real-time prices for trigger-related tokens via Polymarket WebSocket.
 * Only subscribes to YES tokens of active triggers + NO tokens of their
 * previous-temperature markets — keeps the subscription set minimal.
 *
 * Pushes { type: 'trigger_price_update', tokenId, bid, ask } to the frontend
 * via the existing weather WebSocket session channel.
 */

import { PolymarketMarketWs } from './polymarket-market-ws.js';
import { getDb } from './db/client.js';

// tokenId -> sessionId (which session cares about this token's price)
const tokenToSession = new Map<string, string>();

let ws: PolymarketMarketWs | null = null;

export function addTrackedTokens(sessionId: string, tokenIds: string[]): void {
  for (const t of tokenIds) {
    if (t) tokenToSession.set(t, sessionId);
  }
  rebuildWs();
}

export function removeTrackedTokensForSession(sessionId: string): void {
  for (const [token, sid] of tokenToSession) {
    if (sid === sessionId) tokenToSession.delete(token);
  }
  rebuildWs();
}

/** Called on server startup — loads all unexecuted triggers and their prev-NO tokens */
export async function initPriceTrackerFromDb(): Promise<void> {
  const db = getDb();
  const result = await db.query(
    `SELECT wt.token_id, wt.session_id, ws.event_data
     FROM weather_triggers wt
     JOIN weather_sessions ws ON ws.id = wt.session_id
     WHERE wt.executed = FALSE AND wt.closed = FALSE`
  );

  for (const row of result.rows) {
    const yesToken: string = row.token_id;
    const sessionId: string = row.session_id;
    const noToken = findNoTokenForYes(yesToken, row.event_data);
    const prevNoToken = findPrevNoToken(yesToken, row.event_data);
    addTrackedTokens(sessionId, [yesToken, noToken, prevNoToken].filter(Boolean) as string[]);
  }

  if (tokenToSession.size > 0) {
    console.log(`[PriceTracker] Tracking ${tokenToSession.size} token(s) from DB`);
  }
}

/** Given a YES token, find the NO token of that same market */
export function findNoTokenForYes(yesToken: string, eventData: any): string | null {
  const markets: any[] = eventData?.markets ?? [];
  const market = markets.find((m: any) =>
    m.clobTokenIds?.[0] === yesToken || m.yes_token_id === yesToken
  );
  return market?.clobTokenIds?.[1] ?? market?.no_token_id ?? null;
}

/** Given a YES token, find the NO token of the market one temperature below */
export function findPrevNoToken(yesToken: string, eventData: any): string | null {
  const markets: any[] = eventData?.markets ?? [];
  const sorted = markets
    .map((m: any) => ({
      ...m,
      parsedTemp: parseFloat(m.question?.match(/(\d+(?:\.\d+)?)\s*°/)?.[1] ?? 'NaN'),
    }))
    .filter((m: any) => !isNaN(m.parsedTemp))
    .sort((a: any, b: any) => a.parsedTemp - b.parsedTemp);

  const idx = sorted.findIndex(
    (m: any) =>
      m.clobTokenIds?.[0] === yesToken ||
      m.yes_token_id === yesToken
  );

  if (idx <= 0) return null;
  const prev = sorted[idx - 1];
  return prev.clobTokenIds?.[1] ?? prev.no_token_id ?? null;
}

function rebuildWs(): void {
  const tokenIds = Array.from(tokenToSession.keys());

  if (tokenIds.length === 0) {
    if (ws) {
      ws.setTrackedAssets([]);
      ws = null;
    }
    return;
  }

  if (!ws) {
    ws = new PolymarketMarketWs(async (event) => {
      if (event.kind !== 'book') return;

      const sessionId = tokenToSession.get(event.assetId);
      if (!sessionId) return;

      const { pushPriceUpdate } = await import('./weather-polymarket-ws.js');
      pushPriceUpdate(sessionId, event.assetId, event.bestBid ?? 0, event.bestAsk ?? 0);
    });
  }

  ws.setTrackedAssets(tokenIds);
}
