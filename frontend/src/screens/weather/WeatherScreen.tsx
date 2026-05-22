import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { getMarketBotStatus } from "../../shared/api/positions";
import {
  getHourlyForecast as getHourlyForecastRequest,
  getMarketDetails as getMarketDetailsRequest,
  getStationHistory as getStationHistoryRequest,
  searchWeatherEvents,
} from "../../shared/api/weather";
import { formatDateInTimeZone } from "../../shared/lib/dates";
import { availableLabel, formatPosDate, formatPosNum } from "../../shared/lib/format";
import { isWeatherEvent } from "../../shared/lib/guards";
import { EmptyState } from "../../shared/ui/EmptyState";
import type { ShellControls } from "../../shared/types/app";
import type {
  HourlyForecastEntry,
  MarketBotStatusPayload,
  MarketDetailsPayload,
  OpenPositionsPayload,
  SearchEventSummary,
  StationHistoryEntry,
} from "../../shared/types/api";

type PendingSellStateLike = {
  message: string | null;
  remainingSize: number | null;
  status: "submitting" | "open" | "partial" | "filled" | "error";
};

export type AddToast = (
  type: "info" | "success" | "warn" | "error",
  title: string,
  message: string,
) => void;

type WeatherScreenProps = {
  shellControls: ShellControls;
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

export function WeatherScreen({ shellControls: _shellControls }: WeatherScreenProps) {
  const [search, setSearch] = useState("");
  const [events, setEvents] = useState<SearchEventSummary[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [selectedEventSlug, setSelectedEventSlug] = useState("");
  const [selectedSlug, setSelectedSlug] = useState("");

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
  const statusText = loadingEvents
    ? "Loading events..."
    : eventsError
      ? eventsError
      : `${events.length} weather event(s) visible`;

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

  const loadEvents = useCallback(async (nextSearch: string) => {
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
  }, []);

  function resetFilters() {
    setSearch("");
    setEvents([]);
  }

  return (
    <main className="layout">
      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="section-kicker">Weather Scan</p>
            <h2>Weather Discovery</h2>
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
            <span>Weather search</span>
            <input
              type="search"
              placeholder="nyc high temp"
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
              <p>{getWeatherEmptyStateText(trimmedSearch)}</p>
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
  );
}

export function WeatherMarketDetailsPanel({
  marketSlug,
  activeBotSlugs,
  addToast,
  botLoading,
  expectHigher,
  getPendingSellState,
  lastPollTime,
  onBack,
  onConfirmManualSell,
  onExpectHigherChange,
  onRefreshPositions,
  onToggleBot,
  positionsPayload,
  renderPendingSellBadge,
  sellingTokenId,
}: WeatherMarketDetailsPanelProps) {
  const [marketDetails, setMarketDetails] = useState<MarketDetailsPayload | null>(null);
  const [loadingMarketDetails, setLoadingMarketDetails] = useState(false);
  const [marketDetailsError, setMarketDetailsError] = useState<string | null>(null);
  const [stationHistory, setStationHistory] = useState<StationHistoryEntry[] | null>(null);
  const [hourlyForecast, setHourlyForecast] = useState<HourlyForecastEntry[] | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [loadingHourly, setLoadingHourly] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [botStatus, setBotStatus] = useState<MarketBotStatusPayload | null>(null);
  const marketDetailsRequestRef = useRef(0);

  const activePositions = useMemo(
    () => positionsPayload?.positions.filter((position) => position.slug === marketSlug) ?? [],
    [marketSlug, positionsPayload],
  );

  const botActive = activeBotSlugs.includes(marketSlug) || botStatus?.active === true;
  const botLogs = botStatus?.logs ?? [];

  useEffect(() => {
    let cancelled = false;

    const loadBotStatus = async () => {
      try {
        const payload = await getMarketBotStatus(marketSlug);
        if (!cancelled) {
          setBotStatus(payload);
        }
      } catch (error) {
        if (!cancelled) {
          addToast(
            "error",
            "Bot status failed",
            error instanceof Error ? error.message : "Unknown error",
          );
        }
      }
    };

    void loadBotStatus();
    return () => {
      cancelled = true;
    };
  }, [addToast, marketSlug]);

  const loadHourlyForecast = useCallback(async (slug: string, requestId?: number) => {
    setLoadingHourly(true);
    setHourlyForecast([]);
    try {
      const data = await getHourlyForecastRequest(slug);
      if (requestId !== undefined && requestId !== marketDetailsRequestRef.current) {
        return;
      }
      setHourlyForecast(data.forecast ?? []);
    } catch {
      if (requestId !== undefined && requestId !== marketDetailsRequestRef.current) {
        return;
      }
      setHourlyForecast([]);
    } finally {
      if (requestId === undefined || requestId === marketDetailsRequestRef.current) {
        setLoadingHourly(false);
      }
    }
  }, []);

  const loadStationHistory = useCallback(async (stationCode: string, requestId?: number) => {
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
  }, []);

  const loadMarketDetails = useCallback(async (slug: string) => {
    const requestId = marketDetailsRequestRef.current + 1;
    marketDetailsRequestRef.current = requestId;
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
  }, [loadHourlyForecast, loadStationHistory]);

  useEffect(() => {
    void loadMarketDetails(marketSlug);
  }, [loadMarketDetails, marketSlug]);

  useEffect(() => {
    if (!marketDetails) {
      return;
    }

    const stationCode = marketDetails.extractedData?.station_code;
    const historyInterval = stationCode
      ? setInterval(
          () => void loadStationHistory(stationCode, marketDetailsRequestRef.current),
          2 * 60 * 1000,
        )
      : null;

    const forecastInterval = setInterval(
      () => void loadHourlyForecast(marketSlug, marketDetailsRequestRef.current),
      5 * 60 * 1000,
    );

    return () => {
      if (historyInterval) {
        clearInterval(historyInterval);
      }
      clearInterval(forecastInterval);
    };
  }, [loadHourlyForecast, loadStationHistory, marketDetails, marketSlug]);

  return (
    <section className="panel positions-panel">
      <div className="panel-head">
        <div>
          <p className="section-kicker">Market Details</p>
          <h2>{marketDetails?.question ?? "Loading..."}</h2>
        </div>
        <button
          className="button button-secondary"
          type="button"
          onClick={onBack}
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
              {!botActive &&
              (marketDetails.extractedData?.t === null ||
                marketDetails.extractedData?.t === undefined) ? (
                <p style={{ color: "var(--rose)", fontSize: "0.75rem", margin: "4px 0 0 0" }}>
                  ⚠ Target temperature not found. AI extraction failed.
                </p>
              ) : null}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
              }}
            >
              {botActive && lastPollTime ? (
                <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
                  Last checked: {new Date(lastPollTime).toLocaleTimeString()} (Next in ~5 min)
                </span>
              ) : null}
              {!botActive ? (
                <label className="toggle-container">
                  <div className="switch">
                    <input
                      type="checkbox"
                      checked={expectHigher}
                      onChange={(event) => onExpectHigherChange(event.target.checked)}
                    />
                    <span className="slider"></span>
                  </div>
                  <span className="toggle-label">Expect higher temp (Hold through target)</span>
                </label>
              ) : null}
              <button
                type="button"
                className={`button ${botActive ? "button-secondary" : "button-primary"}`}
                onClick={() => void onToggleBot(marketSlug, botActive)}
                disabled={
                  botLoading ||
                  (!botActive &&
                    (marketDetails.extractedData?.t === null ||
                      marketDetails.extractedData?.t === undefined))
                }
                title={
                  !botActive &&
                  (marketDetails.extractedData?.t === null ||
                    marketDetails.extractedData?.t === undefined)
                    ? "Cannot activate: Target temperature not found in market details"
                    : ""
                }
              >
                {botLoading ? "..." : botActive ? "Deactivate Bot" : "Activate Bot"}
              </button>
            </div>
          </div>

          {botLogs.length > 0 ? (
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
              {botLogs.map((log, index) => (
                <div
                  key={`${log.timestamp}-${index}`}
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
          ) : null}

          {activePositions.length > 0 ? (
            <article className="market-positions" style={{ marginBottom: "20px" }}>
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
                        <tr key={`${row.asset ?? "row"}-${index}`}>
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
                              <span className={row.cashPnl >= 0 ? "pnl-pos" : "pnl-neg"}>
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
                            {row.asset ? (
                              <button
                                type="button"
                                className="button button-small sell-btn"
                                disabled={isSelling || sellingTokenId !== null}
                                onClick={() =>
                                  onConfirmManualSell(
                                    marketSlug,
                                    row.asset!,
                                    row.outcome ?? "?",
                                    row.size ?? 0,
                                  )
                                }
                                title={`Manually sell ${row.size ?? ""} ${row.outcome ?? ""} shares at market price`}
                              >
                                {isSelling ? "…" : "Sell"}
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
            </article>
          ) : null}

          <article className="market-description">
            <span>Rules / Context</span>
            <div
              dangerouslySetInnerHTML={{
                __html: marketDetails.description,
              }}
            />
          </article>

          {marketDetails.extractedData ? (
            <article className="market-extracted-data" style={{ marginTop: "20px" }}>
              <span>AI Extracted Data (Groq)</span>
              <div
                style={{
                  display: "flex",
                  gap: "15px",
                  marginBottom: "12px",
                  marginTop: "8px",
                }}
              >
                {marketDetails.extractedData.url ? (
                  <a
                    href={marketDetails.extractedData.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-link"
                  >
                    Polymarket Event ↗
                  </a>
                ) : null}
                {marketDetails.extractedData.res_source ? (
                  <a
                    href={marketDetails.extractedData.res_source}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-link"
                  >
                    Weather Source ↗
                  </a>
                ) : null}
              </div>
              {marketDetails.extractedData.timezone ? (
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
              ) : null}
              <pre className="result-json">
                {JSON.stringify(marketDetails.extractedData, null, 2)}
              </pre>
            </article>
          ) : null}

          {loadingHistory ? (
            <p className="status" style={{ marginTop: "20px" }}>
              Loading station history...
            </p>
          ) : null}
          {historyError ? (
            <p className="status-muted" style={{ marginTop: "20px" }}>
              Error loading history: {historyError}
            </p>
          ) : null}
          {marketDetails.extractedData ? (
            <div
              className="weather-grid"
              style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px", marginTop: "20px" }}
            >
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
                      {renderStationHistoryRows(stationHistory, marketDetails.extractedData)}
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
                      {renderForecastRows(hourlyForecast, marketDetails, loadingHourly)}
                    </tbody>
                  </table>
                </div>
              </article>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function renderStationHistoryRows(
  stationHistory: StationHistoryEntry[] | null,
  extractedData: NonNullable<MarketDetailsPayload["extractedData"]>,
) {
  const targetDayStr = extractedData.day;
  const timeZone = extractedData.timezone || "UTC";
  const filteredHistory = (stationHistory ?? []).filter((observation) => {
    if (!targetDayStr) {
      return true;
    }
    return formatDateInTimeZone(observation.obsTime * 1000, timeZone) === targetDayStr;
  });

  if (filteredHistory.length === 0) {
    return (
      <tr>
        <td colSpan={2} style={{ textAlign: "center", padding: "20px", color: "#ff6b81" }}>
          No station observations match {targetDayStr} in {timeZone}. This market is for another day and station data will appear when that date begins locally.
        </td>
      </tr>
    );
  }

  return filteredHistory.map((observation, index) => (
    <tr key={`${observation.obsTime}-${index}`}>
      <td style={{ fontSize: "0.75rem" }}>
        {new Date(observation.obsTime * 1000).toLocaleTimeString("en-GB", {
          timeZone: extractedData.timezone || "UTC",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })}
      </td>
      <td style={{ fontWeight: "600" }}>
        {extractedData.t_sys === "F"
          ? ((observation.temp * 9) / 5 + 32).toFixed(1)
          : observation.temp}
      </td>
    </tr>
  ));
}

function renderForecastRows(
  hourlyForecast: HourlyForecastEntry[] | null,
  marketDetails: MarketDetailsPayload,
  loadingHourly: boolean,
) {
  const timeZone = marketDetails.extractedData?.timezone || "UTC";
  const nowInCity = new Date().toLocaleString("en-CA", {
    timeZone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const currentHourStr = nowInCity.split(":")[0];
  const targetDay = marketDetails.extractedData?.day;
  const todayInCity = formatDateInTimeZone(Date.now(), timeZone);
  const isTodayTarget = Boolean(targetDay && targetDay === todayInCity);
  const matchingForecast = hourlyForecast
    ?.filter((point) => !targetDay || point.time.includes(targetDay))
    .filter((point) => {
      if (!isTodayTarget) {
        return true;
      }
      return parseInt(point.time.slice(11, 13), 10) >= parseInt(currentHourStr, 10);
    });

  return (
    <>
      {matchingForecast?.map((point, index) => {
        const hourStr = point.time.slice(11, 13);
        const isCurrent = hourStr === currentHourStr;

        return (
          <tr
            key={`${point.time}-${index}`}
            style={{
              background: isCurrent ? "rgba(0, 255, 163, 0.1)" : "transparent",
              borderLeft: isCurrent ? "2px solid var(--mint)" : "2px solid transparent",
            }}
          >
            <td style={{ fontSize: "0.75rem", fontWeight: isCurrent ? "700" : "400" }}>
              {point.time.slice(11, 16)} {isCurrent ? "◀ now" : ""}
            </td>
            <td style={{ color: "var(--mint)", fontWeight: "600" }}>{point.temp.toFixed(1)}</td>
          </tr>
        );
      })}
      {!loadingHourly && (!hourlyForecast || hourlyForecast.length === 0) ? (
        <tr>
          <td colSpan={2} style={{ textAlign: "center", padding: "20px", color: "var(--muted)" }}>
            No forecast data available from API
          </td>
        </tr>
      ) : null}
      {!loadingHourly &&
      hourlyForecast &&
      hourlyForecast.length > 0 &&
      hourlyForecast.filter((point) => point.time.includes(marketDetails.extractedData?.day || "")).length === 0 ? (
        <tr>
          <td colSpan={2} style={{ textAlign: "center", padding: "10px", color: "var(--gold)", fontSize: "0.75rem" }}>
            Found {hourlyForecast.length} points but none match {marketDetails.extractedData?.day}. First point: {hourlyForecast[0]?.time}
          </td>
        </tr>
      ) : null}
      {loadingHourly ? (
        <tr>
          <td colSpan={2} style={{ textAlign: "center", padding: "20px", color: "var(--muted)" }}>
            Loading forecast...
          </td>
        </tr>
      ) : null}
    </>
  );
}

function getWeatherEmptyStateText(search: string) {
  if (search) {
    return `Nothing matched "${search}". Try a broader keyword or clear the search field.`;
  }

  return "Type a query to fetch matching weather Polymarket events.";
}
