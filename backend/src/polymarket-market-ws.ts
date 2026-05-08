import { WebSocket } from "ws";

type MarketBookPayload = {
  asset_id?: unknown;
  best_bid?: unknown;
  best_ask?: unknown;
  bids?: Array<{ price?: unknown }>;
  asks?: Array<{ price?: unknown }>;
  timestamp?: unknown;
};

type PriceChangePayload = {
  asset_id?: unknown;
  best_bid?: unknown;
  best_ask?: unknown;
};

type MarketResolvedPayload = {
  winning_asset_id?: unknown;
  market?: unknown;
  timestamp?: unknown;
};

export type PolymarketMarketWsEvent =
  | {
      kind: "book";
      assetId: string;
      bestBid: number | null;
      bestAsk: number | null;
      timestamp: number;
    }
  | {
      kind: "resolved";
      winningAssetId: string | null;
      market: string | null;
      timestamp: number;
    };

const MARKET_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const PING_INTERVAL_MS = 10_000;
const RECONNECT_DELAY_MS = 3_000;

export class PolymarketMarketWs {
  private ws: WebSocket | null = null;
  private desiredAssetIds = new Set<string>();
  private subscribedAssetIds = new Set<string>();
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private shouldReconnect = false;

  constructor(private readonly onEvent: (event: PolymarketMarketWsEvent) => void) {}

  setTrackedAssets(assetIds: string[]) {
    const next = new Set(assetIds.filter((assetId) => assetId.trim() !== ""));
    this.desiredAssetIds = next;

    if (next.size === 0) {
      this.shouldReconnect = false;
      this.clearReconnectTimeout();
      this.closeSocket();
      return;
    }

    this.shouldReconnect = true;
    if (!this.ws) {
      this.connect();
      return;
    }

    if (this.ws.readyState === WebSocket.OPEN) {
      this.reconcileSubscriptions();
    }
  }

  private connect() {
    if (this.ws || this.desiredAssetIds.size === 0) {
      return;
    }

    const ws = new WebSocket(MARKET_WS_URL);
    this.ws = ws;

    ws.onopen = () => {
      this.clearReconnectTimeout();
      this.subscribedAssetIds.clear();
      this.startHeartbeat();
      this.reconcileSubscriptions();
    };

    ws.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      if (raw === "PONG") {
        return;
      }

      try {
        const parsed = JSON.parse(raw) as unknown;
        this.handleMessage(parsed);
      } catch {
        // Ignore malformed market websocket payloads.
      }
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onclose = () => {
      this.stopHeartbeat();
      this.ws = null;
      this.subscribedAssetIds.clear();

      if (!this.shouldReconnect || this.desiredAssetIds.size === 0 || this.reconnectTimeout) {
        return;
      }

      this.reconnectTimeout = setTimeout(() => {
        this.reconnectTimeout = null;
        this.connect();
      }, RECONNECT_DELAY_MS);
    };
  }

  private reconcileSubscriptions() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.desiredAssetIds.size === 0) {
      return;
    }

    if (this.subscribedAssetIds.size === 0) {
      this.ws.send(
        JSON.stringify({
          assets_ids: Array.from(this.desiredAssetIds),
          custom_feature_enabled: true,
          type: "market",
        }),
      );
      this.subscribedAssetIds = new Set(this.desiredAssetIds);
      return;
    }

    const toSubscribe = Array.from(this.desiredAssetIds).filter((assetId) => !this.subscribedAssetIds.has(assetId));
    const toUnsubscribe = Array.from(this.subscribedAssetIds).filter((assetId) => !this.desiredAssetIds.has(assetId));

    if (toUnsubscribe.length > 0) {
      this.ws.send(
        JSON.stringify({
          assets_ids: toUnsubscribe,
          operation: "unsubscribe",
        }),
      );
      for (const assetId of toUnsubscribe) {
        this.subscribedAssetIds.delete(assetId);
      }
    }

    if (toSubscribe.length > 0) {
      this.ws.send(
        JSON.stringify({
          assets_ids: toSubscribe,
          custom_feature_enabled: true,
          operation: "subscribe",
        }),
      );
      for (const assetId of toSubscribe) {
        this.subscribedAssetIds.add(assetId);
      }
    }
  }

  private handleMessage(message: unknown) {
    if (Array.isArray(message)) {
      for (const item of message) {
        this.handleMessage(item);
      }
      return;
    }

    if (typeof message !== "object" || message === null) {
      return;
    }

    const payload = message as Record<string, unknown>;
    const eventType = typeof payload.event_type === "string" ? payload.event_type : null;
    if (!eventType) {
      return;
    }

    if (eventType === "best_bid_ask" || eventType === "book") {
      this.emitBookUpdate(payload as MarketBookPayload);
      return;
    }

    if (eventType === "price_change") {
      const timestamp = toNumber(payload.timestamp) ?? Date.now();
      const changes = Array.isArray(payload.price_changes) ? payload.price_changes : [];
      for (const change of changes) {
        if (typeof change !== "object" || change === null) {
          continue;
        }
        this.emitBookUpdate(change as PriceChangePayload, timestamp);
      }
      return;
    }

    if (eventType === "market_resolved") {
      const resolved = payload as MarketResolvedPayload;
      this.onEvent({
        kind: "resolved",
        market: typeof resolved.market === "string" ? resolved.market : null,
        timestamp: toNumber(resolved.timestamp) ?? Date.now(),
        winningAssetId:
          typeof resolved.winning_asset_id === "string" ? resolved.winning_asset_id : null,
      });
    }
  }

  private emitBookUpdate(payload: MarketBookPayload | PriceChangePayload, fallbackTimestamp = Date.now()) {
    const assetId = typeof payload.asset_id === "string" ? payload.asset_id : null;
    if (!assetId) {
      return;
    }

    const bestBid =
      toNumber(payload.best_bid) ??
      ("bids" in payload && Array.isArray(payload.bids) ? toNumber(payload.bids[0]?.price) : null);
    const bestAsk =
      toNumber(payload.best_ask) ??
      ("asks" in payload && Array.isArray(payload.asks) ? toNumber(payload.asks[0]?.price) : null);

    this.onEvent({
      kind: "book",
      assetId,
      bestAsk,
      bestBid,
      timestamp: "timestamp" in payload ? toNumber(payload.timestamp) ?? fallbackTimestamp : fallbackTimestamp,
    });
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send("PING");
      }
    }, PING_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private clearReconnectTimeout() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  private closeSocket() {
    this.stopHeartbeat();
    const ws = this.ws;
    this.ws = null;
    this.subscribedAssetIds.clear();
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.close();
    }
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
