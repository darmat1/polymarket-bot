import type { OpenPositionsPayload } from "../app.js";
import type { Settings } from "../config.js";
import type { logEvent } from "../event-log.js";
import type { PolymarketService } from "../polymarket-service.js";
import type {
  ScalperUserWs,
  ScalperUserWsMessage,
} from "../scalper-user-ws.js";

export type Btc5mBotPhase =
  | "idle"
  | "looking_for_market"
  | "placing_buy"
  | "buy_open"
  | "placing_sell"
  | "sell_open"
  | "completed_waiting_next"
  | "error";

export interface Btc5mBotLogEntry {
  timestamp: number;
  message: string;
  type: "info" | "success" | "warn" | "error";
}

export interface Btc5mMarketView {
  marketId: string;
  slug: string;
  question: string;
  startDateIso: string | null;
  endDateIso: string | null;
  upTokenId: string;
  downTokenId: string | null;
}

export interface Btc5mMarketSelection {
  current: Btc5mMarketView | null;
  next: Btc5mMarketView | null;
}

export interface Btc5mBotStatus {
  active: boolean;
  phase: Btc5mBotPhase;
  dryRun: boolean;
  orderSize: number;
  buyPriceLimit: number;
  sellPriceLimit: number;
  currentMarket: Btc5mMarketView | null;
  nextMarket: Btc5mMarketView | null;
  buyOrderId: string | null;
  sellOrderId: string | null;
  lastCompletedMarketSlug: string | null;
  lastError: string | null;
  updatedAt: number;
  logs: Btc5mBotLogEntry[];
}

export interface Btc5mBotStartOptions {
  runImmediateTick?: boolean;
  scheduleLoop?: boolean;
}

export interface Btc5mBotRuntime {
  service?: Pick<PolymarketService, "initialize" | "placeLimitOrder" | "cancelOrder">;
  createUserWs?: (
    onMessage: (message: ScalperUserWsMessage) => void,
  ) => Pick<ScalperUserWs, "start" | "stop">;
  findMarketSelection?: () => Promise<Btc5mMarketSelection>;
  getOpenPositions?: () => Promise<OpenPositionsPayload>;
  logEvent?: typeof logEvent;
  now?: () => number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export interface Btc5mStatusConfig {
  dryRun: Settings["dryRun"];
  orderSize: Settings["btc5m"]["orderSize"];
  buyPriceLimit: Settings["btc5m"]["buyPriceLimit"];
  sellPriceLimit: Settings["btc5m"]["sellPriceLimit"];
}
