export type OutcomeToken = {
  label: string;
  tokenId: string;
};

export type MarketSummary = {
  marketId: string;
  slug: string;
  question: string;
  description: string;
  category: string;
  outcomes: OutcomeToken[];
  active?: boolean;
  closed?: boolean;
};

export type SearchEventSummary = {
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
};

export type EvaluationPayload = {
  market: string;
  slug: string;
  outcome: string;
  fair_probability: number;
  model_probability: number | null;
  fair_probability_source: "manual" | "weather-model";
  best_bid: number | null;
  best_ask: number | null;
  spread_bps: number | null;
  weather_analysis: {
    city: string;
    station: string;
    target_date: string;
    bucket: string;
    blended_forecast_high: number;
    sigma: number;
    sources: string[];
  } | null;
  decision: {
    should_trade: boolean;
    side: "buy" | "sell";
    target_price: number;
    edge_bps: number;
    reason: string;
  };
};

export type AccountSummaryPayload = {
  address: string | null;
  usdc_balance: string | null;
  available_to_trade: string | null;
  portfolio_value: string | null;
  dry_run: boolean;
  source: "polymarket-account";
};

export type PolymarketPositionRow = {
  asset?: string;
  conditionId?: string;
  title?: string;
  slug?: string;
  eventSlug?: string;
  outcome?: string;
  size?: number;
  avgPrice?: number;
  curPrice?: number;
  currentValue?: number;
  cashPnl?: number;
  percentPnl?: number;
  endDate?: string;
  redeemable?: boolean;
  icon?: string;
};

export type OpenPositionsPayload = {
  user: string | null;
  wallet_source: "funder" | "eoa" | null;
  positions: PolymarketPositionRow[];
};

export type UserWebSocketAuthPayload = {
  available: boolean;
  source: "env" | "unavailable";
  auth: {
    apiKey: string;
    secret: string;
    passphrase: string;
  } | null;
  key_preview: string | null;
  passphrase_preview: string | null;
  last_error: string | null;
};

export type BasicOkPayload = {
  ok: boolean;
};

export type MarketBotStatusPayload = {
  active: boolean;
  lastPollTime?: number;
  logs?: Array<{
    timestamp: number;
    message: string;
    type: "info" | "warn" | "error" | "success";
  }>;
};

export type ActivateMarketBotPayload = {
  marketSlug: string;
  stationCode: string | null;
  targetTemp: number | null;
  targetDate: string | null;
  tempUnit: "C" | "F";
  outcome?: string;
  tokenId?: string;
  expectHigher?: boolean;
  timezone?: string | null;
};

export type Btc5mBotPhase =
  | "idle"
  | "looking_for_market"
  | "placing_buy"
  | "buy_open"
  | "placing_sell"
  | "sell_open"
  | "completed_waiting_next"
  | "error";

export type Btc5mBotLogEntry = {
  timestamp: number;
  message: string;
  type: "info" | "success" | "warn" | "error";
};

export type Btc5mBotMarket = {
  marketId: string;
  slug: string;
  question: string;
  startDateIso: string | null;
  endDateIso: string | null;
  upTokenId: string;
  downTokenId: string | null;
};

export type Btc5mBotStatus = {
  active: boolean;
  phase: Btc5mBotPhase;
  dryRun: boolean;
  orderSize: number;
  buyPriceLimit: number;
  sellPriceLimit: number;
  currentMarket: Btc5mBotMarket | null;
  nextMarket: Btc5mBotMarket | null;
  buyOrderId: string | null;
  sellOrderId: string | null;
  lastCompletedMarketSlug: string | null;
  lastError: string | null;
  updatedAt: number;
  logs: Btc5mBotLogEntry[];
};

export type Btc15mStartConfig = {
  workingBudgetUsd: number;
  shares: number;
  buyPrice: number;
  trailStep: number;
  trailDist: number;
  trailUpdateIntervalSec: number;
  repeatThresholdMin: number;
  forceSellThresholdMin: number;
  neutralZoneUsd: number;
};

export type Btc15mCompletedTrade = {
  id: string;
  marketSlug: string;
  bettingSide: "up" | "down";
  buyPrice: number;
  sellPrice: number;
  shares: number;
  pnlUsd: number;
  /** LIVE-only: total USD paid on buy (avg fill × shares), excluding fees. */
  buyCostUsd?: number;
  /** LIVE-only: total USD received on sell (avg fill × shares), before fees. */
  sellProceedsUsd?: number;
  /** LIVE-only: total fees on buy side. */
  buyFeeUsd?: number;
  /** LIVE-only: total fees on sell side. */
  sellFeeUsd?: number;
  result: "win" | "loss";
  exitReason: "target_sell" | "force_sell" | "resolved_unfilled";
  startedAt?: number;
  closedAt: number;
  dryRun?: boolean;
};

export type Btc15mAnalyticsSummary = {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnlUsd: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  sessionStartBudgetUsd: number;
  remainingBudgetUsd: number;
};

export type Btc15mStatusPayload = {
  enginePhase: "stopped" | "running" | "auto_stopped";
  dryRun: boolean;
  config: Btc15mStartConfig & {
    tickIntervalSec: number;
  };
  market: {
    slug: string;
    question: string;
    startTimeMs: number;
    endTimeMs: number;
    upTokenId: string;
    downTokenId: string;
  } | null;
  marketStartBtcPrice: number | null;
  currentBtcPrice: number | null;
  cycle: {
    cyclePhase: string;
    buyOrder: {
      price: number;
      size: number;
      status: string;
      bettingSide: "up" | "down";
      orderId: string | null;
    } | null;
    sellOrder: {
      price: number;
      size: number;
      status: string;
      orderId: string | null;
    } | null;
    position: {
      bettingSide: "up" | "down";
      tokenId: string;
      shares: number;
      avgEntryPrice: number;
      costBasisUsd: number;
    } | null;
  };
  completedTrades: Array<{
    id: string;
    marketSlug: string;
    bettingSide: "up" | "down";
    buyPrice: number;
    sellPrice: number;
    shares: number;
    pnlUsd: number;
    result: "win" | "loss";
    exitReason: "target_sell" | "force_sell" | "resolved_unfilled";
    closedAt: number;
  }>;
  analytics: Btc15mAnalyticsSummary;
  upPrice: number | null;
  downPrice: number | null;
  sessionTrades: Btc15mCompletedTrade[];
  sessionAnalytics: Btc15mAnalyticsSummary;
  budget: {
    availableBudget: number;
    lockedBudget: number;
    initialBudget: number;
  } | null;
  logs: Array<{
    timestamp: number;
    message: string;
    type: "info" | "warn" | "error" | "success";
  }>;
  lastError: string | null;
  updatedAt: number;
};

export type Btc15mAutoStartConfig = {
  workingBudgetUsd: number;
  shares: number;
  minBuyPrice: number;
  maxBuyPrice: number;
  trailStep: number;
  trailDist: number;
  trailUpdateIntervalSec: number;
  repeatThresholdMin: number;
  forceSellThresholdMin: number;
  neutralZoneUsd: number;
};
export type Btc15mAutoCompletedTrade = Btc15mCompletedTrade;
export type Btc15mAutoAnalyticsSummary = Btc15mAnalyticsSummary;
export type Btc15mAutoCycle = Btc15mStatusPayload["cycle"] & {
  plannedBuyPrice?: number | null;
  buyBlockReason?: "low_range" | "high_wait_pullback" | null;
  buyBlockReferencePrice?: number | null;
  trailStopPrice?: number | null;
};
export type Btc15mAutoStatusPayload = Omit<Btc15mStatusPayload, "config" | "cycle"> & {
  config: Btc15mAutoStartConfig & {
    tickIntervalSec: number;
  };
  upCycle: Btc15mAutoCycle;
  downCycle: Btc15mAutoCycle;
};

export type EventLogEntry = {
  id: number;
  timestamp: number;
  marketSlug: string;
  type: "info" | "success" | "warn" | "error";
  trigger: "auto" | "manual";
  message: string;
};

export type WeatherForecastEntry = Record<string, unknown>;
export type HourlyForecastEntry = {
  time: string;
  temp: number;
  unit: "F" | "C";
};

export type StationHistoryEntry = {
  obsTime: number;
  temp: number;
  [key: string]: unknown;
};

export type SearchEventsPayload = {
  events?: SearchEventSummary[];
};

export type EventLogPayload = {
  entries?: EventLogEntry[];
};

export type ActiveBotSlugsPayload = {
  slugs?: string[];
};

export type ManualSellPayload = {
  message?: string;
  sizeToSell?: number;
  result?: {
    orderId?: string;
    id?: string;
    [key: string]: unknown;
  };
};

export type HourlyForecastPayload = {
  forecast?: HourlyForecastEntry[];
};

export type StationHistoryPayload = {
  history?: StationHistoryEntry[];
};

export type MarketDetailsExtractedData = {
  city: string | null;
  timezone: string | null;
  t: number | null;
  t_sys: string | null;
  day: string | null;
  station_code: string | null;
  url: string | null;
  res_source: string | null;
};

export type MarketDetailsPayload = {
  question: string;
  description: string;
  slug: string;
  extractedData?: MarketDetailsExtractedData | null;
  evaluation?: EvaluationPayload | null;
};
