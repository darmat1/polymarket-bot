import { useEffect, useState, useRef } from 'react';

export interface EnrichedMarket {
  market_slug: string;
  question: string;
  yes_price: number;
  no_price: number;
  yes_token_id: string;
  volume: number;
  liquidity: number;
  position?: {
    size: number;
    avg_price: number;
    current_value: number;
    cash_pnl: number;
    percent_pnl: number;
  };
}

interface WebSocketMessage {
  type: string;
  sessionId: string;
  market?: EnrichedMarket;
  error?: string;
}

const RECONNECT_DELAY = 2000;

export function useWeatherWebSocket(
  sessionId: string,
  slug: string
): {
  markets: EnrichedMarket[];
  isConnected: boolean;
  error: string | null;
} {
  const [markets, setMarkets] = useState<EnrichedMarket[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!sessionId || !slug) {
      return;
    }

    const connectWebSocket = () => {
      try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/weather/ws?sessionId=${sessionId}&slug=${slug}`;

        console.log('[WebSocket] Connecting to', wsUrl);
        const ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          console.log('[WebSocket] Connected for session', sessionId);
          setIsConnected(true);
          setError(null);
        };

        ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data) as WebSocketMessage;

            if (message.type === 'market_update' && message.market) {
              setMarkets((prev) => {
                const index = prev.findIndex(
                  (m) => m.market_slug === message.market!.market_slug
                );
                if (index >= 0) {
                  const updated = [...prev];
                  updated[index] = message.market!;
                  return updated;
                }
                return [...prev, message.market!];
              });
            } else if (message.type === 'error') {
              setError(message.error || 'WebSocket error');
            }
          } catch (err) {
            console.error('[WebSocket] Failed to parse message:', err);
          }
        };

        ws.onerror = (event) => {
          console.error('[WebSocket] Error:', event);
          setError('WebSocket connection error');
          setIsConnected(false);
        };

        ws.onclose = () => {
          console.log('[WebSocket] Disconnected');
          setIsConnected(false);

          // Attempt reconnect after delay
          reconnectTimeoutRef.current = setTimeout(() => {
            console.log('[WebSocket] Attempting to reconnect...');
            connectWebSocket();
          }, RECONNECT_DELAY);
        };

        wsRef.current = ws;
      } catch (err) {
        console.error('[WebSocket] Connection failed:', err);
        const message = err instanceof Error ? err.message : 'Connection failed';
        setError(message);

        // Retry after delay
        reconnectTimeoutRef.current = setTimeout(connectWebSocket, RECONNECT_DELAY);
      }
    };

    connectWebSocket();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [sessionId, slug]);

  return { markets, isConnected, error };
}
