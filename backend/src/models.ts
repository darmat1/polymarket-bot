export interface OutcomeToken {
  label: string;
  tokenId: string;
}

export interface MarketSummary {
  marketId: string;
  slug: string;
  question: string;
  description: string;
  category: string;
  startDateIso: string | null;
  endDateIso: string | null;
  conditionId?: string | null;
  active: boolean;
  closed: boolean;
  liquidity?: number | null;
  volume?: number | null;
  outcomes: OutcomeToken[];
  raw: Record<string, unknown>;
}

export interface IMarket extends MarketSummary {
  conditionId: string | null;
  liquidity: number | null;
  volume: number | null;
}

export interface WeatherStation {
  key: string;
  label: string;
  station: string;
  latitude: number;
  longitude: number;
  unit: "F" | "C";
  timezone: string;
  aliases: string[];
}

export interface TemperatureBucket {
  kind: "at_or_below" | "exact" | "at_or_above";
  lowerInclusive: number | null;
  upperInclusive: number | null;
  label: string;
}

export interface ParsedWeatherMarket {
  cityKey: string;
  cityLabel: string;
  station: string;
  targetDate: string;
  unit: "F" | "C";
  bucket: TemperatureBucket;
}

export interface ForecastPoint {
  source: "ecmwf" | "gfs";
  targetDate: string;
  forecastHigh: number;
  unit: "F" | "C";
}

export interface HourlyForecastPoint {
  time: string;
  temp: number;
  unit: "F" | "C";
}

export interface WeatherProbabilityResult {
  probability: number;
  blendedForecastHigh: number;
  sigma: number;
  source: string;
  components: ForecastPoint[];
}

export interface SearchEventSummary {
  eventId: string;
  slug: string;
  title: string;
  description: string;
  active: boolean;
  closed: boolean;
  image: string;
  icon: string;
  tags: string[];
  markets: MarketSummary[];
  raw: Record<string, unknown>;
}

export class TopOfBook {
  constructor(
    public readonly bestBid: number | null,
    public readonly bestAsk: number | null,
  ) {}

  get midpoint(): number | null {
    if (this.bestBid === null || this.bestAsk === null) {
      return null;
    }
    return (this.bestBid + this.bestAsk) / 2;
  }

  get spreadBps(): number | null {
    const midpoint = this.midpoint;
    if (midpoint === null || midpoint === 0) {
      return null;
    }

    const { bestAsk, bestBid } = this;
    if (bestAsk === null || bestBid === null) {
      return null;
    }

    return ((bestAsk - bestBid) / midpoint) * 10_000;
  }
}

export interface TradeDecision {
  shouldTrade: boolean;
  side: "buy" | "sell";
  targetPrice: number;
  edgeBps: number;
  reason: string;
}

export type ScalperOrderSide = "buy" | "sell";

export type ScalperOrderStatus =
  | "pending"
  | "open"
  | "partial"
  | "filled"
  | "cancel_requested"
  | "cancelled"
  | "expired"
  | "failed";

export interface ScalperMarketSnapshot {
  marketId: string;
  slug: string;
  question: string;
  outcome: string;
  tokenId: string;
  conditionId: string | null;
  endDateIso: string | null;
  bestBid: number | null;
  bestAsk: number | null;
  lastTradePrice: number | null;
  availableLiquidity: number | null;
  minLiquidity: number;
  negRisk: boolean | null;
  active: boolean;
  closed: boolean;
  scannedAt: number;
  updatedAt: number;
}

export interface ScalperTrackedOrder {
  localId: string;
  orderId: string | null;
  marketId: string;
  marketSlug: string;
  tokenId: string;
  outcome: string;
  conditionId: string | null;
  side: ScalperOrderSide;
  status: ScalperOrderStatus;
  price: number;
  size: number;
  matchedSize: number;
  remainingSize: number | null;
  endDateIso: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  reservedBudget: number;
  reservationId: string | null;
  proceedsReceived: number;
  dryRun: boolean;
  errorMessage: string | null;
}

export interface ScalperMarketState {
  marketId: string;
  latestSnapshot: ScalperMarketSnapshot;
  openOrderIds: string[];
  completedOrderIds: string[];
  reservedBudget: number;
  lastScanAt: number;
  lastUserEventAt: number | null;
}

export interface ScalperBudgetState {
  totalBudget: number;
  reservedBudget: number;
  availableBudget: number;
  reservations: Record<
    string,
    {
      amount: number;
      marketId: string;
      tokenId: string;
      orderId?: string;
      reason?: string;
      createdAt: number;
    }
  >;
  updatedAt: number;
}

export interface ScalperPersistedState {
  version: 1;
  updatedAt: number;
  budget: ScalperBudgetState;
  markets: Record<string, ScalperMarketState>;
  orders: Record<string, ScalperTrackedOrder>;
}
