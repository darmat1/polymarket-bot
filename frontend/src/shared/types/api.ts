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
  exitReason: "target_sell" | "force_sell" | "resolved_unfilled" | "polymarket_history";
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
  buyAmountUsd: number;
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

export type WeatherPolymarketWeather = {
  temperature_c: number;
  rounded_c: number;
  temperature_native?: number;
  rounded_native?: number;
  unit?: "F" | "C";
  daily_max_native?: number | null;
};

export type WeatherPolymarketMarket = {
  slug: string;
  question: string;
  yes_price: number;
  no_price: number;
  volume: number;
  liquidity: number;
  active: boolean;
  yes_token_id: string | null;
  no_token_id: string | null;
};

export type WeatherPolymarketTrigger = {
  id?: string;
  token_id: string;
  temp: number;
  amount: number;
  executed: boolean;
  executed_at?: string | null;
  exit_price?: number;
  exit_minutes?: number;
  buy_prev_no?: boolean;
  slug: string | null;
  icao: string;
};

export type WeatherPolymarketEventPayload = {
  title: string;
  slug: string;
  end_date: string;
  description: string;
  total_volume: number;
  liquidity: number;
  markets: WeatherPolymarketMarket[];
  airport: {
    name: string | null;
    icao: string;
    weather: WeatherPolymarketWeather | null;
  } | null;
};

export type WeatherPolymarketTradingStatusPayload = {
  ready: boolean;
};

export type WeatherPolymarketTriggersPayload = {
  triggers: WeatherPolymarketTrigger[];
};

export type WeatherPolymarketSetTriggerPayload = {
  status: string;
  message: string;
  trigger: WeatherPolymarketTrigger;
};

export type WeatherPolymarketClearTriggersPayload = {
  status: string;
  message: string;
  removed: WeatherPolymarketTrigger[];
};

export type WeatherPolymarketCheckTriggersPayload = {
  executed: Array<{
    token_id: string;
    temp_threshold: number;
    amount: number;
    response: unknown;
  }>;
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

export type Btc15mHedgeBotConfig = {
  marketUrl: string;
  buyPrice: number;
  shares: number;
};

export type Btc15mHedgeLegState = {
  tokenId: string | null;
  side: "up" | "down";
  orderId: string | null;
  orderPrice: number | null;
  orderSize: number;
  orderStatus: string | null;
  filledShares: number;
  filledCostUsd: number;
  avgEntryPrice: number | null;
};

export type Btc15mHedgeCycleState = {
  phase: "waiting_market" | "placing_orders" | "waiting_fills" | "paired_holding" | "cycle_done";
  cycleStartedAt: number | null;
  upLeg: Btc15mHedgeLegState;
  downLeg: Btc15mHedgeLegState;
  pairedShares: number;
};

export type Btc15mHedgeCompletedCycle = {
  id: string;
  marketSlug: string;
  buyPrice: number;
  shares: number;
  upFilled: number;
  downFilled: number;
  avgUpPrice: number | null;
  avgDownPrice: number | null;
  totalCostUsd: number;
  result: "paired_hold" | "partial_fill";
  startedAt: number;
  closedAt: number;
};

export type Btc15mHedgeStatusPayload = {
  enginePhase: "stopped" | "running" | "auto_stopped";
  dryRun: boolean;
  config: Btc15mHedgeBotConfig;
  market: {
    slug: string;
    question: string;
    startTimeMs: number;
    endTimeMs: number;
    priceToBeat: number | null;
    upTokenId: string;
    downTokenId: string;
  } | null;
  cycle: Btc15mHedgeCycleState;
  completedCycles: Btc15mHedgeCompletedCycle[];
  logs: Array<{
    timestamp: number;
    message: string;
    type: "info" | "warn" | "error" | "success";
  }>;
  updatedAt: number;
  lastError: string | null;
};

export type CheckMarketPayload = {
  valid: boolean;
  slug: string | null;
  question: string | null;
  crypto: string | null;
  timeframe: string | null;
  startTimeMs: number | null;
  endTimeMs: number | null;
  isExpired: boolean;
  upTokenId: string | null;
  downTokenId: string | null;
  upPrice: number | null;
  downPrice: number | null;
  currentMarket: {
    slug: string;
    question: string;
    startTimeMs: number;
    endTimeMs: number;
    upTokenId: string;
    downTokenId: string;
  } | null;
  error: string | null;
};
