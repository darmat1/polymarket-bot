import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

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
                const thresholdMatch = market.question.match(/(\d+(?:\.\d+)?)(?:\s*[-–]\s*\d+(?:\.\d+)?)?\s*°([CF])/i);
                const threshold = thresholdMatch ? Math.round(Number(thresholdMatch[1])) : null;
                const marketUnit = thresholdMatch ? thresholdMatch[2].toUpperCase() : (weather?.unit ?? "C");
                // Determine comparison operator from market question
                const q = market.question ?? "";
                const triggerOp = /or higher|or above|and above|or more/i.test(q) ? "≥"
                  : /or lower|or below|and below|or less|or under/i.test(q) ? "≤"
                  : "=";

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
                      Buy YES at {triggerOp} {threshold ?? "?"}°{marketUnit}
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
  onBack,
}: WeatherMarketDetailsPanelProps) {
  const [details, setDetails] = useState<MarketDetailsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const payload = await getMarketDetailsRequest(marketSlug);
        if (!cancelled) {
          setDetails(payload);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Failed to load market details");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [marketSlug]);

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
    </section>
  );
}
