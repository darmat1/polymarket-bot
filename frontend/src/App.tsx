import { useEffect, useState, useRef } from "react";

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
};

type OpenPositionsPayload = {
  user: string | null;
  wallet_source: "funder" | "eoa" | null;
  positions: PolymarketPositionRow[];
};

type AppTab = "weather" | "crypto" | "positions";

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

  const [viewingMarketSlug, setViewingMarketSlug] = useState<string | null>(
    null,
  );
  const [marketDetails, setMarketDetails] = useState<any>(null);
  const [loadingMarketDetails, setLoadingMarketDetails] = useState(false);
  const [marketDetailsError, setMarketDetailsError] = useState<string | null>(
    null,
  );

  const [stationHistory, setStationHistory] = useState<any[] | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

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

  useEffect(() => {
    void loadAccountSummary();
  }, []);

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
              alert(`Bot Emergency Exit: ${msg.reason}`);
              setBotActive(false);
            }
            void loadPositions();
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
          alert("No open positions for this market. Buy some shares first.");
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
          }),
        });
        if (slug === viewingMarketSlug) setBotActive(true);
        setActiveBotSlugs((prev) => [...prev, slug]);
      }
    } catch (err) {
      alert("Failed to toggle bot");
      console.error(err);
    } finally {
      setBotLoading(false);
    }
  }

  async function toggleBot() {
    if (!viewingMarketSlug) return;
    await toggleBotForSlug(viewingMarketSlug, botActive);
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

  async function loadMarketDetails(slug: string) {
    setViewingMarketSlug(slug);
    setLoadingMarketDetails(true);
    setMarketDetailsError(null);
    setStationHistory(null);
    setHistoryError(null);
    try {
      const response = await fetch(`/api/market-details?slug=${slug}`);
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to load market details");
      }
      setMarketDetails(payload);

      const stationCode = payload.extractedData?.station_code;
      if (stationCode) {
        setLoadingHistory(true);
        fetch(`/api/station-history?station=${stationCode}`)
          .then((res) => res.json())
          .then((data) => {
            if (data.error) {
              setHistoryError(data.error);
            } else {
              setStationHistory(data.history);
            }
          })
          .catch((e) => setHistoryError(e.message))
          .finally(() => setLoadingHistory(false));
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

  return (
    <div className="shell">
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
        </div>
      </header>

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
                    <h3 style={{ margin: 0 }}>Market Analytics</h3>
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
                      <button
                        type="button"
                        className={`button ${botActive ? "button-secondary" : "button-primary"}`}
                        onClick={toggleBot}
                        disabled={botLoading}
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
                              </tr>
                            </thead>
                            <tbody>
                              {activePositions.map((row, index) => (
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
                                </tr>
                              ))}
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
                    <article
                      className="market-history"
                      style={{ marginTop: "20px" }}
                    >
                      <span
                        style={{ color: "var(--muted)", fontSize: "0.82rem" }}
                      >
                        Station History (
                        {marketDetails.extractedData.station_code})
                      </span>
                      <div
                        className="positions-table-wrap"
                        style={{ maxHeight: "250px", overflowY: "auto" }}
                      >
                        <table className="positions-table">
                          <thead>
                            <tr>
                              <th>Date / Time</th>
                              <th>Temp (°C)</th>
                              <th>Wind</th>
                            </tr>
                          </thead>
                          <tbody>
                            {stationHistory
                              .filter((obs: any) => {
                                const targetDayStr =
                                  marketDetails.extractedData.day;
                                if (!targetDayStr) return true;
                                const targetDate = new Date(targetDayStr);
                                if (isNaN(targetDate.getTime())) return true;
                                const obsDate = new Date(obs.obsTime * 1000);
                                return (
                                  obsDate.getDate() === targetDate.getDate() &&
                                  obsDate.getMonth() === targetDate.getMonth()
                                );
                              })
                              .map((obs: any, index: number) => (
                                <tr key={index}>
                                  <td>
                                    {new Date(
                                      obs.obsTime * 1000,
                                    ).toLocaleString()}
                                  </td>
                                  <td>{obs.temp}</td>
                                  <td>
                                    {obs.wdir}° / {obs.wspd} kts
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    </article>
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
                        <th style={{ width: "100px" }}>Bot</th>
                        <th>Market</th>
                        <th>Outcome</th>
                        <th>Size</th>
                        <th>Avg</th>
                        <th>Mark</th>
                        <th>Value</th>
                        <th>PnL</th>
                        <th>Ends</th>
                        <th style={{ width: "120px" }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {positionsPayload?.positions.map((row, index) => {
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
                            <td>
                              {row.slug ? (
                                <button
                                  type="button"
                                  className="positions-link button-clear"
                                  onClick={() =>
                                    void loadMarketDetails(row.slug!)
                                  }
                                >
                                  {row.title ?? row.slug ?? "—"}
                                </button>
                              ) : (
                                (row.title ?? row.slug ?? "—")
                              )}
                            </td>
                            <td>{row.outcome ?? "—"}</td>
                            <td>{formatPosNum(row.size)}</td>
                            <td>{formatPosNum(row.avgPrice)}</td>
                            <td>{formatPosNum(row.curPrice)}</td>
                            <td>{formatPosNum(row.currentValue)}</td>
                            <td>
                              {row.cashPnl != null ? (
                                <span
                                  className={
                                    row.cashPnl >= 0 ? "pnl-pos" : "pnl-neg"
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
                              {row.endDate ? formatPosDate(row.endDate) : "—"}
                            </td>
                            <td>
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
                              ) : (
                                "—"
                              )}
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
