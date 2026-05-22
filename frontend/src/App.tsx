import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import {
  getUserWebSocketAuth,
} from "./shared/api/account";
import {
  getBtc15mStatus,
  resetBtc15mBudget as resetBtc15mBudgetRequest,
  toggleBtc15mBot as toggleBtc15mBotRequest,
} from "./shared/api/btc15m";
import {
  getBtc5mStatus,
  toggleBtc5mBot as toggleBtc5mBotRequest,
} from "./shared/api/btc5m";
import {
  clearEventLog,
  getActiveBotSlugs,
  getEventLog,
} from "./shared/api/events";
import {
  activateMarketBot,
  deactivateMarketBot,
  getMarketBotStatus,
  getPositions,
  submitManualSell,
} from "./shared/api/positions";
import {
  getHourlyForecast as getHourlyForecastRequest,
  getMarketDetails as getMarketDetailsRequest,
  getStationHistory as getStationHistoryRequest,
  searchWeatherEvents,
} from "./shared/api/weather";
import { formatDateInTimeZone, formatLocalDateKey, formatTimeRemaining } from "./shared/lib/dates";
import {
  availableLabel,
  describeBtc5mStatus,
  formatBalance,
  formatBpsValue,
  formatBtc5mPrice,
  formatBtcDelta,
  formatBtcPrice,
  formatCompactBtcPrice,
  formatConfidence,
  formatCountdownMs,
  formatDurationMs,
  formatMarketPrice,
  formatMaybeNumber,
  formatMoneyValue,
  formatPosDate,
  formatPosDateParts,
  formatPosNum,
  formatPercentSigned,
  formatSignedUsd,
  formatUsd,
  formatUsdPrice,
  formatUsdSigned,
  formatUsdValue,
  shortenAddress,
} from "./shared/lib/format";
import { useToasts } from "./shared/hooks/useToasts";
import { isWeatherEvent } from "./shared/lib/guards";
import { EmptyState } from "./shared/ui/EmptyState";
import { Panel } from "./shared/ui/Panel";
import { StatusMessage } from "./shared/ui/StatusMessage";
import type { AppShellRenderProps } from "./app/AppShell";
import type { AppTab } from "./shared/types/app";
import type {
  ActivateMarketBotPayload,
  Btc15mCompletedTrade,
  Btc15mStatusPayload,
  Btc5mBotStatus,
  EventLogEntry,
  HourlyForecastEntry,
  MarketDetailsPayload,
  OpenPositionsPayload,
  PolymarketPositionRow,
  SearchEventSummary,
  StationHistoryEntry,
} from "./shared/types/api";

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

type AppProps = AppShellRenderProps;

export function App({
  activeTab,
  setTabsVisible,
  shellControls,
}: AppProps) {
  const [search, setSearch] = useState("");
  const [events, setEvents] = useState<SearchEventSummary[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [selectedEventSlug, setSelectedEventSlug] = useState<string>("");
  const [selectedSlug, setSelectedSlug] = useState<string>("");
  const [positionsPayload, setPositionsPayload] =
    useState<OpenPositionsPayload | null>(null);
  const [loadingPositions, setLoadingPositions] = useState(false);
  const [positionsError, setPositionsError] = useState<string | null>(null);
  const [activeBotSlugs, setActiveBotSlugs] = useState<string[]>([]);
  const [btc5mStatus, setBtc5mStatus] = useState<Btc5mBotStatus | null>(null);
  const [btc5mLoading, setBtc5mLoading] = useState(false);
  const [btc15mStatus, setBtc15mStatus] = useState<Btc15mStatusPayload | null>(null);
  const [btc15mLoading, setBtc15mLoading] = useState(false);
  const btc15mPrevPhaseRef = useRef<string | null>(null);
  const [btc15mFormConfig, setBtc15mFormConfig] = useState({
    workingBudgetUsd: 5,
    shares: 5,
    buyPrice: 0.25,
    trailStep: 0.05,
    trailDist: 0.02,
    trailUpdateIntervalSec: 3,
    repeatThresholdMin: 6,
    forceSellThresholdMin: 2,
    neutralZoneUsd: 5,
  });
  const { addToast, removeToast, toasts } = useToasts();
  const [eventLog, setEventLog] = useState<EventLogEntry[]>([]);
  const [eventLogLoading, setEventLogLoading] = useState(false);
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
  const previousActiveTabRef = useRef<AppTab>(activeTab);
  const [marketDetails, setMarketDetails] = useState<MarketDetailsPayload | null>(null);
  const [loadingMarketDetails, setLoadingMarketDetails] = useState(false);
  const [marketDetailsError, setMarketDetailsError] = useState<string | null>(
    null,
  );
  const appWsRef = useRef<WebSocket | null>(null);
  const portfolioSyncWsRef = useRef<WebSocket | null>(null);
  const portfolioSyncPingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const portfolioSyncReconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const portfolioSyncRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const portfolioSyncStoppedRef = useRef(false);
  const marketDetailsRequestRef = useRef(0);
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
        dateKey = formatLocalDateKey(pos.endDate) ?? pos.endDate;
      }
      if (!groupsMap[dateKey]) groupsMap[dateKey] = [];
      groupsMap[dateKey].push(pos);
    });

    const today = formatLocalDateKey(Date.now());
    
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

  const [stationHistory, setStationHistory] = useState<StationHistoryEntry[] | null>(null);
  const [hourlyForecast, setHourlyForecast] = useState<HourlyForecastEntry[] | null>(null);
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

  useEffect(() => {
    setTabsVisible(!viewingMarketSlug);

    return () => {
      setTabsVisible(true);
    };
  }, [setTabsVisible, viewingMarketSlug]);

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
      : "Positions";
  const searchPlaceholder =
    activeTab === "weather"
      ? "nyc high temp"
      : "";
  const statusText =
    activeTab === "positions"
      ? loadingPositions
        ? "Loading positions..."
        : positionsError
          ? positionsError
          : `${positionsPayload?.positions.length ?? 0} open position(s)`
      : loadingEvents
        ? "Loading events..."
        : eventsError
          ? eventsError
          : `${events.length} ${tabTitle.toLowerCase()} event(s) visible`;
  const emptyStateText = getEmptyStateText(trimmedSearch, activeTab);
  const btc15mAnalytics = btc15mStatus?.dryRun
    ? btc15mStatus?.sessionAnalytics
    : btc15mStatus?.analytics;
  const btc15mTrades: Btc15mCompletedTrade[] = btc15mStatus?.dryRun
    ? (btc15mStatus?.sessionTrades ?? [])
    : (btc15mStatus?.completedTrades ?? []);

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

  const loadEventLog = useCallback(async () => {
    try {
      setEventLogLoading(true);
      const data = await getEventLog();
      setEventLog(data.entries ?? []);
    } catch {
      // silent
    } finally {
      setEventLogLoading(false);
    }
  }, []);

  useEffect(() => {
    void shellControls.refreshAccountSummary();
    void loadEventLog();
  }, [loadEventLog, shellControls.refreshAccountSummary]);

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
        appWsRef.current = null;
        ws.onclose = null;
        ws.close();
      }
      clearTimeout(reconnectTimeout);
    };
  }, []);

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
      const botStatus = await getMarketBotStatus(slug);
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
        await deactivateMarketBot(slug);
        if (slug === viewingMarketSlug) setBotActive(false);
        setActiveBotSlugs((prev) => prev.filter((s) => s !== slug));
      } else {
        // We need market details to activate
        const details = await getMarketDetailsRequest(slug);
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
        const payload: ActivateMarketBotPayload = {
          marketSlug: slug,
          stationCode: details.extractedData.station_code,
          targetTemp: details.extractedData.t,
          targetDate: details.extractedData.day,
          tempUnit: details.extractedData.t_sys === "F" ? "F" : "C",
          outcome: pos.outcome,
          tokenId: pos.asset,
          expectHigher: expectHigher,
          timezone: details.extractedData.timezone,
        };

        await activateMarketBot(payload);
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
      const data = await submitManualSell(marketSlug, tokenId);
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
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === "btc5m") {
      void loadBtc5mStatus();
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== "btc15m") {
      return;
    }

    let cancelled = false;
    const load = async () => {
      try {
        const payload = await getBtc15mStatus();
        if (!cancelled) {
          setBtc15mStatus(payload);
        }
      } catch (error) {
        if (!cancelled) {
          addToast("error", "BTC 15m status failed", error instanceof Error ? error.message : "Unknown error");
        }
      }
    };

    void load();
    const id = setInterval(() => void load(), 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [activeTab]);

  useEffect(() => {
    if (!btc15mStatus?.config) return;
    const phase = btc15mStatus.enginePhase;
    const prevPhase = btc15mPrevPhaseRef.current;
    btc15mPrevPhaseRef.current = phase;

    // Sync form only on first load or when bot transitions running → stopped.
    // Never sync during polling while bot is stopped — that would overwrite user edits.
    const isFirstLoad = prevPhase === null;
    const justStopped = prevPhase === "running" && phase !== "running";
    if (!isFirstLoad && !justStopped) return;
    if (phase === "running") return;

    setBtc15mFormConfig({
      workingBudgetUsd: btc15mStatus.config.workingBudgetUsd,
      shares: btc15mStatus.config.shares,
      buyPrice: btc15mStatus.config.buyPrice,
      trailStep: btc15mStatus.config.trailStep,
      trailDist: btc15mStatus.config.trailDist,
      trailUpdateIntervalSec: btc15mStatus.config.trailUpdateIntervalSec,
      repeatThresholdMin: btc15mStatus.config.repeatThresholdMin,
      forceSellThresholdMin: btc15mStatus.config.forceSellThresholdMin,
      neutralZoneUsd: btc15mStatus.config.neutralZoneUsd,
    });
  }, [btc15mStatus?.enginePhase]);

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
      return;
    }

    if (selectedSlug !== selectedMarket.slug) {
      setSelectedSlug(selectedMarket.slug);
    }
  }, [selectedMarket, selectedSlug]);

  async function loadEvents(nextSearch: string) {
    setLoadingEvents(true);
    setEventsError(null);

    try {
      const payload = await searchWeatherEvents(nextSearch);
      const rawEvents = payload.events ?? [];
      const filteredEvents = rawEvents.filter((event) => isWeatherEvent(event));

      setEvents(filteredEvents);
      setSelectedEventSlug("");
      setSelectedSlug("");
    } catch (error) {
      setEventsError(
        error instanceof Error ? error.message : "Failed to load events",
      );
      setEvents([]);
    } finally {
      setLoadingEvents(false);
    }
  }

  async function loadHourlyForecast(slug: string, requestId?: number) {
    setLoadingHourly(true);
    setHourlyForecast([]); // Clear previous to avoid showing stale data
    try {
      const data = await getHourlyForecastRequest(slug);
      if (requestId !== undefined && requestId !== marketDetailsRequestRef.current) {
        return;
      }
      setHourlyForecast(data.forecast ?? []);
    } catch (err) {
      if (requestId !== undefined && requestId !== marketDetailsRequestRef.current) {
        return;
      }
      console.error("Failed to load hourly forecast:", err);
      setHourlyForecast([]);
    } finally {
      if (requestId === undefined || requestId === marketDetailsRequestRef.current) {
        setLoadingHourly(false);
      }
    }
  }

  async function loadPositions() {
    setIsRefreshing(true);
    setLoadingPositions(true);
    setPositionsError(null);
    try {
      const payload = await getPositions();
      setPositionsPayload(payload);
    } catch (error) {
      setPositionsError(
        error instanceof Error ? error.message : "Failed to load positions",
      );
      setPositionsPayload(null);
    } finally {
      setLoadingPositions(false);
      setTimeout(() => setIsRefreshing(false), 800);

      try {
        const data = await getActiveBotSlugs();
        setActiveBotSlugs(data.slugs || []);
      } catch (e) {
        console.error("Failed to fetch active bots", e);
      }
    }
  }

  async function loadBtc5mStatus() {
    setBtc5mLoading(true);
    try {
      const payload = await getBtc5mStatus();
      setBtc5mStatus(payload);
    } catch (error) {
      addToast("error", "BTC 5m status failed", error instanceof Error ? error.message : "Unknown error");
    } finally {
      setBtc5mLoading(false);
    }
  }

  async function toggleBtc5mBot() {
    const isActive = Boolean(btc5mStatus?.active);
    setBtc5mLoading(true);
    try {
      const payload = await toggleBtc5mBotRequest(isActive);
      setBtc5mStatus(payload);
      addToast(
        "success",
        isActive ? "BTC 5m bot stopped" : "BTC 5m bot started",
        isActive ? "Bot stopped." : "Bot will buy UP at 60¢ and sell all UP shares at 70¢.",
      );
    } catch (error) {
      addToast("error", "BTC 5m toggle failed", error instanceof Error ? error.message : "Unknown error");
    } finally {
      setBtc5mLoading(false);
      void loadBtc5mStatus();
    }
  }

  async function loadBtc15mStatus() {
    setBtc15mLoading(true);
    try {
      const payload = await getBtc15mStatus();
      setBtc15mStatus(payload);
    } catch (error) {
      addToast("error", "BTC 15m status failed", error instanceof Error ? error.message : "Unknown error");
    } finally {
      setBtc15mLoading(false);
    }
  }

  async function resetBtc15mBudget() {
    setBtc15mLoading(true);
    try {
      const payload = await resetBtc15mBudgetRequest();
      setBtc15mStatus(payload);
      addToast("success", "BTC 15m budget reset", "Working budget restored.");
    } catch (error) {
      addToast("error", "BTC 15m budget reset failed", error instanceof Error ? error.message : "Unknown error");
    } finally {
      setBtc15mLoading(false);
      void loadBtc15mStatus();
    }
  }

  async function toggleBtc15mBot() {
    if (btc15mLoading) {
      return;
    }

    const isActive = btc15mStatus?.enginePhase === "running";
    setBtc15mLoading(true);
    try {
      const payload = await toggleBtc15mBotRequest(isActive, btc15mFormConfig);
      setBtc15mStatus(payload);
      addToast(
        "success",
        isActive ? "BTC 15m stopped" : "BTC 15m started",
        isActive ? "Bot stopped." : "Mean-reversion cycle is watching the current 15m market.",
      );
    } catch (error) {
      addToast("error", "BTC 15m toggle failed", error instanceof Error ? error.message : "Unknown error");
    } finally {
      setBtc15mLoading(false);
      void loadBtc15mStatus();
    }
  }

  function resetFilters() {
    setSearch("");
    setEvents([]);
  }

  async function loadStationHistory(stationCode: string, requestId?: number) {
    setLoadingHistory(true);
    try {
      const data = await getStationHistoryRequest(stationCode);
      if (requestId !== undefined && requestId !== marketDetailsRequestRef.current) {
        return;
      }
      setStationHistory(data.history ?? []);
      setHistoryError(null);
    } catch (error) {
      if (requestId !== undefined && requestId !== marketDetailsRequestRef.current) {
        return;
      }
      setHistoryError(error instanceof Error ? error.message : "Failed to load station history");
    } finally {
      if (requestId === undefined || requestId === marketDetailsRequestRef.current) {
        setLoadingHistory(false);
      }
    }
  }

  async function loadMarketDetails(slug: string) {
    const requestId = marketDetailsRequestRef.current + 1;
    marketDetailsRequestRef.current = requestId;
    setViewingMarketSlug(slug);
    setLoadingMarketDetails(true);
    setMarketDetailsError(null);
    setStationHistory(null);
    setHistoryError(null);
    setHourlyForecast([]);
    try {
      const payload = await getMarketDetailsRequest(slug);
      if (requestId !== marketDetailsRequestRef.current) {
        return;
      }
      setMarketDetails(payload);

      // Load hourly forecast
      void loadHourlyForecast(slug, requestId);

      const stationCode = payload.extractedData?.station_code;
      if (stationCode) {
        void loadStationHistory(stationCode, requestId);
      }
    } catch (error) {
      if (requestId !== marketDetailsRequestRef.current) {
        return;
      }
      setMarketDetailsError(
        error instanceof Error
          ? error.message
          : "Failed to load market details",
      );
      setMarketDetails(null);
    } finally {
      if (requestId === marketDetailsRequestRef.current) {
        setLoadingMarketDetails(false);
      }
    }
  }

  // Auto-refresh: station history every 2 min, forecast every 5 min
  useEffect(() => {
    if (!viewingMarketSlug || !marketDetails) return;

    const stationCode = marketDetails.extractedData?.station_code;

    const historyInterval = stationCode
      ? setInterval(() => void loadStationHistory(stationCode, marketDetailsRequestRef.current), 2 * 60 * 1000)
      : null;

    const forecastInterval = setInterval(
      () => void loadHourlyForecast(viewingMarketSlug, marketDetailsRequestRef.current),
      5 * 60 * 1000,
    );

    return () => {
      if (historyInterval) clearInterval(historyInterval);
      clearInterval(forecastInterval);
    };
  }, [viewingMarketSlug, marketDetails]);

  useEffect(() => {
    if (previousActiveTabRef.current === activeTab) {
      return;
    }

    previousActiveTabRef.current = activeTab;
    setEvents([]);
    setSelectedEventSlug("");
    setSelectedSlug("");
    setViewingMarketSlug(null);
    setMarketDetails(null);
  }, [activeTab]);

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
      void shellControls.refreshAccountSummary();
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
      const payload = await getUserWebSocketAuth();

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
    <>
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
              onClick={() => removeToast(t.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {activeTab === "positions" ? (
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
                  {marketDetails.extractedData && (
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
                              {(() => {
                                const targetDayStr = marketDetails.extractedData.day;
                                const tz = marketDetails.extractedData.timezone || "UTC";
                                const filteredHistory = (stationHistory ?? []).filter((obs) => {
                                  if (!targetDayStr) return true;
                                  return formatDateInTimeZone(obs.obsTime * 1000, tz) === targetDayStr;
                                });

                                if (filteredHistory.length === 0) {
                                  return (
                                    <tr>
                                      <td colSpan={2} style={{ textAlign: "center", padding: "20px", color: "#ff6b81" }}>
                                        No station observations match {targetDayStr} in {tz}. This market is for another day and station data will appear when that date begins locally.
                                      </td>
                                    </tr>
                                  );
                                }

                                return filteredHistory.map((obs, index: number) => (
                                  <tr key={index}>
                                    <td style={{ fontSize: "0.75rem" }}>
                                      {new Date(obs.obsTime * 1000).toLocaleTimeString("en-GB", { 
                                        timeZone: marketDetails.extractedData?.timezone || "UTC",
                                        hour: "2-digit", minute: "2-digit",
                                        hour12: false 
                                      })}
                                    </td>
                                    <td style={{ fontWeight: "600" }}>
                                      {marketDetails.extractedData?.t_sys === "F"
                                        ? ((obs.temp * 9) / 5 + 32).toFixed(1)
                                        : obs.temp}
                                    </td>
                                  </tr>
                                ));
                              })()}
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
                                const todayInCity = formatDateInTimeZone(Date.now(), tz);
                                const isTodayTarget = Boolean(targetDay && targetDay === todayInCity);
                                
                                return hourlyForecast
                                  ?.filter(p => !targetDay || p.time.includes(targetDay))
                                  .filter((p) => {
                                    if (!isTodayTarget) {
                                      return true;
                                    }
                                    return parseInt(p.time.slice(11, 13), 10) >= parseInt(currentHourStr, 10);
                                  })
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
              <StatusMessage className="positions-hint" tone="muted">
                Holdings (outcome shares) from Polymarket — not the same as open
                limit orders on the CLOB.
              </StatusMessage>
              <StatusMessage tone="muted">
                {positionsPayload?.user
                  ? `Wallet: ${shortenAddress(positionsPayload.user)} (${ 
                      positionsPayload.wallet_source === "funder"
                        ? "POLYMARKET_FUNDER_ADDRESS"
                        : "signer EOA"
                    })`
                  : "Set POLYMARKET_PRIVATE_KEY or POLYMARKET_FUNDER_ADDRESS in backend .env to load positions."}
              </StatusMessage>
              {positionsError ? (
                <StatusMessage>{positionsError}</StatusMessage>
              ) : null}
              {!positionsPayload?.user ? (
                <EmptyState
                  description="The API uses your Polymarket proxy (funder) address when set; otherwise the signer EOA from your private key."
                  title="No wallet configured for positions"
                />
              ) : sortedPositions.length === 0 ? (
                <EmptyState
                  description="Either you have no active shares, or the Data API returned an empty list."
                  title="No open positions"
                />
              ) : (
                <div className="positions-grid">
                  {groupedPositions.map((group) => {
                    const today = formatLocalDateKey(Date.now());
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
                                          {formatPosDateParts(row.endDate).map((part, i) => (
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
                                {row.asset && row.slug ? (
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
          <Panel
            actions={
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                {eventLogLoading ? (
                  <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
                    Refreshing…
                  </span>
                ) : null}
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
                    await clearEventLog();
                    setEventLog([]);
                  }}
                >
                  Clear
                </button>
              </div>
            }
            className="event-log-panel"
            kicker="Trade History"
            title="Event Log"
          >
            {eventLog.length === 0 ? (
              <EmptyState
                className="event-log-empty-state"
                description="Sell operations and bot actions will appear here."
                title="No events yet"
              />
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
          </Panel>
        </main>
      ) : activeTab === "btc5m" ? (
        <main className="layout layout-single">
          <section className="panel btc5m-panel">
            <div className="panel-head">
              <div>
                <p className="section-kicker">Bitcoin 5-minute markets</p>
                <h2>UP 60¢ → 70¢ bot</h2>
              </div>
              <div className="btc5m-actions">
                <button className="button button-secondary" onClick={() => void loadBtc5mStatus()} type="button" disabled={btc5mLoading}>{btc5mLoading ? "..." : "Refresh"}</button>
                <button className={`button ${btc5mStatus?.active ? "button-secondary" : "button-primary"}`} onClick={() => void toggleBtc5mBot()} type="button" disabled={btc5mLoading}>{btc5mLoading ? "..." : btc5mStatus?.active ? "Stop Bot" : "Start Bot"}</button>
              </div>
            </div>

            <div className="btc5m-summary-grid">
              <article className="btc5m-stat-card"><span>Status</span><strong className={btc5mStatus?.active ? "pnl-pos" : "pnl-neg"}>{btc5mStatus?.active ? "ACTIVE" : "STOPPED"}</strong></article>
              <article className="btc5m-stat-card"><span>Mode</span><strong>{btc5mStatus?.dryRun ? "dry-run" : "live"}</strong></article>
              <article className="btc5m-stat-card"><span>Buy / Sell</span><strong>{formatBtc5mPrice(btc5mStatus?.buyPriceLimit)} / {formatBtc5mPrice(btc5mStatus?.sellPriceLimit)}</strong></article>
              <article className="btc5m-stat-card"><span>Order Size</span><strong>{formatPosNum(btc5mStatus?.orderSize)}</strong></article>
            </div>

            <StatusMessage>{describeBtc5mStatus(btc5mStatus)}</StatusMessage>

            <article className="btc5m-current-market-card">
              <div className="panel-head">
                <div>
                  <p className="section-kicker">Current market</p>
                  <h2>{btc5mStatus?.currentMarket?.question ?? "No active market found yet"}</h2>
                </div>
                {btc5mStatus?.currentMarket?.slug ? <a className="positions-link" href={`https://polymarket.com/event/${btc5mStatus.currentMarket.slug}`} target="_blank" rel="noreferrer">Open market ↗</a> : null}
              </div>
              <div className="btc5m-market-meta">
                <span>Slug: {btc5mStatus?.currentMarket?.slug ?? "—"}</span>
                <span>UP token: {btc5mStatus?.currentMarket?.upTokenId ?? "—"}</span>
                <span>Ends: {btc5mStatus?.currentMarket?.endDateIso ? formatPosDate(btc5mStatus.currentMarket.endDateIso) : "—"}</span>
                <span>Buy order: {btc5mStatus?.buyOrderId ?? "—"}</span>
                <span>Sell order: {btc5mStatus?.sellOrderId ?? "—"}</span>
                <span>Last completed: {btc5mStatus?.lastCompletedMarketSlug ?? "—"}</span>
              </div>
            </article>

            <article className="btc5m-current-market-card">
              <div className="panel-head">
                <div>
                  <p className="section-kicker">Next market</p>
                  <h2>{btc5mStatus?.nextMarket?.question ?? "No next 5-minute market queued yet"}</h2>
                </div>
                {btc5mStatus?.nextMarket?.slug ? <a className="positions-link" href={`https://polymarket.com/event/${btc5mStatus.nextMarket.slug}`} target="_blank" rel="noreferrer">Open next ↗</a> : null}
              </div>
              <div className="btc5m-market-meta">
                <span>Slug: {btc5mStatus?.nextMarket?.slug ?? "—"}</span>
                <span>Starts: {btc5mStatus?.nextMarket?.startDateIso ? formatPosDate(btc5mStatus.nextMarket.startDateIso) : "—"}</span>
                <span>Ends: {btc5mStatus?.nextMarket?.endDateIso ? formatPosDate(btc5mStatus.nextMarket.endDateIso) : "—"}</span>
                <span>Planned buy: {formatBtc5mPrice(btc5mStatus?.buyPriceLimit)} on UP</span>
                <span>Shares: {formatPosNum(btc5mStatus?.orderSize)}</span>
                <span>Min entry respected: 5 shares</span>
              </div>
            </article>

            {btc5mStatus?.lastError ? <div className="empty-state"><strong>Last error</strong><p>{btc5mStatus.lastError}</p></div> : null}

            <article className="btc5m-log-card">
              <div className="panel-head">
                <div>
                  <p className="section-kicker">Bot log</p>
                  <h2>Execution timeline</h2>
                </div>
              </div>
              {!btc5mStatus?.logs?.length ? (
                <p className="status status-muted">No BTC 5m bot events yet.</p>
              ) : (
                <div className="positions-table-wrap">
                  <table className="positions-table">
                    <thead><tr><th>Time</th><th>Type</th><th>Message</th></tr></thead>
                    <tbody>
                      {btc5mStatus.logs.map((entry, index) => (
                        <tr key={`${entry.timestamp}-${index}`}>
                          <td style={{ whiteSpace: "nowrap" }}>{new Date(entry.timestamp).toLocaleString()}</td>
                          <td><span className={`event-badge event-badge-${entry.type}`}>{entry.type.toUpperCase()}</span></td>
                          <td>{entry.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </article>
          </section>
        </main>
      ) : activeTab === "btc15m" ? (
        <main className="layout layout-single btc15m-tab">
          <section className="panel btc15m-panel">
            <div className="panel-head">
              <div>
                <p className="section-kicker">Bitcoin 15-minute markets</p>
                <h2>Contrarian 25¢ → 40¢ bot</h2>
              </div>
              <div className="btc15m-actions">
                <button className="button button-secondary" onClick={() => void loadBtc15mStatus()} type="button" disabled={btc15mLoading}>
                  {btc15mLoading ? "..." : "Refresh"}
                </button>
                <button className="button button-secondary" onClick={() => void resetBtc15mBudget()} type="button" disabled={btc15mLoading}>
                  {btc15mLoading ? "..." : "Clear budget"}
                </button>
                <button
                  className={`button ${btc15mStatus?.enginePhase === "running" ? "button-secondary" : "button-primary"}`}
                  onClick={() => void toggleBtc15mBot()}
                  type="button"
                  disabled={btc15mLoading}
                >
                  {btc15mLoading ? "..." : btc15mStatus?.enginePhase === "running" ? "Stop Bot" : "Start Bot"}
                </button>
              </div>
            </div>

            <div className="btc15m-summary-grid">
              <article className="btc15m-stat-card"><span>Engine</span><strong className={btc15mStatus?.enginePhase === "running" ? "pnl-pos" : "pnl-neg"}>{btc15mStatus?.enginePhase?.toUpperCase() ?? "STOPPED"}</strong></article>
              <article className="btc15m-stat-card"><span>Mode</span><strong>{btc15mStatus?.dryRun === false ? "LIVE" : "SIM"}</strong></article>
              <article className="btc15m-stat-card"><span>Session Start</span><strong>{formatUsd(btc15mAnalytics?.sessionStartBudgetUsd ?? btc15mStatus?.budget?.initialBudget)}</strong></article>
              <article className="btc15m-stat-card"><span>Profit Sum</span><strong className="pnl-pos">{formatUsd(btc15mAnalytics?.grossProfitUsd)}</strong></article>
              <article className="btc15m-stat-card"><span>Loss Sum</span><strong className="pnl-neg">{formatUsd(btc15mAnalytics?.grossLossUsd)}</strong></article>
              <article className="btc15m-stat-card"><span>Balance Now</span><strong>{formatUsd(btc15mStatus?.analytics?.remainingBudgetUsd ?? btc15mStatus?.budget?.availableBudget)}</strong></article>
            </div>

            <article className="btc15m-card">
              <div className="panel-head">
                <div>
                  <p className="section-kicker">Settings</p>
                  <h2>Cycle controls</h2>
                </div>
                <span className={`event-badge ${btc15mStatus?.dryRun === false ? "event-badge-error" : "event-badge-warn"}`}>
                  {btc15mStatus?.dryRun === false ? "LIVE" : "SIM"}
                </span>
              </div>
              <div className="btc15m-settings-grid">
                {([
                  ["Working budget ($)", "workingBudgetUsd", 0.5],
                  ["Shares per cycle", "shares", 1],
                  ["Buy price ($)", "buyPrice", 0.01],
                  ["Trail step ($)", "trailStep", 0.01],
                  ["Trail distance ($)", "trailDist", 0.01],
                  ["Trail update (sec)", "trailUpdateIntervalSec", 1],
                  ["Repeat threshold (min)", "repeatThresholdMin", 1],
                  ["Force-sell threshold (min)", "forceSellThresholdMin", 1],
                  ["Neutral zone ($)", "neutralZoneUsd", 1],
                ] as const).map(([label, key, step]) => (
                  <label key={key} className="btc15m-settings-field">
                    <span>{label}</span>
                    <input
                      type="number"
                      min="0"
                      step={step}
                      value={btc15mFormConfig[key]}
                      disabled={btc15mStatus?.enginePhase === "running"}
                      onChange={(event) => setBtc15mFormConfig((prev) => ({
                        ...prev,
                        [key]: Number(event.target.value),
                      }))}
                    />
                  </label>
                ))}
              </div>
              {btc15mStatus?.enginePhase === "auto_stopped" ? <p className="status status-warn">Auto-stopped after budget exhaustion.</p> : null}
              {btc15mStatus?.lastError ? <p className="status status-error">{btc15mStatus.lastError}</p> : null}
            </article>

            <article className="btc15m-card">
              <div className="panel-head">
                <div>
                  <p className="section-kicker">Live monitor</p>
                  <h2>{btc15mStatus?.market?.question ?? "Waiting for live 15m market"}</h2>
                </div>
                {btc15mStatus?.market?.slug ? <a className="positions-link" href={`https://polymarket.com/event/${btc15mStatus.market.slug}`} target="_blank" rel="noreferrer">Open market ↗</a> : null}
              </div>
              <div className="btc15m-monitor-grid">
                <span><em>Market</em><strong>{btc15mStatus?.market?.slug ?? "—"}</strong></span>
                <span><em>Time left</em><strong>{btc15mStatus?.market ? formatTimeRemaining(btc15mStatus.market.endTimeMs) : "—"}</strong></span>
                <span><em>Start BTC</em><strong>{formatBtcPrice(btc15mStatus?.marketStartBtcPrice)}</strong></span>
                <span><em>Current BTC</em><strong>{formatBtcPrice(btc15mStatus?.currentBtcPrice)}</strong></span>
                <span><em>Up Price</em><strong>{formatUsdPrice(btc15mStatus?.upPrice)}</strong></span>
                <span><em>Down Price</em><strong>{formatUsdPrice(btc15mStatus?.downPrice)}</strong></span>
                <span><em>Delta</em><strong>{formatBtcDelta(btc15mStatus)}</strong></span>
                <span><em>Cycle</em><strong>{btc15mStatus?.cycle.cyclePhase ?? "—"}</strong></span>
              </div>
              <div className="btc15m-cycle-grid">
                <div>
                  <h3>Buy order</h3>
                  {btc15mStatus?.cycle.buyOrder ? (
                    <dl><dt>Side</dt><dd>{btc15mStatus.cycle.buyOrder.bettingSide.toUpperCase()}</dd><dt>Price</dt><dd>{formatUsdPrice(btc15mStatus.cycle.buyOrder.price)}</dd><dt>Size</dt><dd>{formatPosNum(btc15mStatus.cycle.buyOrder.size)}</dd><dt>Status</dt><dd>{btc15mStatus.cycle.buyOrder.status}</dd></dl>
                  ) : <p className="status status-muted">none</p>}
                </div>
                <div>
                  <h3>Position</h3>
                  {btc15mStatus?.cycle.position ? (
                    <dl><dt>Side</dt><dd>{btc15mStatus.cycle.position.bettingSide.toUpperCase()}</dd><dt>Shares</dt><dd>{formatPosNum(btc15mStatus.cycle.position.shares)}</dd><dt>Avg</dt><dd>{formatUsdPrice(btc15mStatus.cycle.position.avgEntryPrice)}</dd><dt>Cost</dt><dd>{formatUsd(btc15mStatus.cycle.position.costBasisUsd)}</dd></dl>
                  ) : <p className="status status-muted">none</p>}
                </div>
                <div>
                  <h3>Sell order</h3>
                  {btc15mStatus?.cycle.sellOrder ? (
                    <dl><dt>Price</dt><dd>{formatUsdPrice(btc15mStatus.cycle.sellOrder.price)}</dd><dt>Size</dt><dd>{formatPosNum(btc15mStatus.cycle.sellOrder.size)}</dd><dt>Status</dt><dd>{btc15mStatus.cycle.sellOrder.status}</dd><dt>Order</dt><dd>{btc15mStatus.cycle.sellOrder.orderId ?? "—"}</dd></dl>
                  ) : <p className="status status-muted">none</p>}
                </div>
              </div>
            </article>

            <article className="btc15m-card">
              <div className="panel-head">
                <div>
                  <p className="section-kicker">Analytics</p>
                  <h2>Trade history</h2>
                </div>
              </div>
              <div className="btc15m-analytics-row">
                <span>Trades: {btc15mAnalytics?.totalTrades ?? 0}</span>
                <span>Wins: {btc15mAnalytics?.wins ?? 0}</span>
                <span>Losses: {btc15mAnalytics?.losses ?? 0}</span>
                <span>Win rate: {((btc15mAnalytics?.winRate ?? 0) * 100).toFixed(1)}%</span>
                <span>PnL: {formatUsd(btc15mAnalytics?.totalPnlUsd)}</span>
              </div>
              <div className="positions-table-wrap">
                <table className="positions-table btc15m-trade-table">
                  <thead><tr><th>Time</th><th>Market</th><th>Side</th><th>Buy</th><th>Sell</th><th>Qty</th><th>PnL</th><th>Result</th><th>Exit</th></tr></thead>
                  <tbody>
                    {btc15mTrades.slice().reverse().map((trade) => (
                      <tr key={trade.id} className={trade.result === "win" ? "btc15m-row-win" : "btc15m-row-loss"}>
                        <td>{new Date(trade.closedAt).toLocaleString()}</td>
                        <td>{trade.marketSlug.replace("btc-updown-15m-", "")}</td>
                        <td>{trade.bettingSide.toUpperCase()}</td>
                        <td>{formatUsdPrice(trade.buyPrice)}</td>
                        <td>{formatUsdPrice(trade.sellPrice)}</td>
                        <td>{formatPosNum(trade.shares)}</td>
                        <td>{formatUsd(trade.pnlUsd)}</td>
                        <td>{trade.result}</td>
                        <td>{trade.exitReason}</td>
                      </tr>
                    ))}
                    {(btc15mTrades.length === 0) ? (
                      <tr><td colSpan={9} className="status status-muted">No trades yet.</td></tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </article>
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
                onClick={() => void loadEvents(search)}
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
            <div className="panel-head">
              <div>
                <p className="section-kicker">Weather Focus</p>
                <h2>Weather Markets</h2>
              </div>
            </div>
            <p className="status status-muted">
              {selectedMarket
                ? "Weather events are loaded. Select a market to inspect available details."
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
    </>
  );
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

function getEmptyStateText(search: string, activeTab: AppTab) {
  if (activeTab === "btc5m") {
    return "BTC 5m bot waits for the next active Bitcoin Up/Down 5-minute market.";
  }
  if (activeTab === "positions") {
    return "Use the Weather view to search events.";
  }
  if (search) {
    return `Nothing matched "${search}". Try a broader keyword or clear the search field.`;
  }

  return `Type a query to fetch matching ${activeTab} Polymarket events.`;
}
