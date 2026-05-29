import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { getMarketBotStatus, getStationHistory, updateBotSettings } from "../../shared/api/positions";
import {
  getMarketDetails as getMarketDetailsRequest,
  clearWeatherPolymarketTriggers,
  getWeatherPolymarketEvent,
  getWeatherPolymarketTradingStatus,
  getWeatherPolymarketWeather,
  listWeatherPolymarketTriggers,
  setWeatherPolymarketTrigger,
  updateWeatherPolymarketTrigger,
} from "../../shared/api/weather";
import type { ShellControls } from "../../shared/types/app";
import type {
  MarketDetailsPayload,
  OpenPositionsPayload,
  WeatherPolymarketEventPayload,
  WeatherPolymarketMarket,
  WeatherPolymarketTrigger,
  WeatherPolymarketWeather,
} from "../../shared/types/api";

export type AddToast = (
  type: "info" | "success" | "warn" | "error",
  title: string,
  message: string,
) => void;

type WeatherScreenProps = {
  addToast: AddToast;
  shellControls: ShellControls;
  initialUrl?: string;
  wsWeather?: { temperature_c: number; rounded_c: number; temperature_native?: number; rounded_native?: number; unit?: 'F' | 'C'; daily_max_native?: number | null } | null;
  tokenPrices?: Map<string, { bid: number; ask: number }>;
};

type PendingSellStateLike = {
  message: string | null;
  remainingSize: number | null;
  status: "submitting" | "open" | "partial" | "filled" | "error";
};

type WeatherMarketDetailsPanelProps = {
  marketSlug: string;
  activeBotSlugs: string[];
  addToast: AddToast;
  botLoading: boolean;
  expectHigher: boolean;
  getPendingSellState: (tokenId: string | undefined) => PendingSellStateLike | null;
  lastPollTime: number | null;
  onBack: () => void;
  onConfirmManualSell: (
    marketSlug: string,
    tokenId: string,
    outcome: string,
    size: number,
  ) => void;
  onExpectHigherChange: (value: boolean) => void;
  onRefreshPositions: () => Promise<void>;
  onToggleBot: (slug: string, currentActive: boolean) => Promise<void>;
  positionsPayload: OpenPositionsPayload | null;
  renderPendingSellBadge: (pending: PendingSellStateLike) => ReactNode;
  sellingTokenId: string | null;
};

const DEFAULT_URL = "https://polymarket.com/event/highest-temperature-in-moscow-on-may-11-2026";

export function WeatherScreen({ addToast, shellControls, initialUrl, wsWeather, tokenPrices = new Map() }: WeatherScreenProps) {
  const [url, setUrl] = useState(initialUrl || DEFAULT_URL);
  const [event, setEvent] = useState<WeatherPolymarketEventPayload | null>(null);
  const [weather, setWeather] = useState<WeatherPolymarketWeather | null>(null);
  const [triggers, setTriggers] = useState<WeatherPolymarketTrigger[]>([]);
  const [tradingReady, setTradingReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshingWeather, setRefreshingWeather] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastWeatherUpdateAt, setLastWeatherUpdateAt] = useState<number | null>(null);
  const [triggerTemp, setTriggerTemp] = useState("");
  const [triggerAmount, setTriggerAmount] = useState("1");
  const [exitPrice, setExitPrice] = useState("0.99");
  const [exitMinutes, setExitMinutes] = useState("10");
  const [buyPrevNo, setBuyPrevNo] = useState(false);
  const [pendingChecks, setPendingChecks] = useState<Record<string, boolean>>({});

  const airport = event?.airport ?? null;
  const activeMarkets = useMemo(
    () => (event?.markets ?? []).filter((market) => market.active),
    [event],
  );

  const refreshTradingStatus = useCallback(async () => {
    try {
      const payload = await getWeatherPolymarketTradingStatus();
      setTradingReady(payload.ready);
    } catch {
      setTradingReady(false);
    }
  }, []);

  const refreshTriggers = useCallback(async (icao: string) => {
    const payload = await listWeatherPolymarketTriggers(icao);
    setTriggers(payload.triggers ?? []);
  }, []);

  const refreshWeather = useCallback(async (icao: string) => {
    setRefreshingWeather(true);
    try {
      const payload = await getWeatherPolymarketWeather(icao);
      setWeather(payload);
      setLastWeatherUpdateAt(Date.now());
      await refreshTriggers(icao);
      await shellControls.refreshAccountSummary();
    } finally {
      setRefreshingWeather(false);
    }
  }, [refreshTriggers, shellControls]);

  const analyze = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await getWeatherPolymarketEvent(url.trim());
      setEvent(payload);
      setWeather(payload.airport?.weather ?? null);
      setLastWeatherUpdateAt(payload.airport?.weather ? Date.now() : null);
      await refreshTradingStatus();
      if (payload.airport?.icao) {
        await refreshTriggers(payload.airport.icao);
      } else {
        setTriggers([]);
      }
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : "Failed to load event";
      setError(message);
      setEvent(null);
      setWeather(null);
      setTriggers([]);
    } finally {
      setLoading(false);
    }
  }, [refreshTradingStatus, refreshTriggers, url]);

  useEffect(() => {
    void refreshTradingStatus();
  }, [refreshTradingStatus]);

  // Auto-load event when component mounts with a pre-set URL (from session tab)
  useEffect(() => {
    if (initialUrl) {
      void analyze();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update weather from backend WebSocket (covers background tabs too)
  useEffect(() => {
    if (wsWeather) {
      setWeather(wsWeather as WeatherPolymarketWeather);
      setLastWeatherUpdateAt(Date.now());
    }
  }, [wsWeather]);

  useEffect(() => {
    if (!airport?.icao) {
      return;
    }
    const intervalId = setInterval(() => {
      void refreshWeather(airport.icao);
    }, 30_000);
    return () => clearInterval(intervalId);
  }, [airport?.icao, refreshWeather]);

  const handleSetTrigger = useCallback(async (market: WeatherPolymarketMarket, threshold: number) => {
    if (!airport?.icao || !market.yes_token_id) {
      return;
    }
    const amount = Number(triggerAmount.replace(",", "."));
    if (!Number.isFinite(amount) || amount <= 0) {
      addToast("error", "Invalid amount", "Enter a valid USDC amount.");
      return;
    }
    const exitPriceVal = Number(exitPrice.replace(",", "."));
    const exitMinutesVal = Number(exitMinutes);
    try {
      const payload = await setWeatherPolymarketTrigger({
        token_id: market.yes_token_id,
        temp_threshold: threshold,
        amount,
        icao: airport.icao,
        slug: event?.slug ?? null,
        exit_price: Number.isFinite(exitPriceVal) ? exitPriceVal : 0.99,
        exit_minutes: Number.isFinite(exitMinutesVal) ? exitMinutesVal : 10,
        buy_prev_no: buyPrevNo,
      });
      addToast("success", "Trigger set", payload.message);
      await refreshTriggers(airport.icao);
    } catch (nextError) {
      addToast(
        "error",
        "Trigger failed",
        nextError instanceof Error ? nextError.message : "Failed to set trigger",
      );
    }
  }, [addToast, airport?.icao, buyPrevNo, event?.slug, exitMinutes, exitPrice, refreshTriggers, triggerAmount]);

  const handleQuickTrigger = useCallback(async () => {
    if (!event || !airport?.icao) {
      return;
    }
    const threshold = Math.round(Number(triggerTemp.replace(",", ".")));
    if (!Number.isFinite(threshold)) {
      addToast("error", "Invalid temperature", "Enter a trigger temperature.");
      return;
    }
    const eventUnit = weather?.unit ?? "C";
    const market = activeMarkets.find((entry) => {
      const match = entry.question.match(/(\d+(?:\.\d+)?)(?:\s*[-–]\s*\d+(?:\.\d+)?)?\s*°([CF])/i);
      return match && Math.round(Number(match[1])) === threshold && entry.yes_token_id;
    });
    if (!market) {
      addToast("warn", "Market not found", `No YES market found for ${threshold}°${eventUnit}.`);
      return;
    }
    await handleSetTrigger(market, threshold);
  }, [activeMarkets, addToast, airport?.icao, event, handleSetTrigger, triggerTemp]);

  const handleClearTriggers = useCallback(async () => {
    if (!airport?.icao) {
      return;
    }
    try {
      const payload = await clearWeatherPolymarketTriggers(airport.icao);
      addToast("info", "Triggers cleared", payload.message);
      await refreshTriggers(airport.icao);
    } catch (nextError) {
      addToast(
        "error",
        "Clear failed",
        nextError instanceof Error ? nextError.message : "Failed to clear triggers",
      );
    }
  }, [addToast, airport?.icao, refreshTriggers]);

  return (
    <main className="layout weather-poly">
      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="section-kicker">Weather Polymarket</p>
            <h2>Temperature Trigger Bot</h2>
          </div>
          <button
            className="button button-secondary"
            type="button"
            onClick={() => void analyze()}
            disabled={loading}
          >
            {loading ? "..." : "Analyze"}
          </button>
        </div>

        <form
          className="controls"
          onSubmit={(event) => {
            event.preventDefault();
            void analyze();
          }}
        >
          <label className="search">
            <span>Polymarket event URL</span>
            <input
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://polymarket.com/event/..."
            />
          </label>
          <button className="button button-primary" type="submit" disabled={loading}>
            Load
          </button>
        </form>

        <p className={`status ${error ? "status-error" : ""}`}>
          {error
            ? error
            : event
              ? `${activeMarkets.length} active market(s) loaded`
              : "Load a Polymarket weather event to inspect markets and set triggers."}
        </p>
      </section>

      {event ? (
        <>
          <section className="panel">
            <div className="weather-poly-summary">
              <div className="weather-poly-stat">
                <span>Event</span>
                <strong>{event.title}</strong>
              </div>
              <div className="weather-poly-stat">
                <span>Volume</span>
                <strong>${event.total_volume.toFixed(2)}</strong>
              </div>
              <div className="weather-poly-stat">
                <span>Liquidity</span>
                <strong>${event.liquidity.toFixed(2)}</strong>
              </div>
              <div className="weather-poly-stat">
                <span>Trading</span>
                <strong>{tradingReady ? "READY" : "NOT READY"}</strong>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <p className="section-kicker">Weather</p>
                <h2>{airport?.name ?? "No airport detected"}</h2>
              </div>
              {airport?.icao ? (
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={() => void refreshWeather(airport.icao)}
                  disabled={refreshingWeather}
                >
                  {refreshingWeather ? "..." : "Refresh weather"}
                </button>
              ) : null}
            </div>

            <div className="weather-poly-summary">
              <div className="weather-poly-stat">
                <span>ICAO</span>
                <strong>{airport?.icao ?? "—"}</strong>
              </div>
              <div className="weather-poly-stat">
                <span>Current</span>
                <strong>
                  {weather
                    ? weather.unit === "F"
                      ? `${weather.temperature_native?.toFixed(1) ?? weather.temperature_c.toFixed(1)}°F`
                      : `${weather.temperature_c.toFixed(1)}°C`
                    : "—"}
                </strong>
              </div>
              <div className="weather-poly-stat">
                <span>Max today</span>
                <strong style={{ color: weather?.daily_max_native != null ? "#fbbf24" : undefined }}>
                  {weather?.daily_max_native != null
                    ? `${weather.daily_max_native}°${weather.unit ?? "C"}`
                    : "—"}
                </strong>
              </div>
              <div className="weather-poly-stat">
                <span>Updated</span>
                <strong>
                  {lastWeatherUpdateAt
                    ? new Intl.DateTimeFormat(undefined, {
                        year: "numeric",
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      }).format(lastWeatherUpdateAt)
                    : "—"}
                </strong>
              </div>
            </div>

            {airport?.icao ? (
              <>
                <div className="controls weather-poly-trigger-controls">
                  <label className="search">
                    <span>Trigger °C</span>
                    <input
                      type="number"
                      step="1"
                      value={triggerTemp}
                      onChange={(event) => setTriggerTemp(event.target.value)}
                      placeholder="30"
                    />
                  </label>
                  <label className="search">
                    <span>Amount USDC</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={triggerAmount}
                      onChange={(event) => setTriggerAmount(event.target.value)}
                      placeholder="1"
                    />
                  </label>
                  <label className="search">
                    <span>Exit ¢</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={exitPrice}
                      onChange={(event) => setExitPrice(event.target.value)}
                      placeholder="0.99"
                    />
                  </label>
                  <label className="search">
                    <span>Exit min</span>
                    <input
                      type="number"
                      step="1"
                      min="1"
                      value={exitMinutes}
                      onChange={(event) => setExitMinutes(event.target.value)}
                      placeholder="10"
                    />
                  </label>
                  <button className="button button-primary" type="button" onClick={() => void handleQuickTrigger()}>
                    Set trigger
                  </button>
                  <button className="button button-secondary" type="button" onClick={() => void handleClearTriggers()}>
                    Clear triggers
                  </button>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 4 }}>
                  {triggers.length === 0 ? (
                    <span className="status">No active triggers</span>
                  ) : triggers.map((trigger) => {
                    const yesPrice = tokenPrices.get(trigger.token_id);
                    const sortedMarkets = [...(event?.markets ?? [])]
                      .map((m) => ({ ...m, parsedTemp: parseFloat(String(m.question ?? "").match(/([0-9]+(?:\.[0-9]+)?)\s*°/)?.[1] ?? "NaN") }))
                      .filter((m) => !isNaN(m.parsedTemp))
                      .sort((a, b) => a.parsedTemp - b.parsedTemp);
                    const idx = sortedMarkets.findIndex((m) => m.yes_token_id === trigger.token_id);
                    const prevNoTokenId = idx > 0 ? sortedMarkets[idx - 1].no_token_id : null;
                    const noPrice = prevNoTokenId ? tokenPrices.get(prevNoTokenId) : null;
                    const yesAsk = yesPrice?.ask;
                    const noAsk = noPrice?.ask;
                    const isPrevNoExpensive = noAsk != null && noAsk >= 0.80;
                    return (
                      <div key={trigger.token_id} style={{
                        display: "grid",
                        gridTemplateColumns: "max-content 1fr auto auto auto",
                        alignItems: "center",
                        gap: "6px 12px",
                        padding: "5px 8px",
                        borderRadius: 6,
                        background: "rgba(255,255,255,0.04)",
                        fontSize: "0.88em",
                      }}>
                        {/* Checkbox + label */}
                        <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", whiteSpace: "nowrap" }}>
                          <input
                            type="checkbox"
                            checked={trigger.id && trigger.id in pendingChecks ? pendingChecks[trigger.id] : trigger.buy_prev_no !== false}
                            style={{ width: "auto", cursor: "pointer", accentColor: "#4ade80" }}
                            onChange={async (e) => {
                              if (!trigger.id) return;
                              const newVal = e.target.checked;
                              setPendingChecks((prev) => ({ ...prev, [trigger.id!]: newVal }));
                              try {
                                await updateWeatherPolymarketTrigger(trigger.id, newVal);
                                if (airport?.icao) await refreshTriggers(airport.icao);
                              } finally {
                                setPendingChecks((prev) => { const next = { ...prev }; delete next[trigger.id!]; return next; });
                              }
                            }}
                          />
                          <span style={{ color: "#64748b", fontSize: "0.82em" }}>prev NO</span>
                        </label>
                        {/* Temp + amount */}
                        <span style={{ color: "#e2e8f0", fontWeight: 500 }}>
                          {trigger.temp}°C&nbsp;
                          <span style={{ color: "#94a3b8", fontWeight: 400 }}>({trigger.amount} USDC)</span>
                          {trigger.executed && <span style={{ color: "#4ade80", marginLeft: 4 }}>✓</span>}
                        </span>
                        {/* YES price */}
                        <span style={{ color: yesAsk != null ? "#4ade80" : "#64748b", minWidth: 48, textAlign: "right" }}>
                          {yesAsk != null ? `YES ${Math.round(yesAsk * 100)}¢` : "YES —"}
                        </span>
                        {/* prev NO price */}
                        {trigger.buy_prev_no !== false ? (
                          <span style={{ color: isPrevNoExpensive ? "#f87171" : "#94a3b8", minWidth: 64, textAlign: "right" }}>
                            {noAsk != null ? `NO ${Math.round(noAsk * 100)}¢${isPrevNoExpensive ? " ⚠" : ""}` : "NO —"}
                          </span>
                        ) : (
                          <span style={{ color: "#475569", minWidth: 64, textAlign: "right", fontStyle: "italic" }}>no prev NO</span>
                        )}
                        {/* Executed label or placeholder */}
                        <span style={{ minWidth: 8 }} />
                      </div>
                    );
                  })}
                </div>
              </>
            ) : null}
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <p className="section-kicker">Markets</p>
                <h2>YES trigger candidates</h2>
              </div>
            </div>

            <div className="markets">
              {activeMarkets.map((market) => {
                // Match both °F and °C; for ranges like "56-57°F" take the lower (first) number
                const thresholdMatch = market.question.match(/(\d+(?:\.\d+)?)(?:\s*[-–]\s*(\d+(?:\.\d+)?))?\s*°([CF])/i);
                const threshold = thresholdMatch ? Math.round(Number(thresholdMatch[1])) : null;
                const thresholdUpper = thresholdMatch?.[2] ? Math.round(Number(thresholdMatch[2])) : null;
                const marketUnit = thresholdMatch ? thresholdMatch[3].toUpperCase() : (weather?.unit ?? "C");
                // Determine comparison operator from market question
                const q = market.question ?? "";
                const triggerOp = /or higher|or above|and above|or more/i.test(q) ? "≥"
                  : /or lower|or below|and below|or less|or under/i.test(q) ? "≤"
                  : "=";
                const thresholdLabel = thresholdUpper != null
                  ? `${threshold}–${thresholdUpper}°${marketUnit}`
                  : `${triggerOp} ${threshold ?? "?"}°${marketUnit}`;

                // Use real-time ask prices when available (subscribed for trigger markets)
                const rtYes = market.yes_token_id ? tokenPrices.get(market.yes_token_id) : null;
                const rtNo = market.no_token_id ? tokenPrices.get(market.no_token_id) : null;
                const yesAskCents = rtYes ? Math.round(rtYes.ask * 100) : null;
                const noAskCents = rtNo ? Math.round(rtNo.ask * 100) : null;
                const yesStaticPct = Math.round(market.yes_price * 100);
                const noStaticPct = 100 - yesStaticPct;

                return (
                  <div key={`${event.slug}-${market.question}`} className="market-card">
                    <span className="market-slug">{event.slug}</span>
                    <strong>{market.question}</strong>
                    <span className="market-category">
                      {yesAskCents != null
                        ? <><span style={{ color: "#4ade80" }}>YES {yesAskCents}¢</span>{" / "}<span style={{ color: "#f87171" }}>NO {noAskCents != null ? `${noAskCents}¢` : `${noStaticPct}%`}</span></>
                        : `YES ${yesStaticPct}% / NO ${noStaticPct}%`}
                    </span>
                    <span className="market-outcomes">
                      Vol ${market.volume.toFixed(2)} | Liq ${market.liquidity.toFixed(2)}
                    </span>
                    <button
                      className="button button-secondary weather-poly-market-button"
                      type="button"
                      disabled={!airport?.icao || !market.yes_token_id || threshold === null}
                      onClick={() => {
                        if (threshold !== null) {
                          void handleSetTrigger(market, threshold);
                        }
                      }}
                    >
                      Buy YES at {thresholdLabel}
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      ) : null}
    </main>
  );
}

export function WeatherMarketDetailsPanel({
  marketSlug,
  activeBotSlugs,
  botLoading,
  expectHigher,
  onBack,
  onExpectHigherChange,
  onToggleBot,
}: WeatherMarketDetailsPanelProps) {
  const [details, setDetails] = useState<MarketDetailsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [todayObs, setTodayObs] = useState<Array<{ time: string; temp: number }>>([]);
  const [botLogs, setBotLogs] = useState<Array<{ timestamp: number; message: string; type: string }>>([]);
  const [lastPollTime, setLastPollTime] = useState<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const obsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isBotActive = activeBotSlugs.includes(marketSlug);

  // Load market details (question + groq extraction)
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const payload = await getMarketDetailsRequest(marketSlug);
        if (!cancelled) setDetails(payload);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load market details");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [marketSlug]);

  // Load initial bot logs + lastPollTime from REST on mount
  useEffect(() => {
    getMarketBotStatus(marketSlug).then(s => {
      setBotLogs(s.logs ?? []);
      setLastPollTime(s.lastPollTime ?? null);
    }).catch(() => {});
  }, [marketSlug]);

  // WebSocket — real-time bot_log and bot_heartbeat events
  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}`);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as any;
        if (msg.marketSlug !== marketSlug) return;

        if (msg.type === "bot_log" && msg.log) {
          setBotLogs(prev => {
            const next = [msg.log, ...prev];
            return next.slice(0, 50);
          });
        }
        if (msg.type === "bot_heartbeat" && msg.lastPollTime) {
          setLastPollTime(msg.lastPollTime);
        }
      } catch { /* ignore */ }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [marketSlug]);

  // Fetch temperature table — refresh every 30s independently
  const refreshObs = useCallback(async (stationCode: string, tz: string) => {
    try {
      const historyRes = await getStationHistory(stationCode);
      const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
      const filtered = (historyRes.history ?? [])
        .filter(obs => {
          const d = new Date(obs.obsTime * 1000);
          return d.toLocaleDateString("en-CA", { timeZone: tz }) === today;
        })
        .map(obs => ({
          time: new Date(obs.obsTime * 1000).toLocaleTimeString("en-GB", {
            timeZone: tz,
            hour: "2-digit",
            minute: "2-digit",
          }),
          temp: obs.temp,
        }));
      setTodayObs(filtered);
    } catch { /* best-effort */ }
  }, []);

  useEffect(() => {
    const stationCode = details?.extractedData?.station_code;
    const tz = details?.extractedData?.timezone ?? "UTC";
    if (!stationCode) return;

    void refreshObs(stationCode, tz);
    obsTimerRef.current = setInterval(() => void refreshObs(stationCode, tz), 30_000);
    return () => {
      if (obsTimerRef.current) clearInterval(obsTimerRef.current);
    };
  }, [details?.extractedData?.station_code, details?.extractedData?.timezone, refreshObs]);

  const logColor: Record<string, string> = {
    info: "#ccc",
    warn: "#ffd93d",
    error: "#ff6b6b",
    success: "#6bcb77",
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <p className="section-kicker">Market details</p>
          <h2>{marketSlug}</h2>
        </div>
        <button className="button button-secondary" type="button" onClick={onBack}>
          Back to Positions
        </button>
      </div>

      <p className={`status ${error ? "status-error" : ""}`}>
        {error ? error : loading ? "Loading market details..." : details?.question ?? "No details"}
      </p>
      {details?.description ? <p className="status-muted">{details.description}</p> : null}

      {/* Bot controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
        <button
          className={`button ${isBotActive ? "button-danger" : "button-primary"}`}
          disabled={botLoading}
          type="button"
          onClick={() => void onToggleBot(marketSlug, isBotActive)}
        >
          {botLoading ? "..." : isBotActive ? "Stop Bot" : "Start Bot"}
        </button>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#ccc", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={expectHigher}
            onChange={e => {
              const val = e.target.checked;
              onExpectHigherChange(val);
              if (isBotActive) {
                updateBotSettings(marketSlug, { expectHigher: val }).catch(() => {});
              }
            }}
          />
          Hold through target
        </label>
        {isBotActive && (
          <span style={{ fontSize: 12, color: "#6bcb77" }}>
            ● Bot active{lastPollTime ? ` · last poll ${new Date(lastPollTime).toLocaleTimeString()}` : ""}
          </span>
        )}
      </div>

      {/* Groq extraction */}
      {details?.extractedData ? (
        <div style={{ marginTop: 16 }}>
          <p className="section-kicker" style={{ marginBottom: 8 }}>Groq Extraction</p>
          <pre style={{
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 8,
            padding: "12px 16px",
            fontSize: 12,
            color: "#a8ff78",
            overflowX: "auto",
            lineHeight: 1.6,
          }}>
            {(() => {
              const d = details.extractedData!;
              const urlFields = new Set(["url", "res_source"]);
              const lines = Object.entries(d).map(([key, val]) => {
                const isUrl = urlFields.has(key) && typeof val === "string" && val.startsWith("http");
                return (
                  <div key={key}>
                    {"  "}<span style={{ color: "#79c0ff" }}>"{key}"</span>:{" "}
                    {isUrl ? (
                      <a href={val as string} target="_blank" rel="noopener noreferrer"
                        style={{ color: "#a8ff78", textDecoration: "underline" }}>
                        "{val}"
                      </a>
                    ) : (
                      <span>{JSON.stringify(val)}</span>
                    )}
                  </div>
                );
              });
              return <>{`{\n`}{lines}{`}`}</>;
            })()}
          </pre>
        </div>
      ) : details && !loading ? (
        <p className="status-muted" style={{ marginTop: 12, color: "#ff6b6b" }}>
          ⚠ Groq extraction returned no data
        </p>
      ) : null}

      {/* Today's temperature table */}
      {todayObs.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <p className="section-kicker" style={{ marginBottom: 8 }}>
            Today's Temperatures ({todayObs.length} observations)
          </p>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
                  <th style={{ textAlign: "left", padding: "4px 12px", color: "#888" }}>Time</th>
                  <th style={{ textAlign: "right", padding: "4px 12px", color: "#888" }}>Temp</th>
                </tr>
              </thead>
              <tbody>
                {todayObs.map((obs, i) => {
                  const unit = details?.extractedData?.t_sys ?? "C";
                  const target = details?.extractedData?.t ?? null;
                  // obs.temp is always Celsius from METAR — convert to market unit for display
                  const displayTemp = unit === "F" ? (obs.temp * 9 / 5 + 32) : obs.temp;
                  const displayPeak = unit === "F" ? (todayObs[0].temp * 9 / 5 + 32) : todayObs[0].temp;
                  const isMax = displayTemp >= displayPeak - 0.01;
                  const isClose = target !== null && Math.abs(displayTemp - target) <= 2;
                  return (
                    <tr
                      key={i}
                      style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}
                    >
                      <td style={{ padding: "4px 12px", color: "#aaa" }}>{obs.time}</td>
                      <td style={{
                        padding: "4px 12px",
                        textAlign: "right",
                        fontWeight: isMax ? 700 : 400,
                        color: isClose ? "#ffd93d" : isMax ? "#6bcb77" : "#ccc",
                      }}>
                        {displayTemp % 1 === 0 ? displayTemp : displayTemp.toFixed(1)}°{unit}
                        {isMax && i === 0 ? " ↑ peak" : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Bot activity log */}
      {(botLogs.length > 0 || lastPollTime) && (
        <div style={{ marginTop: 20 }}>
          <p className="section-kicker" style={{ marginBottom: 8 }}>
            Bot Activity Log
            {lastPollTime ? (
              <span style={{ fontWeight: 400, color: "#888", marginLeft: 8 }}>
                — last poll {new Date(lastPollTime).toLocaleTimeString()}
              </span>
            ) : null}
          </p>
          <div style={{
            background: "rgba(0,0,0,0.3)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 8,
            padding: "8px 0",
            maxHeight: 260,
            overflowY: "auto",
            fontSize: 11,
            fontFamily: "monospace",
          }}>
            {botLogs.map((log, i) => (
              <div key={i} style={{ padding: "3px 12px", color: logColor[log.type] ?? "#ccc" }}>
                <span style={{ color: "#555", marginRight: 8 }}>
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
                {log.message}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
