import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { getDb } from './db/client.js';
import { getPositionsCached } from './weather-position-cache.js';
import { getRuntimeAuthState } from './runtime-auth.js';

const GAMMA_API = 'https://gamma-api.polymarket.com';

interface ActiveSubscription {
  ws: WebSocket | null;
  slug: string;
  sessionId: string;
  emitter: EventEmitter;
  reconnectCount: number;
}

const activeSubscriptions = new Map<string, ActiveSubscription>();
const MAX_RECONNECT_ATTEMPTS = 5;

export async function subscribeToMarketPrices(
  sessionId: string,
  slug: string
): Promise<EventEmitter> {
  const key = `${slug}-${sessionId}`;

  // Check if already subscribed
  if (activeSubscriptions.has(key)) {
    const existing = activeSubscriptions.get(key)!;
    if (existing.ws && existing.ws.readyState === WebSocket.OPEN) {
      return existing.emitter;
    }
  }

  const emitter = new EventEmitter();

  // Fetch event to get market details
  let event: any;
  try {
    event = await fetchEventData(slug);
    if (!event || !event.markets) {
      throw new Error(`Event ${slug} not found or has no markets`);
    }
  } catch (error) {
    console.error(`[WS] Failed to fetch event ${slug}:`, error);
    emitter.emit('error', error);
    throw error;
  }

  const subscription: ActiveSubscription = {
    ws: null,
    slug,
    sessionId,
    emitter,
    reconnectCount: 0,
  };

  activeSubscriptions.set(key, subscription);

  // Start connection attempt
  await connectWebSocket(key, subscription, event);

  return emitter;
}

async function connectWebSocket(
  key: string,
  subscription: ActiveSubscription,
  event: any
): Promise<void> {
  try {
    const wsUrl = 'wss://ws-api-clob.polymarket.com/ws';
    const ws = new WebSocket(wsUrl);

    subscription.ws = ws;

    ws.on('open', () => {
      console.log(`[WS] Connected to Polymarket for session ${subscription.sessionId}`);

      // Subscribe to all markets in this event
      const marketIds = event.markets
        .map((m: any) => m.conditionId)
        .filter(Boolean);

      for (const marketId of marketIds) {
        ws.send(
          JSON.stringify({
            type: 'subscribe',
            market: marketId,
          })
        );
      }

      subscription.reconnectCount = 0;
    });

    ws.on('message', async (data: string) => {
      try {
        const message = JSON.parse(data);

        if (message.type === 'price') {
          // Filter by active triggers
          const db = getDb();
          const triggerResult = await db.query(
            `SELECT COUNT(*) as count FROM weather_triggers
             WHERE session_id = $1 AND token_id = $2 AND executed = FALSE`,
            [subscription.sessionId, message.tokenId]
          );

          const hasActiveTrigger = Number(triggerResult.rows[0]?.count ?? 0) > 0;

          if (hasActiveTrigger) {
            // Fetch positions
            const authState = getRuntimeAuthState();
            const user = authState.user;

            if (user) {
              const positions = await getPositionsCached(user);

              // Find matching position
              const position = positions.find(
                (p: any) =>
                  (p.slug === subscription.slug ||
                    p.eventSlug === subscription.slug) &&
                  (message.tokenId === p.asset || message.yes_token_id === p.asset)
              );

              // Enrich market data
              const enrichedData = {
                type: 'market_update',
                sessionId: subscription.sessionId,
                market: {
                  market_slug: subscription.slug,
                  question: message.question || '',
                  yes_price: message.yes_price || message.yesPrices?.[0] || 0,
                  no_price: message.no_price || message.noPrices?.[0] || 0,
                  yes_token_id: message.tokenId,
                  volume: message.volume || 0,
                  liquidity: message.liquidity || 0,
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

              subscription.emitter.emit('price_update', enrichedData);
            }
          }
        }
      } catch (error) {
        console.error(`[WS] Error parsing message:`, error);
      }
    });

    ws.on('error', (error) => {
      console.error(`[WS] Error in session ${subscription.sessionId}:`, error);
      subscription.emitter.emit('error', error);
    });

    ws.on('close', () => {
      console.log(`[WS] Disconnected from session ${subscription.sessionId}`);

      // Attempt reconnect
      if (subscription.reconnectCount < MAX_RECONNECT_ATTEMPTS) {
        subscription.reconnectCount++;
        const delay = 1000 * Math.pow(2, subscription.reconnectCount - 1);
        console.log(
          `[WS] Reconnecting in ${delay}ms... (attempt ${subscription.reconnectCount}/${MAX_RECONNECT_ATTEMPTS})`
        );

        setTimeout(async () => {
          try {
            await connectWebSocket(key, subscription, event);
          } catch (error) {
            console.error(`[WS] Reconnect failed:`, error);
            subscription.emitter.emit('reconnect_failed', error);
          }
        }, delay);
      } else {
        console.error(`[WS] Max reconnect attempts reached for session ${subscription.sessionId}`);
        subscription.emitter.emit('connection_failed');
        activeSubscriptions.delete(key);
      }
    });
  } catch (error) {
    console.error(`[WS] Connection error:`, error);
    subscription.emitter.emit('error', error);
    throw error;
  }
}

export async function unsubscribeFromMarketPrices(sessionId: string, slug: string): Promise<void> {
  const key = `${slug}-${sessionId}`;
  const subscription = activeSubscriptions.get(key);

  if (subscription && subscription.ws) {
    subscription.ws.close();
    subscription.ws = null;
  }

  activeSubscriptions.delete(key);
  console.log(`[WS] Unsubscribed from session ${sessionId}`);
}

async function fetchEventData(slug: string): Promise<any> {
  const response = await fetch(`${GAMMA_API}/events?slug=${encodeURIComponent(slug)}`, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Mozilla/5.0',
    },
  });

  if (!response.ok) {
    throw new Error(`Gamma API failed: ${response.status}`);
  }

  const data = (await response.json()) as Array<Record<string, unknown>>;
  return data[0] ?? null;
}

export function getActiveSubscriptions(): Array<{ sessionId: string; slug: string }> {
  return Array.from(activeSubscriptions.values()).map((s) => ({
    sessionId: s.sessionId,
    slug: s.slug,
  }));
}
