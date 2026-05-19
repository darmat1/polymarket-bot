import { WebSocket } from "ws";

import { getRuntimeApiCreds } from "./runtime-auth.js";

const USER_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/user";
const PING_INTERVAL_MS = 10_000;
const RECONNECT_DELAY_MS = 3_000;

export interface ScalperUserWsMessage {
  eventType: string | null;
  status: string | null;
  type: string | null;
  side: string | null;
  orderId: string | null;
  assetIds: string[];
  raw: Record<string, unknown>;
}

export class ScalperUserWs {
  private ws: WebSocket | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly onMessage: (message: ScalperUserWsMessage) => void) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private async connect(): Promise<void> {
    const creds = await getRuntimeApiCreds();
    if (!creds || this.stopped) {
      return;
    }

    const ws = new WebSocket(USER_WS_URL);
    this.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "user", auth: creds }));
      this.pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send("PING");
        }
      }, PING_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      if (raw === "PONG") {
        return;
      }

      try {
        const parsed = JSON.parse(raw) as unknown;
        const entries = Array.isArray(parsed) ? parsed : [parsed];
        for (const entry of entries) {
          if (!entry || typeof entry !== "object") {
            continue;
          }
          const payload = entry as Record<string, unknown>;
          this.onMessage({
            eventType: typeof payload.event_type === "string" ? payload.event_type.toLowerCase() : null,
            status: typeof payload.status === "string" ? payload.status.toLowerCase() : null,
            type: typeof payload.type === "string" ? payload.type.toLowerCase() : null,
            side: typeof payload.side === "string" ? payload.side.toLowerCase() : null,
            orderId:
              typeof payload.id === "string"
                ? payload.id
                : typeof payload.order_id === "string"
                  ? payload.order_id
                  : null,
            assetIds: [payload.asset_id, payload.asset, payload.token_id, payload.tokenID].filter(
              (value): value is string => typeof value === "string" && value.length > 0,
            ),
            raw: payload,
          });
        }
      } catch {
        // Ignore malformed user messages.
      }
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onclose = () => {
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }
      this.ws = null;

      if (this.stopped) {
        return;
      }

      this.reconnectTimeout = setTimeout(() => {
        this.reconnectTimeout = null;
        void this.connect();
      }, RECONNECT_DELAY_MS);
    };
  }
}
