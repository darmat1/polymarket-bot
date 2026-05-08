import { useEffect, useState, useRef, useCallback, useMemo } from "react";

type OutcomeToken = {
  label: string;
  tokenId: string;
};

type MarketSummary = {
  marketId: string;
  slug: string;
  question: string;
  description: string;
  category: string;
  outcomes: OutcomeToken[];
  active?: boolean;
  closed?: boolean;
};

type SearchEventSummary = {
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

type EvaluationPayload = {
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

type AccountSummaryPayload = {
  address: string | null;
  usdc_balance: string | null;
  available_to_trade: string | null;
  portfolio_value: string | null;
  dry_run: boolean;
  source: "polymarket-account";
};

type PolymarketPositionRow = {
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

type OpenPositionsPayload = {
  user: string | null;
  wallet_source: "funder" | "eoa" | null;
  positions: PolymarketPositionRow[];
};

type UserWebSocketAuthPayload = {
  available: boolean;
  source: "derived" | "env-fallback" | "unavailable";
  auth: {
    apiKey: string;
    secret: string;
    passphrase: string;
  } | null;
  key_preview: string | null;
  passphrase_preview: string | null;
  last_error: string | null;
};

type AppTab = "weather" | "crypto" | "positions" | "scanner" | "btc5m";

type EventLogEntry = {
  id: number;
  timestamp: number;
  marketSlug: string;
  type: "info" | "success" | "warn" | "error";
  trigger: "auto" | "manual";
  message: string;
};

type ScannerEvent = {
  conditionId: string;
  oracle: string;
  questionId: string;
  outcomeSlotCount: string;
  txHash: string;
  blockNumber: number;
  timestamp: number;
  title?: string;
  slug?: string;
  source?: "blockchain" | "gamma-recent";
};

type ScannerStatus = {
  listenerConnected: boolean;
  lastListenerHeartbeatAt: number;
  lastScannerEventAt: number;
};

type BtcCandle = {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type Btc5mSnapshotPayload = {
  market: {
    slug: string;
    question: string;
    startTime: number | null;
    endTime: number | null;
    status: "live" | "upcoming" | "recent";
    selectionReason: "actual-live" | "nearest-upcoming" | "latest-recent";
    selectionLabel: "Actual Live" | "Nearest Upcoming" | "Latest Recent";
    yesOutcome: OutcomeToken | null;
    noOutcome: OutcomeToken | null;
  };
  pricing: {
    marketStartPrice: number | null;
    marketEndPrice: number | null;
    currentBtcPrice: number | null;
    marketPriceChangePct: number | null;
  };
  prediction: {
    source: "groq" | "heuristic" | "unavailable";
    direction: "up" | "down" | "neutral";
    confidence: number | null;
    summary: string | null;
    reasoning: string[];
    generatedAt: number | null;
    aiStatus: "available" | "unavailable";
    aiError: string | null;
    heuristic: {
      direction: "up" | "down" | "neutral";
      confidence: number | null;
      summary: string | null;
    };
    groq: {
      direction: "up" | "down" | "neutral";
      confidence: number | null;
      summary: string | null;
    } | null;
  };
  book: {
    yes: {
      bestBid: number | null;
      bestAsk: number | null;
      midpoint: number | null;
      spreadBps: number | null;
    } | null;
    no: {
      bestBid: number | null;
      bestAsk: number | null;
      midpoint: number | null;
      spreadBps: number | null;
    } | null;
  };
  quotes: {
    up: number | null;
    down: number | null;
  };
};

type Btc5mSimulationState = {
  active: boolean;
  bankrollUsd: number;
  availableUsd: number;
  minStakeUsd: number;
  realizedPnlUsd: number;
  grossRealizedPnlUsd: number;
  totalStakedUsd: number;
  wins: number;
  losses: number;
  trades: number;
  winRate: number;
  sessionEquityUsd: number;
  unrealizedPnlUsd: number;
  grossUnrealizedPnlUsd: number;
  lastUpdateAt: number | null;
  lastMarketSlug: string | null;
  strategyId: "momentum_book_v1";
  openPosition: {
    strategyId: "momentum_book_v1";
    side: "up" | "down";
    marketSlug: string;
    assetId: string | null;
    stakeUsd: number;
    entryFeeUsd: number;
    totalEntryCostUsd: number;
    shares: number;
    entryPrice: number;
    openedAt: number;
    currentPrice: number | null;
    grossExitProceedsUsd: number | null;
    netExitProceedsUsd: number | null;
    grossPnlUsd: number | null;
    unrealizedPnlUsd: number | null;
    toWinUsd: number;
    enteredAtTimeToExpiryMs: number | null;
    spreadBpsAtEntry: number | null;
    spreadBucket: "lt_150" | "150_300" | "300_500" | "gte_500" | "unknown";
    timeBucket: "early" | "mid" | "late";
    targetProfitUsd: number;
    maxLossUsd: number;
    entrySignals: {
      btcMove1mPct: number | null;
      btcMove3mPct: number | null;
      btcMove5mPct: number | null;
      bookMoveBps: number | null;
      spreadBps: number | null;
      timeToExpiryMs: number | null;
      predictionDirection: "up" | "down" | "neutral";
      predictionConfidence: number | null;
      bookMidpoint: number | null;
      liveBestAsk: number | null;
      liveBestBid: number | null;
    };
  } | null;
  closedTrades: Array<{
    strategyId: "momentum_book_v1";
    side: "up" | "down";
    marketSlug: string;
    stakeUsd: number;
    entryFeeUsd: number;
    totalEntryCostUsd: number;
    shares: number;
    entryPrice: number;
    exitPrice: number;
    grossProceedsUsd: number;
    proceedsUsd: number;
    grossPnlUsd: number;
    pnlUsd: number;
    openedAt: number;
    closedAt: number;
    holdTimeMs: number;
    result: "win" | "loss";
    note: string;
    exitReason: "take_profit" | "stop_loss" | "reversal" | "time_stop" | "settlement" | "forced_flatten";
    spreadBpsAtEntry: number | null;
    spreadBpsAtExit: number | null;
    spreadBucket: "lt_150" | "150_300" | "300_500" | "gte_500" | "unknown";
    timeToExpiryMsAtEntry: number | null;
    timeToExpiryMsAtExit: number | null;
    timeBucket: "early" | "mid" | "late";
    entrySignals: {
      btcMove1mPct: number | null;
      btcMove3mPct: number | null;
      btcMove5mPct: number | null;
      bookMoveBps: number | null;
      spreadBps: number | null;
      timeToExpiryMs: number | null;
      predictionDirection: "up" | "down" | "neutral";
      predictionConfidence: number | null;
      bookMidpoint: number | null;
      liveBestAsk: number | null;
      liveBestBid: number | null;
    };
    exitSignals: {
      btcMove1mPct: number | null;
      btcMove3mPct: number | null;
      btcMove5mPct: number | null;
      bookMoveBps: number | null;
      spreadBps: number | null;
      timeToExpiryMs: number | null;
    };
  }>;
  analytics: {
    avgHoldTimeMs: number;
    maxDrawdownUsd: number;
    peakEquityUsd: number;
    pnlByStrategy: Record<"momentum_book_v1", {
      trades: number;
      wins: number;
      losses: number;
      grossPnlUsd: number;
      netPnlUsd: number;
      totalHoldTimeMs: number;
    }>;
    pnlByDirection: Record<"up" | "down", {
      trades: number;
      wins: number;
      losses: number;
      grossPnlUsd: number;
      netPnlUsd: number;
      totalHoldTimeMs: number;
    }>;
    pnlBySpreadBucket: Record<"lt_150" | "150_300" | "300_500" | "gte_500" | "unknown", {
      trades: number;
      wins: number;
      losses: number;
      grossPnlUsd: number;
      netPnlUsd: number;
      totalHoldTimeMs: number;
    }>;
    pnlByTimeBucket: Record<"early" | "mid" | "late", {
      trades: number;
      wins: number;
      losses: number;
      grossPnlUsd: number;
      netPnlUsd: number;
      totalHoldTimeMs: number;
    }>;
  };
  logs: Array<{
    timestamp: number;
    message: string;
    type: "info" | "warn" | "error" | "success";
  }>;
};

type Toast = {
  id: number;
  type: "info" | "success" | "warn" | "error";
  title: string;
  message: string;
};

type PendingSellState = {
  tokenId: string;
  marketSlug: string;
  outcome: string;
  requestedSize: number;
  status: "submitting" | "open" | "partial" | "filled" | "error";
  remainingSize: number | null;
  orderId: string | null;
  message: string | null;
  updatedAt: number;
};

function syncSharedBtc5mSubscription(socket: WebSocket | null, tab: AppTab) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(
    JSON.stringify({
      type: tab === "btc5m" ? "btc5m_subscribe" : "btc5m_unsubscribe",
    }),
  );
}

export function App() {
  const [activeTab, setActiveTab] = useState<AppTab>("positions");
  const [search, setSearch] = useState("");
  const [fairProbability, setFairProbability] = useState("");
  const [events, setEvents] = useState<SearchEventSummary[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [selectedEventSlug, setSelectedEventSlug] = useState<string>("");
  const [selectedSlug, setSelectedSlug] = useState<string>("");
  const [selectedOutcome, setSelectedOutcome] = useState<string>("");
  const [evaluation, setEvaluation] = useState<EvaluationPayload | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [evaluationError, setEvaluationError] = useState<string | null>(null);
  const [accountSummary, setAccountSummary] =
    useState<AccountSummaryPayload | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [positionsPayload, setPositionsPayload] =
    useState<OpenPositionsPayload | null>(null);
  const [loadingPositions, setLoadingPositions] = useState(false);
  const [positionsError, setPositionsError] = useState<string | null>(null);
  const [activeBotSlugs, setActiveBotSlugs] = useState<string[]>([]);
  const [rederiving, setRederiving] = useState(false);
  const [rederiveStatus, setRederiveStatus] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [eventLog, setEventLog] = useState<EventLogEntry[]>([]);
  const [eventLogLoading, setEventLogLoading] = useState(false);
  const toastIdRef = useRef(0);
  const [sellingTokenId, setSellingTokenId] = useState<string | null>(null);
  const [pendingSells, setPendingSells] = useState<Record<string, PendingSellState>>({});
  const [sellConfirmation, setSellConfirmation] = useState<{
    marketSlug: string;
    tokenId: string;
    outcome: string;
    size: number;
  } | null>(null);

  const [viewingMarketSlug, setViewingMarketSlug] = useState<string | null>(
    null,
  );
  const [marketDetails, setMarketDetails] = useState<any>(null);
  const [loadingMarketDetails, setLoadingMarketDetails] = useState(false);
  const [marketDetailsError, setMarketDetailsError] = useState<string | null>(
    null,
  );
  const [scannerEvents, setScannerEvents] = useState<ScannerEvent[]>([]);
  const [scannerStatus, setScannerStatus] = useState<ScannerStatus | null>(null);
  const [btc5mSnapshot, setBtc5mSnapshot] = useState<Btc5mSnapshotPayload | null>(null);
  const [btcCandles, setBtcCandles] = useState<BtcCandle[]>([]);
  const [btc5mNow, setBtc5mNow] = useState(() => Date.now());
  const [btc5mLoading, setBtc5mLoading] = useState(false);
  const [btc5mError, setBtc5mError] = useState<string | null>(null);
  const [btc5mSimBankroll, setBtc5mSimBankroll] = useState("1");
  const [btc5mSimState, setBtc5mSimState] = useState<Btc5mSimulationState | null>(null);
  const [btc5mSimLoading, setBtc5mSimLoading] = useState(false);
  const appWsRef = useRef<WebSocket | null>(null);
  const portfolioSyncWsRef = useRef<WebSocket | null>(null);
  const portfolioSyncPingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const portfolioSyncReconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const portfolioSyncRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const portfolioSyncStoppedRef = useRef(false);
  const activeTabRef = useRef<AppTab>("positions");

  const [posSortField, setPosSortField] = useState<string>("value");
  const [posSortDir, setPosSortDir] = useState<"asc" | "desc">("desc");

  const sortedPositions = useMemo(() => {
    if (!positionsPayload?.positions) return [];
    const positions = [...positionsPayload.positions];
    return positions.sort((a, b) => {
      let valA: any = 0;
      let valB: any = 0;

      switch (posSortField) {
        case "bot":
          valA = activeBotSlugs.includes(a.slug ?? "");
          valB = activeBotSlugs.includes(b.slug ?? "");
          break;
        case "market":
          valA = (a.title ?? a.slug ?? "").toLowerCase();
          valB = (b.title ?? b.slug ?? "").toLowerCase();
          break;
        case "avg":
          valA = a.avgPrice ?? 0;
          valB = b.avgPrice ?? 0;
          break;
        case "traded":
          valA = (a.size ?? 0) * (a.avgPrice ?? 0);
          valB = (b.size ?? 0) * (b.avgPrice ?? 0);
          break;
        case "toWin":
          valA = a.size ?? 0;
          valB = b.size ?? 0;
          break;
        case "value":
          valA = a.currentValue ?? 0;
          valB = b.currentValue ?? 0;
          break;
        case "ends":
          valA = a.endDate ? new Date(a.endDate).getTime() : 0;
          valB = b.endDate ? new Date(b.endDate).getTime() : 0;
          break;
      }

      if (valA < valB) return posSortDir === "asc" ? -1 : 1;
      if (valA > valB) return posSortDir === "asc" ? 1 : -1;
      return 0;
    });
  }, [positionsPayload?.positions, activeBotSlugs, posSortField, posSortDir]);

  const groupedPositions = useMemo(() => {
    if (!sortedPositions.length) return [];
    
    const groupsMap: Record<string, PolymarketPositionRow[]> = {};
    
    sortedPositions.forEach(pos => {
      let dateKey = "Unknown";
      if (pos.endDate) {
        try {
          // Format as YYYY-MM-DD
          dateKey = new Date(pos.endDate).toISOString().split('T')[0];
        } catch (e) {
          dateKey = pos.endDate;
        }
      }
      if (!groupsMap[dateKey]) groupsMap[dateKey] = [];
      groupsMap[dateKey].push(pos);
    });

    const today = new Date().toISOString().split('T')[0];
    
    return Object.entries(groupsMap)
      .map(([date, positions]) => ({ date, positions }))
      .sort((a, b) => {
        if (a.date === "Unknown") return 1;
        if (b.date === "Unknown") return -1;
        
        if (a.date === today) return -1;
        if (b.date === today) return 1;
        
        return a.date.localeCompare(b.date);
      });
  }, [sortedPositions]);

  const btc5mTrend = useMemo(() => {
    if (btcCandles.length < 2) {
      return null;
    }

    const first = btcCandles[0]?.open ?? null;
    const last = btcCandles[btcCandles.length - 1]?.close ?? null;
    if (first === null || last === null || first === 0) {
      return null;
    }

    return {
      direction: last >= first ? "up" : "down",
      changePct: ((last - first) / first) * 100,
    };
  }, [btcCandles]);

  const btcChartPoints = useMemo(() => {
    if (btcCandles.length === 0) {
      return "";
    }

    const min = Math.min(...btcCandles.map((candle) => candle.low));
    const max = Math.max(...btcCandles.map((candle) => candle.high));
    const range = Math.max(max - min, 1);

    return btcCandles
      .map((candle, index) => {
        const x = btcCandles.length === 1 ? 0 : (index / (btcCandles.length - 1)) * 100;
        const y = 100 - ((candle.close - min) / range) * 100;
        return `${x},${y}`;
      })
      .join(" ");
  }, [btcCandles]);

  const btcStartLine = useMemo(() => {
    const startPrice = btc5mSnapshot?.pricing.marketStartPrice;
    if (btcCandles.length === 0 || typeof startPrice !== "number" || !Number.isFinite(startPrice)) {
      return null;
    }

    const min = Math.min(...btcCandles.map((candle) => candle.low));
    const max = Math.max(...btcCandles.map((candle) => candle.high));
    const range = Math.max(max - min, 1);
    const y = 100 - ((startPrice - min) / range) * 100;

    return {
      y: Math.max(0, Math.min(100, y)),
      label: `Start ${formatCompactBtcPrice(startPrice)}`,
    };
  }, [btc5mSnapshot, btcCandles]);

  const btc5mTimeRemaining = useMemo(() => {
    const endTime = btc5mSnapshot?.market.endTime;
    if (typeof endTime !== "number" || !Number.isFinite(endTime)) {
      return null;
    }

    return Math.max(0, endTime - btc5mNow);
  }, [btc5mSnapshot, btc5mNow]);

  const toggleSort = (field: string) => {
    if (posSortField === field) {
      setPosSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setPosSortField(field);
      setPosSortDir("desc");
    }
  };

  const renderSortIcon = (field: string) => {
    if (posSortField !== field) return null;
    return (
      <span style={{ marginLeft: "4px", fontSize: "0.6rem", opacity: 0.8 }}>
        {posSortDir === "asc" ? "▲" : "▼"}
      </span>
    );
  };

  const [stationHistory, setStationHistory] = useState<any[] | null>(null);
  const [hourlyForecast, setHourlyForecast] = useState<any[] | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [loadingHourly, setLoadingHourly] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [expectHigher, setExpectHigher] = useState(false);

  const viewingMarketSlugRef = useRef<string | null>(null);
  useEffect(() => {
    viewingMarketSlugRef.current = viewingMarketSlug;
  }, [viewingMarketSlug]);

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  const [botActive, setBotActive] = useState(false);
  const [botLoading, setBotLoading] = useState(false);
  const [lastPollTime, setLastPollTime] = useState<number | null>(null);
  const [botLogs, setBotLogs] = useState<
    { timestamp: number; message: string; type: string }[]
  >([]);

  const selectedEvent =
    events.find((event) => event.slug === selectedEventSlug) ??
    events[0] ??
    null;
  const availableMarkets = (selectedEvent?.markets ?? []).filter(
    (market) => market.active !== false && market.closed !== true,
  );
  const selectedMarket =
    availableMarkets.find((market) => market.slug === selectedSlug) ??
    availableMarkets[0] ??
    null;
  const trimmedSearch = search.trim();
  const hasLocalFilters = trimmedSearch.length > 0;
  const tabTitle =
    activeTab === "weather"
      ? "Weather"
      : activeTab === "crypto"
        ? "Crypto"
        : activeTab === "btc5m"
          ? "BTC 5m"
        : "Positions";
  const searchPlaceholder =
    activeTab === "weather"
      ? "nyc high temp"
      : activeTab === "crypto"
        ? "btc up"
        : activeTab === "btc5m"
          ? "current btc 5m"
        : "";
  const statusText =
    activeTab === "positions"
      ? loadingPositions
        ? "Loading positions..."
        : positionsError
          ? positionsError
          : `${positionsPayload?.positions.length ?? 0} open position(s)`
      : activeTab === "btc5m"
        ? btc5mLoading
          ? "Loading BTC 5m panel..."
          : btc5mError
            ? btc5mError
            : btc5mSnapshot
              ? `Tracking ${btc5mSnapshot.market.slug}`
              : "No BTC 5m market loaded"
      : loadingEvents
        ? "Loading events..."
        : eventsError
          ? eventsError
          : `${events.length} ${tabTitle.toLowerCase()} event(s) visible`;
  const emptyStateText = getEmptyStateText(trimmedSearch, activeTab);

  useEffect(() => {
    setPendingSells((prev) => {
      if (!positionsPayload) {
        return prev;
      }

      let changed = false;
      const next = { ...prev };

      Object.entries(prev).forEach(([tokenId, pending]) => {
        const row = positionsPayload.positions.find((position) => position.asset === tokenId);

        if (!row || !row.size || row.size <= 0) {
          if (pending.status !== "filled") {
            next[tokenId] = {
              ...pending,
              status: "filled",
              remainingSize: 0,
              message: "Position closed",
              updatedAt: Date.now(),
            };
            changed = true;
          }
          return;
        }

        if (
          pending.requestedSize > 0 &&
          row.size < pending.requestedSize &&
          pending.status !== "partial"
        ) {
          next[tokenId] = {
            ...pending,
            status: "partial",
            remainingSize: row.size,
            message: `${formatPosNum(row.size)} shares still open`,
            updatedAt: Date.now(),
          };
          changed = true;
        }
      });

      return changed ? next : prev;
    });
  }, [positionsPayload]);

  const addToast = useCallback(
    (type: Toast["type"], title: string, message: string) => {
      const id = ++toastIdRef.current;
      setToasts((prev) => [...prev, { id, type, title, message }]);
      const ttl = type === "error" ? 10000 : 6000;
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, ttl);
    },
    [],
  );

  const loadEventLog = useCallback(async () => {
    try {
      setEventLogLoading(true);
      const res = await fetch("/api/event-log?limit=50");
      const data = await res.json();
      setEventLog(data.entries ?? []);
    } catch {
      // silent
    } finally {
      setEventLogLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAccountSummary();
    void loadEventLog();
  }, []);

  useEffect(() => {
    void connectPortfolioSyncWs();
  }, []);

  useEffect(() => {
    portfolioSyncStoppedRef.current = false;

    return () => {
      portfolioSyncStoppedRef.current = true;
      cleanupPortfolioSyncHeartbeat();
      if (portfolioSyncRefreshTimeoutRef.current) {
        clearTimeout(portfolioSyncRefreshTimeoutRef.current);
        portfolioSyncRefreshTimeoutRef.current = null;
      }
      if (portfolioSyncReconnectTimeoutRef.current) {
        clearTimeout(portfolioSyncReconnectTimeoutRef.current);
        portfolioSyncReconnectTimeoutRef.current = null;
      }
      if (portfolioSyncWsRef.current) {
        portfolioSyncWsRef.current.onopen = null;
        portfolioSyncWsRef.current.onmessage = null;
        portfolioSyncWsRef.current.onerror = null;
        portfolioSyncWsRef.current.onclose = null;
        portfolioSyncWsRef.current.close();
        portfolioSyncWsRef.current = null;
      }
    };
  }, []);

  // Poll event log every 15 s
  useEffect(() => {
    const id = setInterval(() => void loadEventLog(), 15_000);
    return () => clearInterval(id);
  }, [loadEventLog]);

  useEffect(() => {
    const isDev =
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1" ||
      window.location.port !== "";
    const wsUrl = isDev
      ? `ws://${window.location.hostname}:3001`
      : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;



    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout>;

    function connect() {
      console.log("Connecting to persistent WebSocket...");
      ws = new WebSocket(wsUrl);
      appWsRef.current = ws;

      ws.onopen = () => {
        syncSharedBtc5mSubscription(ws, activeTabRef.current);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          const currentSlug = viewingMarketSlugRef.current;

          if (msg.type === "weather_update" && msg.marketSlug === currentSlug) {
            setStationHistory((prev) => {
              if (!prev) return [msg.observation];
              const exists = prev.some(
                (obs) => obs.obsTime === msg.observation.obsTime,
              );
              if (exists) return prev;
              return [msg.observation, ...prev].sort(
                (a, b) => b.obsTime - a.obsTime,
              );
            });
          }
          if (msg.type === "bot_heartbeat" && msg.marketSlug === currentSlug) {
            setLastPollTime(msg.lastPollTime);
          }
          if (msg.type === "bot_log" && msg.marketSlug === currentSlug) {
            setBotLogs((prev) => [msg.log, ...prev].slice(0, 20));
          }
          if (msg.type === "bot_exit") {
            setActiveBotSlugs((prev) =>
              prev.filter((s) => s !== msg.marketSlug),
            );
            if (msg.marketSlug === currentSlug) {
              setBotActive(false);
            }
            addToast("warn", "Bot Emergency Exit", msg.reason ?? msg.marketSlug);
            void loadPositions();
            void loadEventLog();
          }
          if (msg.type === "bot_error") {
            // Sell failed — bot still active, shown in Event Log
            addToast(
              "error",
              "Sell Failed",
              `${msg.reason} — Bot stays active, will retry in ~5 min.`,
            );
            void loadEventLog();
          }
          if (msg.type === "scanner_event") {
            setScannerEvents((prev) => [msg as ScannerEvent, ...prev].slice(0, 50));
            setScannerStatus((prev) =>
              prev
                ? {
                    ...prev,
                    lastScannerEventAt: typeof msg.timestamp === "number" ? msg.timestamp : Date.now(),
                  }
                : {
                    listenerConnected: true,
                    lastListenerHeartbeatAt: 0,
                    lastScannerEventAt: typeof msg.timestamp === "number" ? msg.timestamp : Date.now(),
                  },
            );
            addToast("info", "New Market Detected", `Condition: ${msg.conditionId.slice(0, 10)}...`);
          }
          if (msg.type === "btc5m_sim_state" && msg.state) {
            setBtc5mSimState(msg.state as Btc5mSimulationState);
          }
          if (msg.type === "btc5m_sim_log" && msg.state) {
            setBtc5mSimState(msg.state as Btc5mSimulationState);
          }
          if (msg.type === "btc5m_snapshot" && msg.snapshot) {
            setBtc5mSnapshot(msg.snapshot as Btc5mSnapshotPayload);
            if (Array.isArray(msg.candles)) {
              setBtcCandles(msg.candles as BtcCandle[]);
            }
            setBtc5mError(null);
          }

        } catch (err) {
          console.error("WS message error", err);
        }
      };

      ws.onclose = () => {
        appWsRef.current = null;
        console.log("WS closed, reconnecting in 3s...");
        reconnectTimeout = setTimeout(connect, 3000);
      };

      ws.onerror = (err) => {
        console.error("WS error", err);
        ws?.close();
      };
    }

    connect();

    return () => {
      if (ws) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "btc5m_unsubscribe" }));
        }
        appWsRef.current = null;
        ws.onclose = null;
        ws.close();
      }
      clearTimeout(reconnectTimeout);
    };
  }, []);

  useEffect(() => {
    syncSharedBtc5mSubscription(appWsRef.current, activeTab);
  }, [activeTab]);

  useEffect(() => {
    // Auto-refresh positions every 30 seconds when on the home page (no market viewed)
    if (!viewingMarketSlug) {
      console.log("Starting auto-refresh for positions (30s)...");
      const interval = setInterval(() => {
        void loadPositions();
      }, 30000);
      return () => clearInterval(interval);
    }
  }, [viewingMarketSlug]);

  useEffect(() => {
    if (viewingMarketSlug) {
      void fetchBotStatus(viewingMarketSlug);
    }
  }, [viewingMarketSlug]);

  const [isRefreshing, setIsRefreshing] = useState(false);

  async function fetchBotStatus(slug: string) {
    try {
      const botStatusRes = await fetch(`/api/bot/status?slug=${slug}`);
      const botStatus = await botStatusRes.json();
      setBotActive(botStatus.active);
      setLastPollTime(botStatus.lastPollTime || null);
      setBotLogs(botStatus.logs || []);
    } catch (err) {
      console.error("Failed to fetch bot status", err);
    }
  }

  async function toggleBotForSlug(slug: string, currentActive: boolean) {
    setBotLoading(true);
    try {
      if (currentActive) {
        await fetch("/api/bot/deactivate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ marketSlug: slug }),
        });
        if (slug === viewingMarketSlug) setBotActive(false);
        setActiveBotSlugs((prev) => prev.filter((s) => s !== slug));
      } else {
        // We need market details to activate
        const detailsRes = await fetch(`/api/market-details?slug=${slug}`);
        const details = await detailsRes.json();
        if (!details || !details.extractedData)
          throw new Error("Could not load market details for bot");

        const activePositions = (positionsPayload?.positions || []).filter(
          (p) => p.slug === slug,
        );
        if (activePositions.length === 0) {
          const availableSlugs = (positionsPayload?.positions || []).map(p => p.slug).join(", ");
          addToast("warn", "No positions found", `Could not find an open position for slug: ${slug}. (Available in your portfolio: ${availableSlugs || 'none'})`);
          setBotLoading(false);
          return;
        }

        const pos = activePositions[0];

        await fetch("/api/bot/activate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            marketSlug: slug,
            stationCode: details.extractedData.station_code,
            targetTemp: details.extractedData.t,
            targetDate: details.extractedData.day,
            tempUnit: details.extractedData.t_sys ?? "C",
            outcome: pos.outcome,
            tokenId: pos.asset,
            expectHigher: expectHigher,
            timezone: details.extractedData.timezone,
          }),
        });
        if (slug === viewingMarketSlug) setBotActive(true);
        setActiveBotSlugs((prev) => [...prev, slug]);
      }
    } catch (err) {
      addToast("error", "Bot toggle failed", err instanceof Error ? err.message : "Unknown error");
      console.error(err);
    } finally {
      setBotLoading(false);
    }
  }

  async function toggleBot() {
    if (!viewingMarketSlug) return;
    await toggleBotForSlug(viewingMarketSlug, botActive);
  }

  function confirmManualSell(marketSlug: string, tokenId: string, outcome: string, size: number) {
    setSellConfirmation({ marketSlug, tokenId, outcome, size });
  }

  async function handleManualSell() {
    if (!sellConfirmation) return;
    const { marketSlug, tokenId, outcome, size } = sellConfirmation;
    setSellingTokenId(tokenId);
    setPendingSells((prev) => ({
      ...prev,
      [tokenId]: {
        tokenId,
        marketSlug,
        outcome,
        requestedSize: size,
        status: "submitting",
        remainingSize: size,
        orderId: null,
        message: "Submitting sell order",
        updatedAt: Date.now(),
      },
    }));
    setSellConfirmation(null);
    try {
      const res = await fetch("/api/bot/manual-sell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marketSlug, tokenId }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Sell failed");
      }
      setPendingSells((prev) => ({
        ...prev,
        [tokenId]: {
          tokenId,
          marketSlug,
          outcome,
          requestedSize: size,
          status: "open",
          remainingSize: size,
          orderId:
            typeof data?.result?.orderId === "string"
              ? data.result.orderId
              : typeof data?.result?.id === "string"
                ? data.result.id
                : null,
          message: "Sell order submitted",
          updatedAt: Date.now(),
        },
      }));
      addToast(
        "success",
        "Sell submitted",
        `${outcome} — ${data.message ?? `${data.sizeToSell} shares @ 0.01`}`,
      );
      void loadPositions();
      void loadEventLog();
    } catch (err) {
      setPendingSells((prev) => ({
        ...prev,
        [tokenId]: {
          tokenId,
          marketSlug,
          outcome,
          requestedSize: size,
          status: "error",
          remainingSize: size,
          orderId: null,
          message: err instanceof Error ? err.message : "Sell failed",
          updatedAt: Date.now(),
        },
      }));
      addToast("error", "Sell failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSellingTokenId(null);
    }
  }

  useEffect(() => {
    if (activeTab === "positions") {
      void loadPositions();
    } else if (activeTab === "btc5m") {
      if (!btc5mSnapshot || btcCandles.length === 0) {
        void loadBtc5mPanel();
      }
      void loadBtc5mSimState();
    } else if (activeTab === "scanner") {
      void loadScannerEvents();
      void loadScannerStatus();
    }
  }, [activeTab, btc5mSnapshot, btcCandles.length]);

  useEffect(() => {
    if (activeTab !== "btc5m") {
      return;
    }

    const interval = setInterval(() => {
      void loadBtc5mSimState();
    }, 15_000);

    return () => clearInterval(interval);
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== "btc5m") {
      return;
    }

    setBtc5mNow(Date.now());
    const interval = setInterval(() => {
      setBtc5mNow(Date.now());
    }, 1_000);

    return () => clearInterval(interval);
  }, [activeTab]);

  useEffect(() => {
    if (!selectedEvent) {
      setSelectedEventSlug("");
    } else if (selectedEventSlug !== selectedEvent.slug) {
      setSelectedEventSlug(selectedEvent.slug);
    }
  }, [selectedEvent, selectedEventSlug]);

  useEffect(() => {
    if (!selectedMarket) {
      setSelectedSlug("");
      setSelectedOutcome("");
      return;
    }

    if (selectedSlug !== selectedMarket.slug) {
      setSelectedSlug(selectedMarket.slug);
    }

    const outcomeStillExists = selectedMarket.outcomes.some(
      (outcome) => outcome.label === selectedOutcome,
    );
    if (!outcomeStillExists) {
      setSelectedOutcome(selectedMarket.outcomes[0]?.label ?? "");
    }
  }, [selectedMarket, selectedOutcome, selectedSlug]);

  async function loadEvents(nextSearch: string) {
    setLoadingEvents(true);
    setEventsError(null);

    try {
      const params = new URLSearchParams();
      if (nextSearch.trim()) {
        params.set("search", nextSearch.trim());
      }

      const response = await fetch(`/api/search-events?${params.toString()}`);
      const payload = (await response.json()) as {
        error?: string;
        events?: SearchEventSummary[];
      };

      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to load events");
      }

      const rawEvents = payload.events ?? [];
      const filteredEvents = rawEvents.filter((event) => {
        if (activeTab === "weather") {
          return isWeatherEvent(event);
        }
        return isCryptoEvent(event);
      });

      setEvents(filteredEvents);
      setSelectedEventSlug("");
      setSelectedSlug("");
      setSelectedOutcome("");
      setEvaluation(null);
    } catch (error) {
      setEventsError(
        error instanceof Error ? error.message : "Failed to load events",
      );
      setEvents([]);
    } finally {
      setLoadingEvents(false);
    }
  }

  async function loadHourlyForecast(slug: string) {
    setLoadingHourly(true);
    setHourlyForecast([]); // Clear previous to avoid showing stale data
    try {
      const res = await fetch(`/api/hourly-forecast?slug=${slug}&past_days=1`);
      const data = await res.json();
      setHourlyForecast(data.forecast ?? []);
    } catch (err) {
      console.error("Failed to load hourly forecast:", err);
      setHourlyForecast([]);
    } finally {
      setLoadingHourly(false);
    }
  }

  async function loadAccountSummary() {
    try {
      const response = await fetch("/api/account-summary");
      const payload = (await response.json()) as AccountSummaryPayload & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to load account summary");
      }
      setAccountSummary(payload);
      setAccountError(null);
    } catch (error) {
      setAccountError(
        error instanceof Error
          ? error.message
          : "Failed to load account summary",
      );
      setAccountSummary(null);
    }
  }

  async function loadPositions() {
    setIsRefreshing(true);
    setLoadingPositions(true);
    setPositionsError(null);
    try {
      const response = await fetch("/api/positions");
      const payload = (await response.json()) as OpenPositionsPayload & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to load positions");
      }
      setPositionsPayload(payload);
    } catch (error) {
      setPositionsError(
        error instanceof Error ? error.message : "Failed to load positions",
      );
      setPositionsPayload(null);
    } finally {
      setLoadingPositions(false);
      // Keep isRefreshing true for a bit longer to show the "pulse"
      setTimeout(() => setIsRefreshing(false), 800);

      // Also fetch active bots
      try {
        const res = await fetch("/api/bot/active-slugs");
        const data = await res.json();
        setActiveBotSlugs(data.slugs || []);
      } catch (e) {
        console.error("Failed to fetch active bots", e);
      }
    }
  }

  async function loadScannerEvents() {
    try {
      const response = await fetch("/api/scanner-events?limit=20");
      const payload = (await response.json()) as {
        error?: string;
        events?: ScannerEvent[];
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to load scanner events");
      }
      setScannerEvents(payload.events ?? []);
    } catch (error) {
      console.error(
        "Failed to load scanner events",
        error instanceof Error ? error.message : error,
      );
    }
  }

  async function loadScannerStatus() {
    try {
      const response = await fetch("/api/scanner-status");
      const payload = (await response.json()) as ScannerStatus & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to load scanner status");
      }
      setScannerStatus(payload);
    } catch (error) {
      console.error(
        "Failed to load scanner status",
        error instanceof Error ? error.message : error,
      );
      setScannerStatus(null);
    }
  }

  async function loadBtc5mPanel() {
    try {
      setBtc5mLoading(true);
      setBtc5mError(null);

      const [snapshotResponse, candlesResponse] = await Promise.all([
        fetch("/api/btc-5m-current"),
        fetch("/api/btc-candles?limit=60"),
      ]);

      const snapshotPayload = (await snapshotResponse.json()) as Btc5mSnapshotPayload & {
        error?: string;
      };
      const candlesPayload = (await candlesResponse.json()) as {
        candles?: BtcCandle[];
        error?: string;
      };

      if (!snapshotResponse.ok) {
        throw new Error(snapshotPayload.error ?? "Failed to load BTC 5m market");
      }
      if (!candlesResponse.ok) {
        throw new Error(candlesPayload.error ?? "Failed to load BTC candles");
      }

      setBtc5mSnapshot(snapshotPayload);
      setBtcCandles(candlesPayload.candles ?? []);
    } catch (error) {
      setBtc5mError(
        error instanceof Error ? error.message : "Failed to load BTC 5m panel",
      );
      setBtc5mSnapshot(null);
      setBtcCandles([]);
    } finally {
      setBtc5mLoading(false);
    }
  }

  async function loadBtc5mSimState() {
    try {
      const response = await fetch("/api/btc5m-sim/status");
      const payload = (await response.json()) as Btc5mSimulationState & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to load BTC sim state");
      }
      setBtc5mSimState(payload);
    } catch (error) {
      console.error("Failed to load BTC sim state", error instanceof Error ? error.message : error);
    }
  }

  async function toggleBtc5mSimulation(nextActive: boolean) {
    setBtc5mSimLoading(true);
    try {
      const response = await fetch(nextActive ? "/api/btc5m-sim/activate" : "/api/btc5m-sim/deactivate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: nextActive ? JSON.stringify({ bankrollUsd: Number(btc5mSimBankroll) }) : undefined,
      });
      const payload = (await response.json()) as { error?: string; state?: Btc5mSimulationState };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to update BTC sim state");
      }
      if (payload.state) {
        setBtc5mSimState(payload.state);
      }
    } catch (error) {
      setBtc5mError(error instanceof Error ? error.message : "Failed to update BTC simulation");
    } finally {
      setBtc5mSimLoading(false);
    }
  }

  async function handleEvaluate() {
    if (!selectedMarket || !selectedOutcome) {
      return;
    }

    setEvaluating(true);
    setEvaluationError(null);

    try {
      const response = await fetch("/api/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketSlug: selectedMarket.slug,
          outcome: selectedOutcome,
          fairProbability:
            fairProbability.trim() === "" ? null : Number(fairProbability),
        }),
      });

      const payload = (await response.json()) as EvaluationPayload & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to evaluate market");
      }

      setEvaluation(payload);
    } catch (error) {
      setEvaluationError(
        error instanceof Error ? error.message : "Failed to evaluate market",
      );
      setEvaluation(null);
    } finally {
      setEvaluating(false);
    }
  }

  function resetFilters() {
    setSearch("");
    setEvents([]);
  }

  async function loadStationHistory(stationCode: string) {
    setLoadingHistory(true);
    try {
      const res = await fetch(`/api/station-history?station=${stationCode}`);
      const data = await res.json();
      if (data.error) {
        setHistoryError(data.error);
      } else {
        setStationHistory(data.history);
      }
    } catch (e: any) {
      setHistoryError(e.message);
    } finally {
      setLoadingHistory(false);
    }
  }

  async function loadMarketDetails(slug: string) {
    setViewingMarketSlug(slug);
    setLoadingMarketDetails(true);
    setMarketDetailsError(null);
    setStationHistory(null);
    setHistoryError(null);
    setHourlyForecast([]);
    try {
      const response = await fetch(`/api/market-details?slug=${slug}`);
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to load market details");
      }
      setMarketDetails(payload);

      // Load hourly forecast
      loadHourlyForecast(slug);

      const stationCode = payload.extractedData?.station_code;
      if (stationCode) {
        loadStationHistory(stationCode);
      }
    } catch (error) {
      setMarketDetailsError(
        error instanceof Error
          ? error.message
          : "Failed to load market details",
      );
      setMarketDetails(null);
    } finally {
      setLoadingMarketDetails(false);
    }
  }

  // Auto-refresh: station history every 2 min, forecast every 5 min
  useEffect(() => {
    if (!viewingMarketSlug || !marketDetails) return;

    const stationCode = marketDetails.extractedData?.station_code;

    const historyInterval = stationCode
      ? setInterval(() => loadStationHistory(stationCode), 2 * 60 * 1000)
      : null;

    const forecastInterval = setInterval(
      () => loadHourlyForecast(viewingMarketSlug),
      5 * 60 * 1000,
    );

    return () => {
      if (historyInterval) clearInterval(historyInterval);
      clearInterval(forecastInterval);
    };
  }, [viewingMarketSlug, marketDetails]);

  function handleTabSwitch(nextTab: AppTab) {
    if (nextTab === activeTab) {
      return;
    }

    setActiveTab(nextTab);
    setEvents([]);
    setSelectedEventSlug("");
    setSelectedSlug("");
    setSelectedOutcome("");
    setEvaluation(null);
    setEvaluationError(null);
    setViewingMarketSlug(null);
    setMarketDetails(null);
  }

  async function handleRederiveCreds() {
    setRederiving(true);
    setRederiveStatus(null);
    try {
      const res = await fetch("/api/rederive-creds", { method: "POST" });
      const data = await res.json();
      if (data.ok && data.derived) {
        setRederiveStatus(`✓ ${data.credsSource} — ${data.keyPreview}`);
      } else {
        setRederiveStatus(`✗ ${data.lastError ?? data.error ?? "Failed"}`);
      }
    } catch (err) {
      setRederiveStatus("✗ Network error");
    } finally {
      setRederiving(false);
      if (portfolioSyncWsRef.current) {
        portfolioSyncWsRef.current.onclose = null;
        portfolioSyncWsRef.current.close();
        portfolioSyncWsRef.current = null;
      }
      cleanupPortfolioSyncHeartbeat();
      if (portfolioSyncReconnectTimeoutRef.current) {
        clearTimeout(portfolioSyncReconnectTimeoutRef.current);
        portfolioSyncReconnectTimeoutRef.current = null;
      }
      void connectPortfolioSyncWs();
    }
  }

  function cleanupPortfolioSyncHeartbeat() {
    if (portfolioSyncPingIntervalRef.current) {
      clearInterval(portfolioSyncPingIntervalRef.current);
      portfolioSyncPingIntervalRef.current = null;
    }
  }

  function schedulePortfolioRefresh() {
    if (portfolioSyncRefreshTimeoutRef.current) {
      clearTimeout(portfolioSyncRefreshTimeoutRef.current);
    }

    portfolioSyncRefreshTimeoutRef.current = setTimeout(() => {
      portfolioSyncRefreshTimeoutRef.current = null;
      void loadPositions();
      void loadAccountSummary();
    }, 750);
  }

  function shouldRefreshPortfolioFromUserMessage(payload: unknown): boolean {
    if (Array.isArray(payload)) {
      return payload.some((entry) => shouldRefreshPortfolioFromUserMessage(entry));
    }

    if (!payload || typeof payload !== "object") {
      return false;
    }

    const data = payload as Record<string, unknown>;
    const eventType = typeof data.event_type === "string" ? data.event_type : null;
    const status = typeof data.status === "string" ? data.status.toLowerCase() : null;
    const type = typeof data.type === "string" ? data.type.toLowerCase() : null;

    if (eventType === "trade") {
      return true;
    }

    if (eventType !== "order") {
      return false;
    }

    return status !== null || type !== null;
  }

  function extractTokenIdsFromUserMessage(payload: unknown): string[] {
    if (Array.isArray(payload)) {
      return payload.flatMap((entry) => extractTokenIdsFromUserMessage(entry));
    }

    if (!payload || typeof payload !== "object") {
      return [];
    }

    const data = payload as Record<string, unknown>;
    const ids = [data.asset_id, data.asset, data.token_id, data.tokenID]
      .filter((value): value is string => typeof value === "string" && value.length > 0);

    return [...new Set(ids)];
  }

  function updatePendingSellsFromUserMessage(payload: unknown) {
    const entries = Array.isArray(payload) ? payload : [payload];
    const now = Date.now();

    setPendingSells((prev) => {
      let changed = false;
      const next = { ...prev };

      entries.forEach((entry) => {
        if (!entry || typeof entry !== "object") {
          return;
        }

        const data = entry as Record<string, unknown>;
        const eventType = typeof data.event_type === "string" ? data.event_type.toLowerCase() : null;
        const status = typeof data.status === "string" ? data.status.toLowerCase() : null;
        const type = typeof data.type === "string" ? data.type.toLowerCase() : null;
        const side = typeof data.side === "string" ? data.side.toLowerCase() : null;
        const orderId = typeof data.id === "string"
          ? data.id
          : typeof data.order_id === "string"
            ? data.order_id
            : null;

        extractTokenIdsFromUserMessage(data).forEach((tokenId) => {
          const pending = next[tokenId];
          if (!pending || (side !== null && side !== "sell")) {
            return;
          }

          let nextStatus = pending.status;
          let nextMessage = pending.message;
          let nextRemaining = pending.remainingSize;

          if (eventType === "trade") {
            nextStatus = "partial";
            nextMessage = "Trade matched";
          } else if (status === "matched" || status === "filled" || status === "completed") {
            nextStatus = "filled";
            nextMessage = "Sell filled";
            nextRemaining = 0;
          } else if (status === "live" || status === "open" || status === "pending") {
            nextStatus = "open";
            nextMessage = "Sell order open";
          } else if (status === "partially_matched" || status === "partially_filled") {
            nextStatus = "partial";
            nextMessage = "Partially sold";
          } else if (
            status === "canceled" ||
            status === "cancelled" ||
            status === "rejected" ||
            status === "failed"
          ) {
            nextStatus = "error";
            nextMessage = status === "failed" ? "Sell failed" : `Sell ${status}`;
          } else if (type === "cancellation") {
            nextStatus = "error";
            nextMessage = "Sell cancelled";
          }

          next[tokenId] = {
            ...pending,
            status: nextStatus,
            remainingSize: nextRemaining,
            orderId: orderId ?? pending.orderId,
            message: nextMessage,
            updatedAt: now,
          };
          changed = true;
        });
      });

      return changed ? next : prev;
    });
  }

  function getPendingSellState(tokenId: string | undefined) {
    if (!tokenId) {
      return null;
    }

    return pendingSells[tokenId] ?? null;
  }

  async function connectPortfolioSyncWs() {
    if (portfolioSyncStoppedRef.current || portfolioSyncWsRef.current) {
      return;
    }

    try {
      const res = await fetch("/api/user-ws-auth");
      const payload = (await res.json()) as UserWebSocketAuthPayload & {
        error?: string;
      };

      if (!res.ok) {
        throw new Error(payload.error ?? "Failed to load user websocket auth");
      }

      if (!payload.available || !payload.auth || portfolioSyncStoppedRef.current) {
        return;
      }

      const ws = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/user");
      portfolioSyncWsRef.current = ws;

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            auth: payload.auth,
            type: "user",
          }),
        );

        cleanupPortfolioSyncHeartbeat();
        portfolioSyncPingIntervalRef.current = setInterval(() => {
          if (portfolioSyncWsRef.current?.readyState === WebSocket.OPEN) {
            portfolioSyncWsRef.current.send("PING");
          }
        }, 10_000);
      };

      ws.onmessage = (event) => {
        const raw = typeof event.data === "string" ? event.data : String(event.data);
        if (raw === "PONG") {
          return;
        }

        try {
          const parsed = JSON.parse(raw) as unknown;
          updatePendingSellsFromUserMessage(parsed);
          if (shouldRefreshPortfolioFromUserMessage(parsed)) {
            schedulePortfolioRefresh();
          }
        } catch {
          // ignore malformed user channel payloads for background sync
        }
      };

      ws.onerror = () => {
        ws.close();
      };

      ws.onclose = () => {
        cleanupPortfolioSyncHeartbeat();
        portfolioSyncWsRef.current = null;

        if (portfolioSyncStoppedRef.current) {
          return;
        }

        portfolioSyncReconnectTimeoutRef.current = setTimeout(() => {
          portfolioSyncReconnectTimeoutRef.current = null;
          void connectPortfolioSyncWs();
        }, 3_000);
      };
    } catch {
      if (portfolioSyncStoppedRef.current) {
        return;
      }

      portfolioSyncWsRef.current = null;

      portfolioSyncReconnectTimeoutRef.current = setTimeout(() => {
        portfolioSyncReconnectTimeoutRef.current = null;
        void connectPortfolioSyncWs();
      }, 10_000);
    }
  }

  return (
    <div className="shell">
      {/* ── Toast stack ── */}
      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.type}`}>
            <span className="toast-icon">
              {t.type === "error" ? "✖" : t.type === "warn" ? "⚠" : t.type === "success" ? "✔" : "ℹ"}
            </span>
            <div className="toast-body">
              <strong>{t.title}</strong>
              <span>{t.message}</span>
            </div>
            <button
              className="toast-close"
              onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <header className="topbar">
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span className="topbar-label">Portfolio</span>
          <strong className="topbar-value">
            {formatMoneyValue(accountSummary?.portfolio_value)}
          </strong>
          <span className="topbar-label">Available</span>
          <strong className="topbar-value">
            {formatMoneyValue(accountSummary?.available_to_trade)}
          </strong>
          <span className="topbar-label">Wallet USDC</span>
          <strong className="topbar-value">
            {formatUsdcValue(accountSummary?.usdc_balance)}
          </strong>
        </div>

        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: "15px",
          }}
        >
          <span className="topbar-meta">
            {accountSummary?.address
              ? shortenAddress(accountSummary.address)
              : accountError
                ? accountError
                : "No wallet"}
          </span>
          <span
            className={`topbar-mode ${accountSummary?.dry_run ? "dry" : "live"}`}
          >
            {accountSummary?.dry_run ? "dry-run" : "live"}
          </span>
          <button
            type="button"
            className="button button-secondary"
            style={{ fontSize: "0.72rem", padding: "4px 10px", opacity: rederiving ? 0.6 : 1 }}
            onClick={() => void handleRederiveCreds()}
            disabled={rederiving}
            title="Re-derive Polymarket L2 API credentials from private key"
          >
            {rederiving ? "Re-deriving..." : "Re-derive Keys"}
          </button>
          {rederiveStatus && (
            <span style={{
              fontSize: "0.72rem",
              color: rederiveStatus.startsWith("✓") ? "var(--mint)" : "var(--rose)",
              maxWidth: "200px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}>
              {rederiveStatus}
            </span>
          )}
        </div>
      </header>

      {!viewingMarketSlug && (
        <nav className="app-nav">
          <button className={`button ${activeTab === "positions" ? "button-primary" : "button-secondary"}`} onClick={() => handleTabSwitch("positions")}>Positions</button>
          <button className={`button ${activeTab === "btc5m" ? "button-primary" : "button-secondary"}`} onClick={() => handleTabSwitch("btc5m")}>BTC 5m</button>
          {(import.meta as any).env?.VITE_TEST === "1" && (
            <button className={`button ${activeTab === "scanner" as any ? "button-primary" : "button-secondary"}`} onClick={() => handleTabSwitch("scanner" as any)}>Scanner</button>
          )}
        </nav>
      )}

      {activeTab === "btc5m" ? (
        <main className="layout layout-single">
          <section className="panel">
            <div className="panel-head">
              <div>
                <p className="section-kicker">BTC Up/Down</p>
                <h2>Current 5 Minute Market</h2>
              </div>
              <button
                className="button button-secondary"
                type="button"
                onClick={() => void loadBtc5mPanel()}
                disabled={btc5mLoading}
              >
                {btc5mLoading ? "Refreshing..." : "Refresh"}
              </button>
            </div>

            {btc5mError ? <p className="status">{btc5mError}</p> : null}

            {!btc5mSnapshot ? (
              <div className="empty-state">
                <strong>No BTC 5m market loaded</strong>
                <p>Open the panel during live trading hours to resolve the current `btc-updown-5m-*` market.</p>
              </div>
            ) : (
              <div className="btc5m-shell">
                <section className="btc5m-hero btc5m-span-2">
                  <div>
                    <div className="btc5m-market-title">{btc5mSnapshot.market.question}</div>
                    <div className="btc5m-market-meta">
                      <span className={`status-badge ${btc5mSnapshot.market.status === "live" ? "on" : "off"}`}>
                        <span className={`indicator-dot ${btc5mSnapshot.market.status === "live" ? "pulse" : ""}`} />
                        {btc5mSnapshot.market.status}
                      </span>
                      <span>{btc5mSnapshot.market.selectionLabel}</span>
                      <span>{btc5mSnapshot.market.slug}</span>
                      <span>
                        Ends {btc5mSnapshot.market.endTime ? new Date(btc5mSnapshot.market.endTime).toLocaleTimeString() : "n/a"}
                      </span>
                    </div>
                  </div>
                  <div className="btc5m-pricing">
                    <article>
                      <span>Start BTC</span>
                      <strong>{formatBtcPrice(btc5mSnapshot.pricing.marketStartPrice)}</strong>
                    </article>
                    <article>
                      <span>Current BTC</span>
                      <strong>{formatBtcPrice(btc5mSnapshot.pricing.currentBtcPrice)}</strong>
                    </article>
                    <article>
                      <span>Move</span>
                      <strong className={
                        (btc5mSnapshot.pricing.marketPriceChangePct ?? 0) >= 0 ? "pnl-pos" : "pnl-neg"
                      }>
                        {formatPercentSigned(btc5mSnapshot.pricing.marketPriceChangePct)}
                      </strong>
                    </article>
                  </div>
                </section>

                <section className="btc5m-grid btc5m-span-2">
                  <section className="btc5m-chart-card">
                    <div className="btc5m-chart-head">
                      <span>Underlying BTC 1m trend</span>
                      <span className={btc5mTrend?.direction === "up" ? "pnl-pos" : btc5mTrend?.direction === "down" ? "pnl-neg" : "status-muted"}>
                        {btc5mTimeRemaining !== null ? `${formatCountdownMs(btc5mTimeRemaining)} left` : btc5mTrend ? `${btc5mTrend.direction} ${formatPercentSigned(btc5mTrend.changePct)}` : "not enough data"}
                      </span>
                    </div>
                    <div className="btc5m-chart-wrap">
                      {btcChartPoints ? (
                        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="btc5m-chart">
                          {btcStartLine ? (
                            <>
                              <line x1="0" y1={btcStartLine.y} x2="100" y2={btcStartLine.y} className="btc5m-chart-start-line" />
                              <text x="3" y={Math.max(6, btcStartLine.y - 1.5)} textAnchor="start" className="btc5m-chart-start-label">
                                {btcStartLine.label}
                              </text>
                            </>
                          ) : null}
                          <polyline points={btcChartPoints} className="btc5m-chart-line" />
                        </svg>
                      ) : (
                        <div className="empty-state" style={{ padding: "18px" }}>
                          <p>No candle data yet.</p>
                        </div>
                      )}
                    </div>
                  </section>

                  <section className="btc5m-card btc5m-prediction-card">
                    <div className="btc5m-chart-head">
                      <span>Signal comparison</span>
                      <span className={
                        btc5mSnapshot.prediction.direction === "up"
                          ? "pnl-pos"
                          : btc5mSnapshot.prediction.direction === "down"
                            ? "pnl-neg"
                            : "status-muted"
                      }>
                        {btc5mSnapshot.prediction.direction.toUpperCase()} {formatConfidence(btc5mSnapshot.prediction.confidence)}
                      </span>
                    </div>
                    <div className="btc5m-rule-list" style={{ marginTop: 0 }}>
                      <div>
                        Heuristic prediction: {btc5mSnapshot.prediction.heuristic.direction.toUpperCase()} {formatConfidence(btc5mSnapshot.prediction.heuristic.confidence)}
                      </div>
                      <div>
                        AI prediction: {btc5mSnapshot.prediction.groq ? `${btc5mSnapshot.prediction.groq.direction.toUpperCase()} ${formatConfidence(btc5mSnapshot.prediction.groq.confidence)}` : btc5mSnapshot.prediction.aiError ? `unavailable (${btc5mSnapshot.prediction.aiError})` : "unavailable"}
                      </div>
                      <div>
                        Summary: {btc5mSnapshot.prediction.summary ?? "No prediction summary available."}
                      </div>
                      {btc5mSnapshot.prediction.reasoning.length > 0 ? (
                        <div>
                          {btc5mSnapshot.prediction.reasoning.join(" | ")}
                        </div>
                      ) : (
                        <div>No reasoning available.</div>
                      )}
                    </div>
                  </section>
                </section>

                <section className="btc5m-card">
                  <div className="btc5m-chart-head">
                    <span>Simulation bankroll</span>
                    <span className={btc5mSimState?.active ? "pnl-pos" : "status-muted"}>
                      {btc5mSimState?.active ? "RUNNING" : "STOPPED"}
                    </span>
                  </div>
                  <div className="btc5m-sim-controls">
                    <label>
                      <span>Virtual dollars for this market</span>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={btc5mSimBankroll}
                        onChange={(event) => setBtc5mSimBankroll(event.target.value)}
                        disabled={btc5mSimState?.active || btc5mSimLoading}
                      />
                    </label>
                    <button
                      className={`button ${btc5mSimState?.active ? "button-secondary" : "button-primary"}`}
                      type="button"
                      disabled={btc5mSimLoading}
                      onClick={() => void toggleBtc5mSimulation(!(btc5mSimState?.active ?? false))}
                    >
                      {btc5mSimLoading ? "Working..." : btc5mSimState?.active ? "Stop Simulation" : "Start Simulation"}
                    </button>
                  </div>
                  <div className="btc5m-rule-list">
                    <div>Minimum stake: $1.00</div>
                    <div>Strategy: {btc5mSimState?.strategyId ?? "momentum_book_v1"}</div>
                    <div>Entry rule: BTC momentum + rising book + spread under 300 bps</div>
                    <div>Exit rule: TP, stop, reversal, time stop, settlement, forced flatten</div>
                    <div>Trend: {btc5mTrend ? `${btc5mTrend.direction} ${formatPercentSigned(btc5mTrend.changePct)}` : "waiting for candles"}</div>
                    <div>Up ask / spread: {formatMarketPrice(btc5mSnapshot.book.yes?.bestAsk ?? btc5mSnapshot.quotes.up)} / {formatBpsValue(btc5mSnapshot.book.yes?.spreadBps ?? null)}</div>
                    <div>Down ask / spread: {formatMarketPrice(btc5mSnapshot.book.no?.bestAsk ?? btc5mSnapshot.quotes.down)} / {formatBpsValue(btc5mSnapshot.book.no?.spreadBps ?? null)}</div>
                    <div>Available: {formatUsdValue(btc5mSimState?.availableUsd ?? null)}</div>
                    <div>Net realized PnL: {formatUsdSigned(btc5mSimState?.realizedPnlUsd ?? null)}</div>
                    <div>Gross realized PnL: {formatUsdSigned(btc5mSimState?.grossRealizedPnlUsd ?? null)}</div>
                    <div>Net unrealized PnL: {formatUsdSigned(btc5mSimState?.unrealizedPnlUsd ?? null)}</div>
                    <div>Gross unrealized PnL: {formatUsdSigned(btc5mSimState?.grossUnrealizedPnlUsd ?? null)}</div>
                    <div>Session equity: {formatUsdValue(btc5mSimState?.sessionEquityUsd ?? null)}</div>
                    <div>Trades: {btc5mSimState?.trades ?? 0} | Wins: {btc5mSimState?.wins ?? 0} | Losses: {btc5mSimState?.losses ?? 0} | Win rate: {formatPercentSigned(btc5mSimState?.winRate ?? null)}</div>
                    <div>Avg hold: {formatDurationMs(btc5mSimState?.analytics?.avgHoldTimeMs ?? null)} | Max drawdown: {formatUsdValue(btc5mSimState?.analytics?.maxDrawdownUsd ?? null)}</div>
                  </div>
                </section>

                <section className="btc5m-card">
                  <div className="btc5m-card-title">Simulated position</div>
                  {!btc5mSimState?.openPosition ? (
                    <p className="status status-muted btc5m-note">No simulated position is open right now.</p>
                  ) : (
                    <>
                      <div className="btc5m-sim-position-head">
                        <strong>{btc5mSimState.openPosition.side === "up" ? "Up" : "Down"} to win</strong>
                      </div>
                      <div className="btc5m-rule-list">
                        <div>Stake: {formatUsdValue(btc5mSimState.openPosition.stakeUsd)}</div>
                        <div>Total entry cost: {formatUsdValue(btc5mSimState.openPosition.totalEntryCostUsd)}</div>
                        <div>Entry fee: {formatUsdValue(btc5mSimState.openPosition.entryFeeUsd)}</div>
                        <div>To win: {formatUsdValue(btc5mSimState.openPosition.toWinUsd)}</div>
                        <div>Avg. Price: {formatMarketPrice(btc5mSimState.openPosition.entryPrice)}</div>
                        <div>Live price: {formatMarketPrice(btc5mSimState.openPosition.currentPrice)}</div>
                        <div>Shares: {formatPosNum(btc5mSimState.openPosition.shares)}</div>
                        <div>Gross exit value: {formatUsdValue(btc5mSimState.openPosition.grossExitProceedsUsd)}</div>
                        <div>Net exit value: {formatUsdValue(btc5mSimState.openPosition.netExitProceedsUsd)}</div>
                        <div>Gross unrealized: {formatUsdSigned(btc5mSimState.openPosition.grossPnlUsd)}</div>
                        <div>Net unrealized: {formatUsdSigned(btc5mSimState.openPosition.unrealizedPnlUsd)}</div>
                        <div>Hold time: {formatDurationMs(Date.now() - btc5mSimState.openPosition.openedAt)}</div>
                        <div>Target / max loss: {formatUsdValue(btc5mSimState.openPosition.targetProfitUsd)} / {formatUsdValue(btc5mSimState.openPosition.maxLossUsd)}</div>
                        <div>Spread at entry: {formatBpsValue(btc5mSimState.openPosition.spreadBpsAtEntry)}</div>
                        <div>Time to expiry at entry: {formatDurationMs(btc5mSimState.openPosition.enteredAtTimeToExpiryMs)}</div>
                        <div>BTC 1m / 3m / 5m: {formatPercentSigned(btc5mSimState.openPosition.entrySignals.btcMove1mPct)} / {formatPercentSigned(btc5mSimState.openPosition.entrySignals.btcMove3mPct)} / {formatPercentSigned(btc5mSimState.openPosition.entrySignals.btcMove5mPct)}</div>
                        <div>Book move / spread: {formatBpsValue(btc5mSimState.openPosition.entrySignals.bookMoveBps)} / {formatBpsValue(btc5mSimState.openPosition.entrySignals.spreadBps)}</div>
                      </div>
                      <p className="status status-muted btc5m-note">
                        The simulator continuously reprices the live exit, then exits on net TP, stop-loss, BTC reversal, timeout, late flatten, or settlement.
                      </p>
                    </>
                  )}
                </section>

                <section className="btc5m-card">
                  <div className="btc5m-chart-head">
                    <span>Session summary</span>
                    <span className={(btc5mSimState?.sessionEquityUsd ?? 0) >= (btc5mSimState?.bankrollUsd ?? 0) ? "pnl-pos" : "pnl-neg"}>
                      {formatUsdSigned((btc5mSimState?.sessionEquityUsd ?? 0) - (btc5mSimState?.bankrollUsd ?? 0))}
                    </span>
                  </div>
                  <div className="btc5m-rule-list">
                    <div>Started with: {formatUsdValue(btc5mSimState?.bankrollUsd ?? null)}</div>
                    <div>Current equity: {formatUsdValue(btc5mSimState?.sessionEquityUsd ?? null)}</div>
                    <div>Total staked: {formatUsdValue(btc5mSimState?.totalStakedUsd ?? null)}</div>
                    <div>Last market: {btc5mSimState?.lastMarketSlug ?? "n/a"}</div>
                    <div>Peak equity: {formatUsdValue(btc5mSimState?.analytics?.peakEquityUsd ?? null)}</div>
                    <div>Up net PnL: {formatUsdSigned(btc5mSimState?.analytics?.pnlByDirection?.up?.netPnlUsd ?? null)} | Down net PnL: {formatUsdSigned(btc5mSimState?.analytics?.pnlByDirection?.down?.netPnlUsd ?? null)}</div>
                    <div>Spread &lt;150 bps: {formatUsdSigned(btc5mSimState?.analytics?.pnlBySpreadBucket?.lt_150?.netPnlUsd ?? null)} | 150-300: {formatUsdSigned(btc5mSimState?.analytics?.pnlBySpreadBucket?.["150_300"]?.netPnlUsd ?? null)}</div>
                    <div>Early / Mid / Late: {formatUsdSigned(btc5mSimState?.analytics?.pnlByTimeBucket?.early?.netPnlUsd ?? null)} / {formatUsdSigned(btc5mSimState?.analytics?.pnlByTimeBucket?.mid?.netPnlUsd ?? null)} / {formatUsdSigned(btc5mSimState?.analytics?.pnlByTimeBucket?.late?.netPnlUsd ?? null)}</div>
                  </div>
                </section>

                <section className="btc5m-card">
                  <div className="btc5m-chart-head">
                    <span>Closed simulated trades</span>
                    <span className="status-muted">{btc5mSimState?.closedTrades.length ?? 0} trades</span>
                  </div>
                  <div className="btc5m-sim-log">
                    {(btc5mSimState?.closedTrades ?? []).length === 0 ? (
                      <div className="status status-muted">No closed simulated trades yet.</div>
                    ) : (
                      btc5mSimState!.closedTrades.map((trade, index) => (
                        <div key={`${trade.closedAt}-${index}`} className={`btc5m-sim-log-entry ${trade.result === "win" ? "success" : "warn"}`}>
                          <span>[{new Date(trade.closedAt).toLocaleTimeString()}] {trade.marketSlug}</span>
                          <span>
                            {trade.side.toUpperCase()} | {trade.exitReason} | gross {formatUsdValue(trade.grossProceedsUsd)} | net {formatUsdValue(trade.proceedsUsd)} | {formatUsdSigned(trade.pnlUsd)} | hold {formatDurationMs(trade.holdTimeMs)}
                          </span>
                          <span>
                            entry {formatMarketPrice(trade.entryPrice)} to exit {formatMarketPrice(trade.exitPrice)} | spread {formatBpsValue(trade.spreadBpsAtEntry)} to {formatBpsValue(trade.spreadBpsAtExit)} | btc {formatPercentSigned(trade.entrySignals.btcMove1mPct)} to {formatPercentSigned(trade.exitSignals.btcMove1mPct)}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </section>

                <section className="btc5m-card btc5m-span-2">
                  <div className="btc5m-chart-head">
                    <span>Simulation log</span>
                    <span className="status-muted">{btc5mSimState?.logs.length ?? 0} entries</span>
                  </div>
                  <div className="btc5m-sim-log">
                    {(btc5mSimState?.logs ?? []).length === 0 ? (
                      <div className="status status-muted">No simulation activity yet.</div>
                    ) : (
                      btc5mSimState!.logs.map((log, index) => (
                        <div key={`${log.timestamp}-${index}`} className={`btc5m-sim-log-entry ${log.type}`}>
                          <span>[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                          <span>{log.message}</span>
                        </div>
                      ))
                    )}
                  </div>
                </section>
              </div>
            )}
          </section>
        </main>
      ) : activeTab === "scanner" as any ? (
        <main className="layout layout-single">
          <section className="panel">
            <div className="card">
              <div className="card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                  <span className="badge badge-success">NEW FEATURE</span>
                  <h2>Blockchain Scanner</h2>
                </div>
                <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px", fontSize: "13px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", color: scannerStatus?.listenerConnected ? "#10b981" : "#f59e0b" }}>
                      <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: scannerStatus?.listenerConnected ? "#10b981" : "#f59e0b", display: "inline-block" }}></span>
                      {scannerStatus?.listenerConnected ? "Listener Connected" : "Listener Status Unknown"}
                    </div>
                    <div style={{ color: "var(--text-muted)", fontSize: "12px" }}>
                      Last heartbeat: {scannerStatus?.lastListenerHeartbeatAt ? new Date(scannerStatus.lastListenerHeartbeatAt).toLocaleTimeString() : "n/a"}
                    </div>
                    <div style={{ color: "var(--text-muted)", fontSize: "12px" }}>
                      Last live market: {scannerStatus?.lastScannerEventAt ? new Date(scannerStatus.lastScannerEventAt).toLocaleTimeString() : "none yet"}
                    </div>
                  </div>
                  <button 
                    className="button button-secondary" 
                    style={{ padding: "4px 10px", fontSize: "12px" }}
                    onClick={() => {
                      const mockEvent = {
                        type: "scanner_event",
                        conditionId: "0x" + Math.random().toString(16).slice(2, 66).padEnd(64, '0'),
                        oracle: "0x4D97DCd97eC945f40cF65F87097CAe4B54fafa76",
                        questionId: "0x" + Math.random().toString(16).slice(2, 66).padEnd(64, '0'),
                        outcomeSlotCount: "2",
                        txHash: "0x" + Math.random().toString(16).slice(2, 66).padEnd(64, '0'),
                        blockNumber: 654321,
                        timestamp: Date.now()
                      };
                      setScannerEvents(prev => [mockEvent as any, ...prev].slice(0, 50));
                      addToast("success", "Test Event Generated", "Local mock event added to list.");
                    }}
                  >
                    Test UI
                  </button>
                </div>
              </div>
              <div className="card-body">
                <p style={{ marginBottom: "20px", color: "var(--text-muted)" }}>
                  Real-time monitoring of the Polymarket CTF contract on Polygon. 
                  Detecting new markets at the moment of creation.
                </p>

                {scannerEvents.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "40px", border: "1px dashed var(--border-color)", borderRadius: "12px" }}>
                    <div style={{ fontSize: "24px", marginBottom: "10px" }}>📡</div>
                    <div style={{ color: "var(--text-muted)" }}>
                      No recent market creation events found yet. The list fills from recent blockchain history and live listener updates.
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                    {scannerEvents.map((ev, idx) => (
                      <div key={idx} className="card" style={{ padding: "16px", border: "1px solid var(--border-color)", background: "rgba(255,255,255,0.02)" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
                          <span style={{ fontWeight: "bold", color: "var(--primary-color)" }}>
                            {ev.source === "gamma-recent" ? "Recent Market" : "🔥 New Market Detected"}
                          </span>
                          <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>{new Date(ev.timestamp).toLocaleTimeString()}</span>
                        </div>
                        {ev.title ? (
                          <div style={{ marginBottom: "10px" }}>
                            <div style={{ fontWeight: 600 }}>{ev.title}</div>
                            {ev.slug ? (
                              <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "4px" }}>{ev.slug}</div>
                            ) : null}
                          </div>
                        ) : null}
                        <div style={{ fontSize: "14px", display: "grid", gridTemplateColumns: "120px 1fr", gap: "8px" }}>
                          <span style={{ color: "var(--text-muted)" }}>Condition ID:</span>
                          <code style={{ background: "rgba(0,0,0,0.2)", padding: "2px 4px", borderRadius: "4px" }}>{ev.conditionId}</code>
                          
                          <span style={{ color: "var(--text-muted)" }}>Question ID:</span>
                          <code style={{ background: "rgba(0,0,0,0.2)", padding: "2px 4px", borderRadius: "4px" }}>{ev.questionId}</code>

                          <span style={{ color: "var(--text-muted)" }}>Tx Hash:</span>
                          {ev.txHash ? (
                            <a 
                              href={`https://polygonscan.com/tx/${ev.txHash}`} 
                              target="_blank" 
                              rel="noreferrer" 
                              style={{ color: "#3b82f6", textDecoration: "none" }}
                            >
                              {ev.txHash.slice(0, 20)}...
                            </a>
                          ) : (
                            <span style={{ color: "var(--text-muted)" }}>Not available from fallback history</span>
                          )}
                        </div>
                        <div style={{ marginTop: "12px", display: "flex", gap: "8px" }}>
                          <span className="badge badge-info">Slots: {ev.outcomeSlotCount}</span>
                          <span className="badge badge-secondary">Block: {ev.blockNumber || "n/a"}</span>
                          <span className="badge badge-secondary">{ev.source === "gamma-recent" ? "Gamma History" : "Live Chain"}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>
        </main>
      ) : activeTab === "positions" ? (
        <main className="layout layout-single">
          {viewingMarketSlug ? (
            <section className="panel positions-panel">
              <div className="panel-head">
                <div>
                  <p className="section-kicker">Market Details</p>
                  <h2>{marketDetails?.question ?? "Loading..."}</h2>
                </div>
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={() => setViewingMarketSlug(null)}
                >
                  Back to Positions
                </button>
              </div>
              {loadingMarketDetails ? (
                <p className="status">Loading market details...</p>
              ) : marketDetailsError ? (
                <p className="status">{marketDetailsError}</p>
              ) : marketDetails ? (
                <div className="market-details-content">
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: "20px",
                    }}
                  >
                    <div>
                      <h3 style={{ margin: 0 }}>Market Analytics</h3>
                      {!botActive && (marketDetails?.extractedData?.t === null || marketDetails?.extractedData?.t === undefined) && (
                        <p style={{ color: "var(--rose)", fontSize: "0.75rem", margin: "4px 0 0 0" }}>
                          ⚠ Target temperature not found. AI extraction failed.
                        </p>
                      )}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "10px",
                      }}
                    >
                      {botActive && lastPollTime && (
                        <span
                          style={{ fontSize: "0.75rem", color: "var(--muted)" }}
                        >
                          Last checked:{" "}
                          {new Date(lastPollTime).toLocaleTimeString()} (Next in
                          ~5 min)
                        </span>
                      )}
                      {!botActive && (
                        <label className="toggle-container">
                          <div className="switch">
                            <input 
                              type="checkbox" 
                              checked={expectHigher} 
                              onChange={(e) => setExpectHigher(e.target.checked)}
                            />
                            <span className="slider"></span>
                          </div>
                          <span className="toggle-label">Expect higher temp (Hold through target)</span>
                        </label>
                      )}
                      <button
                        type="button"
                        className={`button ${botActive ? "button-secondary" : "button-primary"}`}
                        onClick={toggleBot}
                        disabled={botLoading || (!botActive && (marketDetails?.extractedData?.t === null || marketDetails?.extractedData?.t === undefined))}
                        title={!botActive && (marketDetails?.extractedData?.t === null || marketDetails?.extractedData?.t === undefined) ? "Cannot activate: Target temperature not found in market details" : ""}
                      >
                        {botLoading
                          ? "..."
                          : botActive
                            ? "Deactivate Bot"
                            : "Activate Bot"}
                      </button>
                    </div>
                  </div>

                  {botLogs.length > 0 && (
                    <div
                      style={{
                        backgroundColor: "rgba(0,0,0,0.2)",
                        borderRadius: "8px",
                        padding: "10px",
                        marginBottom: "20px",
                        fontSize: "0.8rem",
                        maxHeight: "120px",
                        overflowY: "auto",
                        border: "1px solid var(--border)",
                      }}
                    >
                      <div
                        style={{
                          fontWeight: "bold",
                          marginBottom: "5px",
                          color: "var(--muted)",
                        }}
                      >
                        Activity Log
                      </div>
                      {botLogs.map((log, i) => (
                        <div
                          key={i}
                          style={{
                            marginBottom: "4px",
                            color:
                              log.type === "warn"
                                ? "#ffca28"
                                : log.type === "error"
                                  ? "#f44336"
                                  : log.type === "success"
                                    ? "#66bb6a"
                                    : "inherit",
                          }}
                        >
                          <span
                            style={{
                              color: "var(--muted)",
                              marginRight: "8px",
                            }}
                          >
                            [{new Date(log.timestamp).toLocaleTimeString()}]
                          </span>
                          {log.message}
                        </div>
                      ))}
                    </div>
                  )}

                  {(() => {
                    const activePositions =
                      positionsPayload?.positions.filter(
                        (p) => p.slug === viewingMarketSlug,
                      ) || [];
                    if (activePositions.length === 0) return null;
                    return (
                      <article
                        className="market-positions"
                        style={{ marginBottom: "20px" }}
                      >
                        <span
                          style={{
                            color: "var(--muted)",
                            fontSize: "0.82rem",
                            display: "block",
                            marginBottom: "8px",
                          }}
                        >
                          Your Position(s)
                        </span>
                        <div className="positions-table-wrap">
                          <table className="positions-table">
                            <thead>
                              <tr>
                                <th>Outcome</th>
                                <th>Size</th>
                                <th>Avg</th>
                                <th>Mark</th>
                                <th>Value</th>
                                <th>PnL</th>
                                <th>Ends</th>
                                <th style={{ width: "80px" }}>Action</th>
                              </tr>
                            </thead>
                            <tbody>
                              {activePositions.map((row, index) => {
                                const isSelling = sellingTokenId === row.asset;
                                const pendingSell = getPendingSellState(row.asset);
                                return (
                                <tr key={index}>
                                  <td>
                                    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                                      <span>{row.outcome ?? "—"}</span>
                                      {pendingSell ? renderPendingSellBadge(pendingSell) : null}
                                    </div>
                                  </td>
                                  <td>{formatPosNum(row.size)}</td>
                                  <td>{formatPosNum(row.avgPrice)}</td>
                                  <td>{formatPosNum(row.curPrice)}</td>
                                  <td>{formatPosNum(row.currentValue)}</td>
                                  <td>
                                    {row.cashPnl != null ? (
                                      <span
                                        className={
                                          row.cashPnl >= 0
                                            ? "pnl-pos"
                                            : "pnl-neg"
                                        }
                                      >
                                        {row.cashPnl >= 0 ? "+" : ""}
                                        {row.cashPnl.toFixed(2)}
                                        {row.percentPnl != null
                                          ? ` (${row.percentPnl >= 0 ? "+" : ""}${row.percentPnl.toFixed(1)}%)`
                                          : ""}
                                      </span>
                                    ) : (
                                      "—"
                                    )}
                                  </td>
                                  <td className="positions-date">
                                    {row.endDate
                                      ? formatPosDate(row.endDate)
                                      : "—"}
                                  </td>
                                  <td>
                                    {row.asset ? (
                                      <button
                                        type="button"
                                        className="button button-small sell-btn"
                                        disabled={isSelling || sellingTokenId !== null}
                                        onClick={() =>
                                          confirmManualSell(
                                            viewingMarketSlug!,
                                            row.asset!,
                                            row.outcome ?? "?",
                                            row.size ?? 0
                                          )
                                        }
                                        title={`Manually sell ${row.size ?? ""} ${row.outcome ?? ""} shares at market price`}
                                      >
                                        {isSelling ? "…" : "Sell"}
                                      </button>
                                    ) : "—"}
                                  </td>
                                </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </article>
                    );
                  })()}

                  <article className="market-description">
                    <span>Rules / Context</span>
                    <div
                      dangerouslySetInnerHTML={{
                        __html: marketDetails.description,
                      }}
                    />
                  </article>

                  {marketDetails.extractedData && (
                    <article
                      className="market-extracted-data"
                      style={{ marginTop: "20px" }}
                    >
                      <span>AI Extracted Data (Groq)</span>
                      <div
                        style={{
                          display: "flex",
                          gap: "15px",
                          marginBottom: "12px",
                          marginTop: "8px",
                        }}
                      >
                        {marketDetails.extractedData.url && (
                          <a
                            href={marketDetails.extractedData.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-link"
                          >
                            Polymarket Event ↗
                          </a>
                        )}
                        {marketDetails.extractedData.res_source && (
                          <a
                            href={marketDetails.extractedData.res_source}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-link"
                          >
                            Weather Source ↗
                          </a>
                        )}
                      </div>
                      {marketDetails.extractedData.timezone && (
                        <div
                          style={{
                            padding: "10px",
                            backgroundColor: "rgba(0,0,0,0.15)",
                            borderRadius: "6px",
                            display: "inline-block",
                            border: "1px solid var(--border)",
                            marginBottom: "12px",
                          }}
                        >
                          <span style={{ color: "var(--muted)", marginRight: "8px" }}>
                            Local Time ({marketDetails.extractedData.city}):
                          </span>
                          <span style={{ fontWeight: "600", color: "#66bb6a" }}>
                            {new Date().toLocaleString("en-GB", {
                              timeZone: marketDetails.extractedData.timezone,
                              dateStyle: "medium",
                              timeStyle: "short",
                              hour12: false,
                            })}
                          </span>
                        </div>
                      )}
                      <pre className="result-json">
                        {JSON.stringify(marketDetails.extractedData, null, 2)}
                      </pre>
                    </article>
                  )}

                  {loadingHistory && (
                    <p className="status" style={{ marginTop: "20px" }}>
                      Loading station history...
                    </p>
                  )}
                  {historyError && (
                    <p className="status-muted" style={{ marginTop: "20px" }}>
                      Error loading history: {historyError}
                    </p>
                  )}
                  {stationHistory && stationHistory.length > 0 && (
                    <div className="weather-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px", marginTop: "20px" }}>
                      <article className="market-history">
                        <span style={{ color: "var(--muted)", fontSize: "0.82rem" }}>
                          Station History ({marketDetails.extractedData.station_code})
                        </span>
                        <div className="positions-table-wrap" style={{ maxHeight: "300px", overflowY: "auto" }}>
                          <table className="positions-table">
                            <thead>
                              <tr>
                                <th>Time</th>
                                <th>Temp (°{marketDetails.extractedData.t_sys || "C"})</th>
                              </tr>
                            </thead>
                            <tbody>
                              {stationHistory
                                .filter((obs: any) => {
                                  const targetDayStr = marketDetails.extractedData.day;
                                  if (!targetDayStr) return true;
                                  const tz = marketDetails.extractedData.timezone || "UTC";
                                  const obsDayStr = new Date(obs.obsTime * 1000).toLocaleDateString("en-CA", { timeZone: tz });
                                  return obsDayStr === targetDayStr;
                                })
                                .map((obs: any, index: number) => (
                                  <tr key={index}>
                                    <td style={{ fontSize: "0.75rem" }}>
                                      {new Date(obs.obsTime * 1000).toLocaleTimeString("en-GB", { 
                                        timeZone: marketDetails.extractedData.timezone || "UTC",
                                        hour: "2-digit", minute: "2-digit",
                                        hour12: false 
                                      })}
                                    </td>
                                    <td style={{ fontWeight: "600" }}>
                                      {marketDetails.extractedData.t_sys === "F"
                                        ? ((obs.temp * 9) / 5 + 32).toFixed(1)
                                        : obs.temp}
                                    </td>
                                  </tr>
                                ))}
                            </tbody>
                          </table>
                        </div>
                      </article>

                      <article className="market-history forecast-panel">
                        <span style={{ color: "var(--mint)", fontSize: "0.82rem" }}>
                          Hourly Forecast (Open-Meteo)
                        </span>
                        <div className="positions-table-wrap" style={{ maxHeight: "300px", overflowY: "auto" }}>
                          <table className="positions-table">
                            <thead>
                              <tr>
                                <th>Time</th>
                                <th>Forecast (°{marketDetails.extractedData.t_sys || "C"})</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(() => {
                                const tz = marketDetails?.extractedData?.timezone || "UTC";
                                const nowInCity = new Date().toLocaleString("en-CA", { timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit" });
                                const currentHourStr = nowInCity.split(":")[0];
                                const targetDay = marketDetails?.extractedData?.day;
                                
                                return hourlyForecast
                                  ?.filter(p => !targetDay || p.time.includes(targetDay))
                                  .filter(p => parseInt(p.time.slice(11, 13)) >= parseInt(currentHourStr))
                                  .map((point, index) => {
                                    const hourStr = point.time.slice(11, 13);
                                    const isCurrent = hourStr === currentHourStr;
                                    
                                    return (
                                      <tr 
                                        key={index} 
                                        style={{ 
                                          background: isCurrent ? "rgba(0, 255, 163, 0.1)" : "transparent",
                                          borderLeft: isCurrent ? "2px solid var(--mint)" : "2px solid transparent"
                                        }}
                                      >
                                        <td style={{ fontSize: "0.75rem", fontWeight: isCurrent ? "700" : "400" }}>
                                          {point.time.slice(11, 16)} {isCurrent ? "◀ now" : ""}
                                        </td>
                                        <td style={{ color: "var(--mint)", fontWeight: "600" }}>
                                          {point.temp.toFixed(1)}
                                        </td>
                                      </tr>
                                    );
                                  });
                              })()}
                              {!loadingHourly && (!hourlyForecast || hourlyForecast.length === 0) && (
                                <tr>
                                  <td colSpan={2} style={{ textAlign: "center", padding: "20px", color: "var(--muted)" }}>
                                    No forecast data available from API
                                  </td>
                                </tr>
                              )}
                              {!loadingHourly && hourlyForecast && hourlyForecast.length > 0 && hourlyForecast.filter(p => p.time.includes(marketDetails?.extractedData?.day || "")).length === 0 && (
                                <tr>
                                  <td colSpan={2} style={{ textAlign: "center", padding: "10px", color: "var(--gold)", fontSize: "0.75rem" }}>
                                    Found {hourlyForecast.length} points but none match {marketDetails?.extractedData?.day}. 
                                    First point: {hourlyForecast[0]?.time}
                                  </td>
                                </tr>
                              )}
                              {loadingHourly && (
                                <tr><td colSpan={2} style={{ textAlign: "center", padding: "20px", color: "var(--muted)" }}>Loading forecast...</td></tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      </article>
                    </div>
                  )}
                </div>
              ) : null}
            </section>
          ) : (
            <section className="panel positions-panel">
              <div className="panel-head">
                <div>
                  <p className="section-kicker">Portfolio</p>
                  <h2>Open positions</h2>
                </div>
                <button
                  className={`button button-secondary ${isRefreshing ? "refreshing-pulse" : ""}`}
                  type="button"
                  onClick={() => void loadPositions()}
                  disabled={loadingPositions}
                >
                  {loadingPositions ? "..." : "Refresh"}
                  {isRefreshing && <span className="spinner-dot" />}
                </button>
              </div>
              <p className="status status-muted positions-hint">
                Holdings (outcome shares) from Polymarket — not the same as open
                limit orders on the CLOB.
              </p>
              <p className="status status-muted">
                {positionsPayload?.user
                  ? `Wallet: ${shortenAddress(positionsPayload.user)} (${
                      positionsPayload.wallet_source === "funder"
                        ? "POLYMARKET_FUNDER_ADDRESS"
                        : "signer EOA"
                    })`
                  : "Set POLYMARKET_PRIVATE_KEY or POLYMARKET_FUNDER_ADDRESS in backend .env to load positions."}
              </p>
              {positionsError ? (
                <p className="status">{positionsError}</p>
              ) : null}
              {!positionsPayload?.user ? (
                <div className="empty-state">
                  <strong>No wallet configured for positions</strong>
                  <p>
                    The API uses your Polymarket proxy (funder) address when
                    set; otherwise the signer EOA from your private key.
                  </p>
                </div>
              ) : sortedPositions.length === 0 ? (
                <div className="empty-state">
                  <strong>No open positions</strong>
                  <p>
                    Either you have no active shares, or the Data API returned
                    an empty list.
                  </p>
                </div>
              ) : (
                <div className="positions-grid">
                  {groupedPositions.map((group) => {
                    const today = new Date().toISOString().split('T')[0];
                    const isActual = group.date === today;
                    
                    return (
                      <div key={group.date} className="position-group">
                        <div className="position-group-title">
                          {isActual ? "Actual Today" : group.date === "Unknown" ? "No Date" : group.date}
                        </div>
                        <div className="positions-table-wrap" style={{ marginTop: 0 }}>
                          <table className="positions-table">
                            <thead>
                              <tr>
                                <th 
                                  style={{ width: "80px", cursor: "pointer" }}
                                  onClick={() => toggleSort("bot")}
                                >
                                  Bot {renderSortIcon("bot")}
                                </th>
                                <th 
                                  style={{ cursor: "pointer" }}
                                  onClick={() => toggleSort("market")}
                                >
                                  Market {renderSortIcon("market")}
                                </th>
                                <th 
                                  style={{ cursor: "pointer" }}
                                  onClick={() => toggleSort("avg")}
                                >
                                  Avg → Now {renderSortIcon("avg")}
                                </th>
                                <th 
                                  style={{ cursor: "pointer" }}
                                  onClick={() => toggleSort("traded")}
                                >
                                  Traded {renderSortIcon("traded")}
                                </th>
                                <th 
                                  style={{ cursor: "pointer" }}
                                  onClick={() => toggleSort("toWin")}
                                >
                                  To Win {renderSortIcon("toWin")}
                                </th>
                                <th 
                                  style={{ cursor: "pointer" }}
                                  onClick={() => toggleSort("value")}
                                >
                                  Value {renderSortIcon("value")}
                                </th>
                                <th 
                                  style={{ cursor: "pointer" }}
                                  onClick={() => toggleSort("ends")}
                                >
                                  Ends {renderSortIcon("ends")}
                                </th>
                                <th style={{ width: "80px" }}>Actions</th>
                              </tr>
                            </thead>
                            <tbody>
                              {group.positions.map((row, index) => {
                                const key = `${row.conditionId ?? row.slug ?? "row"}-${row.outcome ?? ""}-${index}`;
                                const isBotActive = !!(
                                  row.slug && activeBotSlugs.includes(row.slug)
                                );
                                const pendingSell = getPendingSellState(row.asset);
                                return (
                                  <tr key={key}>
                                    <td>
                                      {isBotActive ? (
                                        <span className="status-badge on">
                                          <span className="indicator-dot pulse" />
                                          ON
                                        </span>
                                      ) : (
                                        <span className="status-badge off">
                                          <span className="indicator-dot" />
                                          OFF
                                        </span>
                                      )}
                                    </td>
                                    <td style={{ minWidth: "220px" }}>
                                      <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
                                        {row.icon ? (
                                          <img 
                                            src={row.icon} 
                                            alt="" 
                                            style={{ width: "32px", height: "32px", borderRadius: "4px", marginTop: "2px" }} 
                                          />
                                        ) : (
                                          <div style={{ width: "32px", height: "32px", borderRadius: "4px", backgroundColor: "rgba(255,255,255,0.05)", marginTop: "2px" }} />
                                        )}
                                        <div>
                                          {row.slug ? (
                                            <button
                                              type="button"
                                              className="positions-link button-clear"
                                              style={{ fontWeight: "600", fontSize: "0.85rem", marginBottom: "4px", display: "block" }}
                                              onClick={() => void loadMarketDetails(row.slug!)}
                                            >
                                              {row.title ?? row.slug ?? "—"}
                                            </button>
                                          ) : (
                                            <span style={{ fontWeight: "600", fontSize: "0.85rem", marginBottom: "4px", display: "block" }}>
                                              {row.title ?? row.slug ?? "—"}
                                            </span>
                                          )}
                                          <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.75rem" }}>
                                            <span style={{ 
                                              padding: "2px 6px", 
                                              borderRadius: "3px", 
                                              backgroundColor: row.outcome === "Yes" ? "rgba(114, 221, 188, 0.12)" : "rgba(255, 141, 141, 0.12)",
                                              color: row.outcome === "Yes" ? "var(--mint)" : "var(--rose)",
                                              fontWeight: "bold"
                                            }}>
                                              {row.outcome} {row.avgPrice ? (row.avgPrice * 100).toFixed(0) : ""}¢
                                            </span>
                                            <span style={{ color: "var(--muted)" }}>
                                              {formatPosNum(row.size)} shares
                                            </span>
                                            {pendingSell ? renderPendingSellBadge(pendingSell) : null}
                                          </div>
                                        </div>
                                      </div>
                                    </td>
                                    <td style={{ whiteSpace: "nowrap" }}>
                                      <span style={{ color: "var(--muted)" }}>
                                        {((row.avgPrice ?? 0) * 100).toFixed(0)}¢
                                      </span>
                                      <span style={{ margin: "0 6px", color: "var(--line)" }}>→</span>
                                      <span style={{ fontWeight: "600" }}>
                                        {((row.curPrice ?? 0) * 100).toFixed(0)}¢
                                      </span>
                                    </td>
                                    <td>${formatPosNum((row.size ?? 0) * (row.avgPrice ?? 0))}</td>
                                    <td>${formatPosNum(row.size)}</td>
                                    <td>
                                      <div style={{ fontWeight: "600" }}>${formatPosNum(row.currentValue)}</div>
                                      {row.cashPnl != null ? (
                                        <div
                                          className={row.cashPnl >= 0 ? "pnl-pos" : "pnl-neg"}
                                          style={{ fontSize: "0.75rem", marginTop: "2px" }}
                                        >
                                          {row.cashPnl >= 0 ? "+" : ""}
                                          ${row.cashPnl.toFixed(2)}
                                          {row.percentPnl != null
                                            ? ` (${row.percentPnl >= 0 ? "+" : ""}${row.percentPnl.toFixed(1)}%)`
                                            : ""}
                                        </div>
                                      ) : null}
                                    </td>
                                    <td className="positions-date" style={{ whiteSpace: "normal", minWidth: "90px" }}>
                                      {row.endDate ? (
                                        <div style={{ lineHeight: "1.2" }}>
                                          {formatPosDate(row.endDate).split(", ").map((part, i) => (
                                            <div key={i} style={i === 1 ? { fontSize: "0.7rem", opacity: 0.7, marginTop: "2px" } : {}}>
                                              {part}
                                            </div>
                                          ))}
                                        </div>
                                      ) : "—"}
                                    </td>
                                    <td style={{ width: "80px" }}>
                                      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                        {row.slug ? (
                                          <button
                                            type="button"
                                            className={`button button-small ${isBotActive ? "button-secondary" : "button-primary"}`}
                                            style={{
                                              padding: "4px 10px",
                                              fontSize: "0.75rem",
                                              minWidth: "60px",
                                            }}
                                            onClick={() =>
                                              void toggleBotForSlug(
                                                row.slug!,
                                                isBotActive,
                                              )
                                            }
                                            disabled={botLoading}
                                          >
                                            {isBotActive ? "Stop" : "Start"}
                                          </button>
                                ) : null}
                                {row.asset ? (
                                  <button
                                    type="button"
                                    className="button button-small sell-btn"
                                    disabled={sellingTokenId === row.asset || sellingTokenId !== null}
                                    onClick={() =>
                                      confirmManualSell(
                                        row.slug!,
                                        row.asset!,
                                        row.outcome ?? "?",
                                        row.size ?? 0
                                      )
                                    }
                                    title={`Manually sell ${row.size ?? ""} ${row.outcome ?? ""} shares at market price`}
                                  >
                                    {sellingTokenId === row.asset ? "…" : "Sell"}
                                  </button>
                                ) : null}
                                {!row.slug && !row.asset && "—"}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                        </div>
                      );
                    })}
                  </div>
                )}
            </section>
          )}

          {/* ── Event Log ── */}
          <section className="panel event-log-panel">
            <div className="panel-head">
              <div>
                <p className="section-kicker">Trade History</p>
                <h2>Event Log</h2>
              </div>
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                {eventLogLoading && <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>Refreshing…</span>}
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => void loadEventLog()}
                  style={{ fontSize: "0.75rem", padding: "4px 10px" }}
                >
                  Refresh
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  style={{ fontSize: "0.75rem", padding: "4px 10px", color: "var(--rose)" }}
                  onClick={async () => {
                    await fetch("/api/event-log", { method: "DELETE" });
                    setEventLog([]);
                  }}
                >
                  Clear
                </button>
              </div>
            </div>
            {eventLog.length === 0 ? (
              <div className="empty-state event-log-empty-state">
                <strong>No events yet</strong>
                <p>Sell operations and bot actions will appear here.</p>
              </div>
            ) : (
              <div className="positions-table-wrap">
                <table className="positions-table">
                  <thead>
                    <tr>
                      <th style={{ width: "56px" }}>Type</th>
                      <th style={{ width: "90px" }}>Trigger</th>
                      <th style={{ width: "140px" }}>Time</th>
                      <th style={{ width: "180px" }}>Market</th>
                      <th>Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {eventLog.map((entry) => (
                      <tr key={entry.id}>
                        <td>
                          <span className={`event-badge event-badge-${entry.type}`}>
                            {entry.type === "error" ? "✖ ERR" : entry.type === "warn" ? "⚠ WARN" : entry.type === "success" ? "✔ OK" : "ℹ INFO"}
                          </span>
                        </td>
                        <td>
                          <span className={`trigger-badge trigger-${entry.trigger ?? "auto"}`}>
                            {entry.trigger === "manual" ? "👤 MANUAL" : "🤖 AUTO"}
                          </span>
                        </td>
                        <td style={{ fontSize: "0.78rem", color: "var(--muted)", whiteSpace: "nowrap" }}>
                          {new Date(entry.timestamp).toLocaleString()}
                        </td>
                        <td style={{ fontSize: "0.78rem", color: "var(--muted)", wordBreak: "break-all" }}>
                          {entry.marketSlug}
                        </td>
                        <td style={{ fontSize: "0.82rem" }}>{entry.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </main>
      ) : (
        <main className="layout">
          <section className="panel">
            <div className="panel-head">
              <div>
                <p className="section-kicker">{tabTitle} Scan</p>
                <h2>{tabTitle} Discovery</h2>
              </div>
                <button
                  className="button button-secondary"
                  onClick={() =>
                    void (activeTab === "scanner"
                      ? loadScannerEvents()
                      : loadEvents(search))
                  }
                  type="button"
                >
                  Refresh
              </button>
            </div>

            <form
              className="controls"
              onSubmit={(event) => {
                event.preventDefault();
                void loadEvents(search);
              }}
            >
              <label className="search">
                <span>{tabTitle} search</span>
                <input
                  type="search"
                  placeholder={searchPlaceholder}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <button className="button button-primary" type="submit">
                Apply
              </button>
            </form>

            <p className="status">{statusText}</p>

            <div className="markets">
              {events.map((event) => {
                const isSelected = selectedEvent?.slug === event.slug;
                return (
                  <button
                    key={event.slug}
                    className={`market-card ${isSelected ? "selected" : ""}`}
                    type="button"
                    onClick={() => {
                      setSelectedEventSlug(event.slug);
                      const firstActiveMarket = event.markets.find(
                        (market) =>
                          market.active !== false && market.closed !== true,
                      );
                      setSelectedSlug(firstActiveMarket?.slug ?? "");
                      setSelectedOutcome(
                        firstActiveMarket?.outcomes[0]?.label ?? "",
                      );
                    }}
                  >
                    <span className="market-slug">{event.slug}</span>
                    <strong>{event.title}</strong>
                    <span className="market-category">
                      {event.tags.join(" / ") || "no tags"}
                    </span>
                    <span className="market-outcomes">
                      {availableLabel(event.markets.length, "market")}
                    </span>
                  </button>
                );
              })}

              {!loadingEvents && events.length === 0 ? (
                <div className="empty-state">
                  <strong>No events matched the current filters.</strong>
                  <p>{emptyStateText}</p>
                  {hasLocalFilters ? (
                    <button
                      className="button button-secondary"
                      type="button"
                      onClick={resetFilters}
                    >
                      Reset filters
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>

          <section className="panel">
            {activeTab === "crypto" ? (
              <>
                <div className="panel-head">
                  <div>
                    <p className="section-kicker">Signal Check</p>
                    <h2>Crypto Evaluation</h2>
                  </div>
                </div>

                <div className="form-stack">
                  <label>
                    <span>Selected event slug</span>
                    <input
                      type="text"
                      readOnly
                      value={selectedEvent?.slug ?? ""}
                    />
                  </label>

                  <label>
                    <span>Market</span>
                    <select
                      value={selectedSlug}
                      onChange={(event) => {
                        const nextSlug = event.target.value;
                        setSelectedSlug(nextSlug);
                        const nextMarket = availableMarkets.find(
                          (market) => market.slug === nextSlug,
                        );
                        setSelectedOutcome(
                          nextMarket?.outcomes[0]?.label ?? "",
                        );
                      }}
                    >
                      {availableMarkets.map((market) => (
                        <option key={market.marketId} value={market.slug}>
                          {market.question}
                        </option>
                      ))}
                    </select>
                  </label>

                  {selectedMarket?.description ? (
                    <article className="market-description">
                      <span>Market description</span>
                      <p>{selectedMarket.description}</p>
                    </article>
                  ) : null}

                  <label>
                    <span>Outcome</span>
                    <select
                      value={selectedOutcome}
                      onChange={(event) =>
                        setSelectedOutcome(event.target.value)
                      }
                    >
                      {(selectedMarket?.outcomes ?? []).map((outcome) => (
                        <option key={outcome.tokenId} value={outcome.label}>
                          {outcome.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label>
                    <span>Fair probability override</span>
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.01}
                      placeholder="Optional manual fair probability"
                      value={fairProbability}
                      onChange={(event) =>
                        setFairProbability(event.target.value)
                      }
                    />
                  </label>

                  <button
                    className="button button-primary"
                    type="button"
                    disabled={!selectedMarket || evaluating}
                    onClick={() => void handleEvaluate()}
                  >
                    {evaluating ? "Evaluating..." : "Evaluate edge"}
                  </button>
                </div>

                <p className="status status-muted">
                  {evaluationError
                    ? evaluationError
                    : selectedMarket
                      ? "Ready to evaluate the selected crypto market."
                      : selectedEvent
                        ? "Choose a market from the selected event."
                        : "Search and choose a crypto event to start."}
                </p>

                {evaluation ? (
                  <section className="result-card">
                    <div className="result-topline">
                      <span
                        className={`decision-badge ${evaluation.decision.should_trade ? "trade" : "pass"}`}
                      >
                        {evaluation.decision.should_trade ? "TRADE" : "PASS"}
                      </span>
                      <span className="decision-reason">
                        {evaluation.decision.reason}
                      </span>
                    </div>

                    <h3>{evaluation.market}</h3>

                    <div className="metrics">
                      <article>
                        <span>Fair probability</span>
                        <strong>
                          {formatMaybeNumber(evaluation.fair_probability)}
                        </strong>
                      </article>
                      <article>
                        <span>Model probability</span>
                        <strong>
                          {formatMaybeNumber(evaluation.model_probability)}
                        </strong>
                      </article>
                      <article>
                        <span>Best bid</span>
                        <strong>
                          {formatMaybeNumber(evaluation.best_bid)}
                        </strong>
                      </article>
                      <article>
                        <span>Best ask</span>
                        <strong>
                          {formatMaybeNumber(evaluation.best_ask)}
                        </strong>
                      </article>
                      <article>
                        <span>Spread bps</span>
                        <strong>
                          {formatMaybeNumber(evaluation.spread_bps)}
                        </strong>
                      </article>
                      <article>
                        <span>Edge bps</span>
                        <strong>
                          {formatMaybeNumber(evaluation.decision.edge_bps)}
                        </strong>
                      </article>
                    </div>

                    {evaluation.weather_analysis ? (
                      <article className="market-description">
                        <span>Weather model</span>
                        <p>
                          {evaluation.weather_analysis.city} via{" "}
                          {evaluation.weather_analysis.station} on{" "}
                          {evaluation.weather_analysis.target_date}. Bucket:{" "}
                          {evaluation.weather_analysis.bucket}. Forecast high:{" "}
                          {evaluation.weather_analysis.blended_forecast_high.toFixed(
                            2,
                          )}
                          °. Sources:{" "}
                          {evaluation.weather_analysis.sources.join(", ")}.
                          Sigma: {evaluation.weather_analysis.sigma}.
                        </p>
                      </article>
                    ) : null}

                    <pre className="result-json">
                      {JSON.stringify(evaluation, null, 2)}
                    </pre>
                  </section>
                ) : null}
              </>
            ) : (
              <>
                <div className="panel-head">
                  <div>
                    <p className="section-kicker">Weather Focus</p>
                    <h2>Weather Markets</h2>
                  </div>
                </div>
                <p className="status status-muted">
                  {selectedMarket
                    ? "Weather events are loaded. Switch to Crypto tab to run bot evaluation."
                    : "Select a weather event to inspect available markets."}
                </p>
                {selectedMarket ? (
                  <article className="market-description">
                    <span>Selected market</span>
                    <p>{selectedMarket.question}</p>
                    {selectedMarket.description ? (
                      <p>{selectedMarket.description}</p>
                    ) : null}
                  </article>
                ) : null}
              </>
            )}
          </section>
        </main>
      )}

      {/* Confirmation Modal */}
      {sellConfirmation && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3 className="modal-title">Are you sure?</h3>
            <p className="modal-body">
              You are about to sell <strong>{formatPosNum(sellConfirmation.size)}</strong> shares of{" "}
              <strong>{sellConfirmation.outcome}</strong>.
              <br /><br />
              This order will be placed as a limit sell at 0.01, effectively selling at the{" "}
              <strong>highest available price on the market</strong>.
            </p>
            <div className="modal-actions">
              <button 
                className="button button-secondary"
                onClick={() => setSellConfirmation(null)}
              >
                Cancel
              </button>
              <button 
                className="button button-primary sell-btn"
                onClick={() => void handleManualSell()}
              >
                Confirm Sell
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatMaybeNumber(value: number | null) {
  return typeof value === "number" ? value.toFixed(2) : "-";
}

function formatPercentSigned(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`
    : "-";
}

function formatBtcPrice(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
    : "-";
}

function formatCompactBtcPrice(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? `$${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}`
    : "-";
}

function formatMarketPrice(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(value * 100)}c`
    : "-";
}

function formatConfidence(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? `(${Math.round(value * 100)}%)`
    : "";
}

function formatBalance(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : value;
}

function formatMoneyValue(value: string | null | undefined) {
  return value !== null && value !== undefined ? `$${formatBalance(value)}` : "$0.00";
}

function formatUsdcValue(value: string | null | undefined) {
  return value !== null && value !== undefined ? `${formatBalance(value)} USDC` : "0.00 USDC";
}

function formatUsdValue(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(2)}` : "$0.00";
}

function formatUsdSigned(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`
    : "$0.00";
}

function formatBpsValue(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(value)} bps`
    : "-";
}

function formatDurationMs(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  if (value < 1000) {
    return `${Math.round(value)}ms`;
  }
  if (value < 60_000) {
    return `${(value / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatCountdownMs(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }

  const totalSeconds = Math.max(0, Math.floor(value / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function renderPendingSellBadge(pending: PendingSellState) {
  const className =
    pending.status === "error"
      ? "pending-sell-badge error"
      : pending.status === "filled"
        ? "pending-sell-badge filled"
        : pending.status === "partial"
          ? "pending-sell-badge partial"
          : "pending-sell-badge open";

  const label =
    pending.status === "submitting"
      ? "Submitting"
      : pending.status === "open"
        ? "Sell Open"
        : pending.status === "partial"
          ? "Partial"
          : pending.status === "filled"
            ? "Sold"
            : "Sell Error";

  const detail =
    pending.status === "partial" && pending.remainingSize !== null
      ? `${formatPosNum(pending.remainingSize)} left`
      : pending.message;

  return (
    <span className={className} title={detail ?? label}>
      <span className="indicator-dot"></span>
      {label}
      {detail ? ` · ${detail}` : ""}
    </span>
  );
}

function shortenAddress(value: string) {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function availableLabel(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatPosNum(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(2)
    : "—";
}

function formatPosDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function getEmptyStateText(search: string, activeTab: AppTab) {
  if (activeTab === "positions") {
    return "Use Weather or Crypto tabs to search events.";
  }
  if (search) {
    return `Nothing matched "${search}". Try a broader keyword or clear the search field.`;
  }

  return `Type a query to fetch matching ${activeTab} Polymarket events.`;
}

function isWeatherEvent(event: SearchEventSummary) {
  const weatherKeywords = [
    "weather",
    "temperature",
    "temp",
    "rain",
    "snow",
    "storm",
    "hurricane",
    "climate",
    "forecast",
    "nyc high temp",
    "high temp",
  ];

  return includesAnyKeyword(event, weatherKeywords);
}

function isCryptoEvent(event: SearchEventSummary) {
  const cryptoKeywords = [
    "btc",
    "bitcoin",
    "eth",
    "ethereum",
    "sol",
    "xrp",
    "doge",
    "crypto",
    "up",
    "down",
  ];
  return includesAnyKeyword(event, cryptoKeywords);
}

function includesAnyKeyword(event: SearchEventSummary, keywords: string[]) {
  const haystack = [
    event.title,
    event.slug,
    event.description,
    event.tags.join(" "),
    ...event.markets.map(
      (market) => `${market.question} ${market.slug} ${market.category}`,
    ),
  ]
    .join(" ")
    .toLowerCase();

  return keywords.some((keyword) => haystack.includes(keyword));
}
