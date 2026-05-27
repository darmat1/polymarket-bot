import { EventEmitter } from 'events';
import { PolymarketMarketWs } from './polymarket-market-ws.js';
import { getDb } from './db/client.js';
import { getPositionsCached } from './weather-position-cache.js';

interface ActiveSubscription {
  ws: PolymarketMarketWs;
  slug: string;
  sessionId: string;
  emitter: EventEmitter;
  tokenIds: string[];
  icao: string | null;
}

// Map of key -> active subscription
const activeSubscriptions = new Map<string, ActiveSubscription>();

export async function subscribeToMarketPrices(
  sessionId: string,
  slug: string
): Promise<EventEmitter> {
  const key = `${slug}-${sessionId}`;

  if (activeSubscriptions.has(key)) {
    return activeSubscriptions.get(key)!.emitter;
  }

  const emitter = new EventEmitter();

  // Load token IDs and ICAO — from DB if available, otherwise fetch fresh
  const db = getDb();
  const sessionResult = await db.query(
    `SELECT event_data, icao FROM weather_sessions WHERE id = $1`,
    [sessionId]
  );

  let markets: any[] = sessionResult.rows[0]?.event_data?.markets ?? [];
  let icao: string | null = sessionResult.rows[0]?.icao ?? null;

  if (markets.length === 0) {
    console.log(`[WS] No cached event_data for session ${sessionId}, fetching fresh from Gamma API`);
    try {
      const { getWeatherPolymarketEvent } = await import('./weather-polymarket.js');
      const event = await getWeatherPolymarketEvent(slug);
      markets = event?.markets ?? [];

      // Cache it in DB
      if (event) {
        icao = event.airport?.icao ?? null;
        const { extractCityName } = await import('./weather-sessions.js');
        const city = extractCityName(event.title, event.airport?.name, icao, slug);
        await db.query(
          `UPDATE weather_sessions SET city = $1, icao = $2, event_data = $3, updated_at = NOW() WHERE id = $4`,
          [city, icao, JSON.stringify(event), sessionId]
        );
      }
    } catch (err) {
      console.warn(`[WS] Failed to fetch event data for ${slug}:`, (err as Error).message);
    }
  }

  // Collect all YES token IDs from the event markets
  const tokenIds: string[] = markets
    .map((m: any) => m.yes_token_id)
    .filter(Boolean);

  if (tokenIds.length === 0) {
    console.warn(`[WS] No token IDs found for session ${sessionId}, slug ${slug}`);
  }

  console.log(`[WS] Subscribing to ${tokenIds.length} markets for session ${sessionId}, icao=${icao}`);

  // Use existing PolymarketMarketWs class (correct URL + format)
  const ws = new PolymarketMarketWs(async (event) => {
    if (event.kind !== 'book') return;

    const { assetId, bestAsk, bestBid } = event;

    // Only process if this token has an active trigger
    const triggerResult = await db.query(
      `SELECT COUNT(*) as count FROM weather_triggers
       WHERE session_id = $1 AND token_id = $2 AND executed = FALSE`,
      [sessionId, assetId]
    );
    const hasActiveTrigger = Number(triggerResult.rows[0]?.count ?? 0) > 0;
    if (!hasActiveTrigger) return;

    // Find the market question for this token
    const market = markets.find((m: any) => m.yes_token_id === assetId);

    // Fetch positions (cached, 3s TTL)
    const positions = await getPositionsCached();
    const position = positions.find(
      (p: any) =>
        p.slug === slug ||
        p.eventSlug === slug
    );

    const yesPrice = bestAsk ?? 0;
    const noPrice = bestBid != null ? 1 - bestBid : 0;

    const enrichedData = {
      type: 'market_update',
      sessionId,
      market: {
        market_slug: slug,
        question: market?.question ?? '',
        yes_price: yesPrice,
        no_price: noPrice,
        yes_token_id: assetId,
        volume: market?.volume ?? 0,
        liquidity: market?.liquidity ?? 0,
        position: position
          ? {
              size: position.size,
              avg_price: position.avgPrice,
              current_value: position.currentValue,
              cash_pnl: position.cashPnl,
              percent_pnl: position.percentPnl,
            }
          : undefined,
      },
    };

    emitter.emit('price_update', enrichedData);
  });

  // Start listening to the token IDs
  ws.setTrackedAssets(tokenIds);

  activeSubscriptions.set(key, { ws, slug, sessionId, emitter, tokenIds, icao });

  return emitter;
}

export async function unsubscribeFromMarketPrices(sessionId: string, slug: string): Promise<void> {
  const key = `${slug}-${sessionId}`;
  const subscription = activeSubscriptions.get(key);

  if (subscription) {
    subscription.ws.setTrackedAssets([]); // closes the WS
    activeSubscriptions.delete(key);
    console.log(`[WS] Unsubscribed from session ${sessionId}`);
  }
}

export function pushTemperatureUpdate(sessionId: string, weather: unknown): void {
  for (const sub of activeSubscriptions.values()) {
    if (sub.sessionId === sessionId) {
      sub.emitter.emit('temperature_update', { type: 'temperature_update', sessionId, weather });
      break;
    }
  }
}

export function pushPriceUpdate(sessionId: string, tokenId: string, bid: number, ask: number): void {
  for (const sub of activeSubscriptions.values()) {
    if (sub.sessionId === sessionId) {
      sub.emitter.emit('price_update', {
        type: 'trigger_price_update',
        sessionId,
        tokenId,
        bid,
        ask,
      });
      break;
    }
  }
}

export function getActiveSubscriptions(): Array<{ sessionId: string; slug: string }> {
  return Array.from(activeSubscriptions.values()).map((s) => ({
    sessionId: s.sessionId,
    slug: s.slug,
  }));
}
