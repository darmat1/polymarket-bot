import { WebSocket } from "ws";

interface RtdsMessage {
  topic?: unknown;
  type?: unknown;
  payload?: unknown;
}

interface PricePoint {
  timestamp: number;
  value: number;
}

const RTDS_URL = "wss://ws-live-data.polymarket.com";
const SYMBOL = "btc/usd";
const MAX_POINTS = 1_000;
const START_PRICE_TOLERANCE_MS = 15_000;
const CURRENT_PRICE_MAX_AGE_MS = 15_000;
const SNAPSHOT_WAIT_MS = 4_000;
const PING_INTERVAL_MS = 5_000;

export class PolymarketChainlinkBtcPriceSource {
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private readonly points: PricePoint[] = [];
  private waiters: Array<() => void> = [];

  async getPrice(atMs: number): Promise<number | null> {
    await this.ensureConnected();
    await this.waitForPriceData(SNAPSHOT_WAIT_MS);

    const now = Date.now();
    if (Math.abs(now - atMs) <= CURRENT_PRICE_MAX_AGE_MS) {
      return this.getLatestPrice(now);
    }

    return this.getNearestPrice(atMs, START_PRICE_TOLERANCE_MS);
  }

  close(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    const ws = this.ws;
    this.ws = null;
    this.connectPromise = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.close();
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(RTDS_URL);
      this.ws = ws;

      const timeout = setTimeout(() => {
        reject(new Error("Polymarket Chainlink RTDS connection timed out"));
        ws.close();
      }, 10_000);

      ws.onopen = () => {
        clearTimeout(timeout);
        ws.send(JSON.stringify({
          action: "subscribe",
          subscriptions: [{
            topic: "crypto_prices_chainlink",
            type: "*",
            filters: JSON.stringify({ symbol: SYMBOL }),
          }],
        }));
        this.startHeartbeat();
        resolve();
      };

      ws.onmessage = (event) => {
        const raw = typeof event.data === "string" ? event.data : String(event.data);
        if (!raw || raw === "PONG") {
          return;
        }
        try {
          this.handleMessage(JSON.parse(raw) as RtdsMessage);
        } catch {
          // Ignore malformed RTDS payloads.
        }
      };

      ws.onerror = () => {
        reject(new Error("Polymarket Chainlink RTDS websocket error"));
        ws.close();
      };

      ws.onclose = () => {
        this.stopHeartbeat();
        this.ws = null;
        this.connectPromise = null;
      };
    });

    return this.connectPromise;
  }

  private handleMessage(message: RtdsMessage): void {
    if (message.topic !== "crypto_prices_chainlink") {
      return;
    }

    const payload = message.payload;
    if (typeof payload !== "object" || payload === null) {
      return;
    }

    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.data)) {
      for (const item of record.data) {
        this.addPoint(item);
      }
      this.notifyWaiters();
      return;
    }

    this.addPoint(record);
    this.notifyWaiters();
  }

  private addPoint(input: unknown): void {
    if (typeof input !== "object" || input === null) {
      return;
    }
    const record = input as Record<string, unknown>;
    const symbol = typeof record.symbol === "string" ? record.symbol.toLowerCase() : SYMBOL;
    if (symbol !== SYMBOL) {
      return;
    }
    const timestamp = parseFiniteNumber(record.timestamp);
    const value = parseFiniteNumber(record.value);
    if (timestamp === null || value === null || value <= 0) {
      return;
    }

    this.points.push({ timestamp, value });
    this.points.sort((a, b) => a.timestamp - b.timestamp);
    if (this.points.length > MAX_POINTS) {
      this.points.splice(0, this.points.length - MAX_POINTS);
    }
  }

  private getLatestPrice(now: number): number | null {
    const latest = this.points.at(-1);
    if (!latest || now - latest.timestamp > CURRENT_PRICE_MAX_AGE_MS) {
      return null;
    }
    return latest.value;
  }

  private getNearestPrice(atMs: number, toleranceMs: number): number | null {
    let best: PricePoint | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const point of this.points) {
      const distance = Math.abs(point.timestamp - atMs);
      if (distance < bestDistance) {
        best = point;
        bestDistance = distance;
      }
    }
    return best && bestDistance <= toleranceMs ? best.value : null;
  }

  private async waitForPriceData(timeoutMs: number): Promise<void> {
    if (this.points.length > 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== done);
        resolve();
      }, timeoutMs);
      const done = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.waiters.push(done);
    });
  }

  private notifyWaiters(): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send("PING");
      }
    }, PING_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}

function parseFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}
