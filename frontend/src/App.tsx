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
  dry_run: boolean;
  source: "wallet-usdc";
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

type AppTab = "weather" | "crypto" | "positions" | "scanner";

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
};

type Toast = {
  id: number;
  type: "info" | "success" | "warn" | "error";
  title: string;
  message: string;
};

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
        : "Positions";
  const searchPlaceholder =
    activeTab === "weather"
      ? "nyc high temp"
      : activeTab === "crypto"
        ? "btc up"
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
            addToast("info", "New Market Detected", `Condition: ${msg.conditionId.slice(0, 10)}...`);
          }

        } catch (err) {
          console.error("WS message error", err);
        }
      };

      ws.onclose = () => {
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
          addToast("warn", "No positions", "No open positions for this market. Buy some shares first.");
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
    const { marketSlug, tokenId, outcome } = sellConfirmation;
    setSellingTokenId(tokenId);
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
      addToast(
        "success",
        "Sell submitted",
        `${outcome} — ${data.message ?? `${data.sizeToSell} shares @ 0.01`}`,
      );
      void loadPositions();
      void loadEventLog();
    } catch (err) {
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
          <span className="topbar-label">Balance</span>
          <strong className="topbar-value">
            {accountSummary?.usdc_balance
              ? `${Number(accountSummary.usdc_balance).toFixed(2)} USDC`
              : "0.00 USDC"}
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
        <nav style={{ padding: "0 30px", marginTop: "10px", display: "flex", gap: "10px" }}>
          <button className={`button ${activeTab === "positions" ? "button-primary" : "button-secondary"}`} onClick={() => handleTabSwitch("positions")}>Positions</button>
          {(import.meta as any).env?.VITE_TEST === "1" && (
            <button className={`button ${activeTab === "scanner" as any ? "button-primary" : "button-secondary"}`} onClick={() => handleTabSwitch("scanner" as any)}>Scanner</button>
          )}
        </nav>
      )}

      {activeTab === "scanner" as any ? (
        <main className="layout layout-single">
          <section className="panel">
            <div className="card">
              <div className="card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                  <span className="badge badge-success">NEW FEATURE</span>
                  <h2>Blockchain Scanner</h2>
                </div>
                <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", color: "#10b981" }}>
                    <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#10b981", display: "inline-block" }}></span>
                    Listener Active
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
                    <div style={{ color: "var(--text-muted)" }}>Waiting for new market events from blockchain...</div>
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                    {scannerEvents.map((ev, idx) => (
                      <div key={idx} className="card" style={{ padding: "16px", border: "1px solid var(--border-color)", background: "rgba(255,255,255,0.02)" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
                          <span style={{ fontWeight: "bold", color: "var(--primary-color)" }}>🔥 New Market Detected</span>
                          <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>{new Date(ev.timestamp).toLocaleTimeString()}</span>
                        </div>
                        <div style={{ fontSize: "14px", display: "grid", gridTemplateColumns: "120px 1fr", gap: "8px" }}>
                          <span style={{ color: "var(--text-muted)" }}>Condition ID:</span>
                          <code style={{ background: "rgba(0,0,0,0.2)", padding: "2px 4px", borderRadius: "4px" }}>{ev.conditionId}</code>
                          
                          <span style={{ color: "var(--text-muted)" }}>Question ID:</span>
                          <code style={{ background: "rgba(0,0,0,0.2)", padding: "2px 4px", borderRadius: "4px" }}>{ev.questionId}</code>

                          <span style={{ color: "var(--text-muted)" }}>Tx Hash:</span>
                          <a 
                            href={`https://polygonscan.com/tx/${ev.txHash}`} 
                            target="_blank" 
                            rel="noreferrer" 
                            style={{ color: "#3b82f6", textDecoration: "none" }}
                          >
                            {ev.txHash.slice(0, 20)}...
                          </a>
                        </div>
                        <div style={{ marginTop: "12px", display: "flex", gap: "8px" }}>
                          <span className="badge badge-info">Slots: {ev.outcomeSlotCount}</span>
                          <span className="badge badge-secondary">Block: {ev.blockNumber}</span>
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

                  {botActive && botLogs.length > 0 && (
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
                                return (
                                <tr key={index}>
                                  <td>{row.outcome ?? "—"}</td>
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
              ) : positionsPayload.positions.length === 0 ? (
                <div className="empty-state">
                  <strong>No open positions</strong>
                  <p>
                    Either you have no active shares, or the Data API returned
                    an empty list.
                  </p>
                </div>
              ) : (
                <div className="positions-table-wrap">
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
                        <th style={{ width: "160px" }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedPositions.map((row, index) => {
                        const key = `${row.conditionId ?? row.slug ?? "row"}-${row.outcome ?? ""}-${index}`;
                        const isBotActive = !!(
                          row.slug && activeBotSlugs.includes(row.slug)
                        );
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
                            <td className="positions-date">
                              {row.endDate ? formatPosDate(row.endDate) : "—"}
                            </td>
                            <td>
                              <div style={{ display: "flex", gap: "6px" }}>
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
              <div className="empty-state" style={{ padding: "20px 0" }}>
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

function formatBalance(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : value;
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
