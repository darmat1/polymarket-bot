import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getUserWebSocketAuth } from "../../shared/api/account";
import { clearEventLog, getActiveBotSlugs, getEventLog } from "../../shared/api/events";
import {
  activateMarketBot,
  deactivateMarketBot,
  getPositions,
  submitManualSell,
} from "../../shared/api/positions";
import { getMarketDetails as getMarketDetailsRequest } from "../../shared/api/weather";
import { formatLocalDateKey } from "../../shared/lib/dates";
import {
  formatPosDateParts,
  formatPosNum,
  shortenAddress,
} from "../../shared/lib/format";
import { Panel } from "../../shared/ui/Panel";
import { EmptyState } from "../../shared/ui/EmptyState";
import { StatusMessage } from "../../shared/ui/StatusMessage";
import type { ShellControls } from "../../shared/types/app";
import type {
  ActivateMarketBotPayload,
  EventLogEntry,
  OpenPositionsPayload,
  PolymarketPositionRow,
} from "../../shared/types/api";
import {
  type AddToast,
  WeatherMarketDetailsPanel,
} from "../weather/WeatherScreen";

type PositionsScreenProps = {
  addToast: AddToast;
  setTabsVisible: (visible: boolean) => void;
  shellControls: ShellControls;
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

type PendingSellDisplayState = Pick<
  PendingSellState,
  "status" | "remainingSize" | "message"
>;

export function PositionsScreen({
  addToast,
  setTabsVisible,
  shellControls,
}: PositionsScreenProps) {
  const [positionsPayload, setPositionsPayload] = useState<OpenPositionsPayload | null>(null);
  const [loadingPositions, setLoadingPositions] = useState(false);
  const [positionsError, setPositionsError] = useState<string | null>(null);
  const [activeBotSlugs, setActiveBotSlugs] = useState<string[]>([]);
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
  const [viewingMarketSlug, setViewingMarketSlug] = useState<string | null>(null);
  const [posSortField, setPosSortField] = useState<string>("value");
  const [posSortDir, setPosSortDir] = useState<"asc" | "desc">("desc");
  const [botLoading, setBotLoading] = useState(false);
  const [expectHigher, setExpectHigher] = useState(false);
  const [lastPollTime, setLastPollTime] = useState<number | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const portfolioSyncWsRef = useRef<WebSocket | null>(null);
  const portfolioSyncPingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const portfolioSyncReconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const portfolioSyncRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const portfolioSyncStoppedRef = useRef(false);

  const sortedPositions = useMemo(() => {
    if (!positionsPayload?.positions) {
      return [];
    }

    const positions = [...positionsPayload.positions];
    return positions.sort((a, b) => {
      let valueA: string | number | boolean = 0;
      let valueB: string | number | boolean = 0;

      switch (posSortField) {
        case "bot":
          valueA = activeBotSlugs.includes(a.slug ?? "");
          valueB = activeBotSlugs.includes(b.slug ?? "");
          break;
        case "market":
          valueA = (a.title ?? a.slug ?? "").toLowerCase();
          valueB = (b.title ?? b.slug ?? "").toLowerCase();
          break;
        case "avg":
          valueA = a.avgPrice ?? 0;
          valueB = b.avgPrice ?? 0;
          break;
        case "traded":
          valueA = (a.size ?? 0) * (a.avgPrice ?? 0);
          valueB = (b.size ?? 0) * (b.avgPrice ?? 0);
          break;
        case "toWin":
          valueA = a.size ?? 0;
          valueB = b.size ?? 0;
          break;
        case "value":
          valueA = a.currentValue ?? 0;
          valueB = b.currentValue ?? 0;
          break;
        case "ends":
          valueA = a.endDate ? new Date(a.endDate).getTime() : 0;
          valueB = b.endDate ? new Date(b.endDate).getTime() : 0;
          break;
        default:
          break;
      }

      if (valueA < valueB) {
        return posSortDir === "asc" ? -1 : 1;
      }
      if (valueA > valueB) {
        return posSortDir === "asc" ? 1 : -1;
      }
      return 0;
    });
  }, [activeBotSlugs, posSortDir, posSortField, positionsPayload?.positions]);

  const groupedPositions = useMemo(() => {
    if (!sortedPositions.length) {
      return [];
    }

    const groupsMap: Record<string, PolymarketPositionRow[]> = {};
    sortedPositions.forEach((position) => {
      let dateKey = "Unknown";
      if (position.endDate) {
        dateKey = formatLocalDateKey(position.endDate) ?? position.endDate;
      }
      if (!groupsMap[dateKey]) {
        groupsMap[dateKey] = [];
      }
      groupsMap[dateKey].push(position);
    });

    const today = formatLocalDateKey(Date.now());
    return Object.entries(groupsMap)
      .map(([date, positions]) => ({ date, positions }))
      .sort((a, b) => {
        if (a.date === "Unknown") {
          return 1;
        }
        if (b.date === "Unknown") {
          return -1;
        }
        if (a.date === today) {
          return -1;
        }
        if (b.date === today) {
          return 1;
        }
        return a.date.localeCompare(b.date);
      });
  }, [sortedPositions]);

  useEffect(() => {
    setTabsVisible(!viewingMarketSlug);

    return () => {
      setTabsVisible(true);
    };
  }, [setTabsVisible, viewingMarketSlug]);

  useEffect(() => {
    setPendingSells((previous) => {
      if (!positionsPayload) {
        return previous;
      }

      let changed = false;
      const next = { ...previous };

      Object.entries(previous).forEach(([tokenId, pending]) => {
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

      return changed ? next : previous;
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

  const loadPositions = useCallback(async () => {
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
      window.setTimeout(() => setIsRefreshing(false), 800);

      try {
        const data = await getActiveBotSlugs();
        setActiveBotSlugs(data.slugs || []);
      } catch (error) {
        console.error("Failed to fetch active bots", error);
      }
    }
  }, []);

  useEffect(() => {
    void loadPositions();
    void shellControls.refreshAccountSummary();
    void loadEventLog();
  }, [loadEventLog, loadPositions, shellControls]);

  useEffect(() => {
    portfolioSyncStoppedRef.current = false;
    void connectPortfolioSyncWs();

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

  useEffect(() => {
    const intervalId = setInterval(() => void loadEventLog(), 15_000);
    return () => clearInterval(intervalId);
  }, [loadEventLog]);

  useEffect(() => {
    if (viewingMarketSlug) {
      return;
    }

    const intervalId = setInterval(() => void loadPositions(), 30_000);
    return () => clearInterval(intervalId);
  }, [loadPositions, viewingMarketSlug]);

  function toggleSort(field: string) {
    if (posSortField === field) {
      setPosSortDir((previous) => (previous === "asc" ? "desc" : "asc"));
    } else {
      setPosSortField(field);
      setPosSortDir("desc");
    }
  }

  function renderSortIcon(field: string) {
    if (posSortField !== field) {
      return null;
    }

    return (
      <span style={{ marginLeft: "4px", fontSize: "0.6rem", opacity: 0.8 }}>
        {posSortDir === "asc" ? "▲" : "▼"}
      </span>
    );
  }

  async function toggleBotForSlug(slug: string, currentActive: boolean) {
    setBotLoading(true);
    try {
      if (currentActive) {
        await deactivateMarketBot(slug);
        setActiveBotSlugs((previous) => previous.filter((currentSlug) => currentSlug !== slug));
      } else {
        const details = await getMarketDetailsRequest(slug);
        if (!details || !details.extractedData) {
          throw new Error("Could not load market details for bot");
        }

        const activePositions = (positionsPayload?.positions || []).filter(
          (position) => position.slug === slug,
        );
        if (activePositions.length === 0) {
          const availableSlugs = (positionsPayload?.positions || [])
            .map((position) => position.slug)
            .join(", ");
          addToast(
            "warn",
            "No positions found",
            `Could not find an open position for slug: ${slug}. (Available in your portfolio: ${availableSlugs || "none"})`,
          );
          return;
        }

        const position = activePositions[0];
        const payload: ActivateMarketBotPayload = {
          marketSlug: slug,
          stationCode: details.extractedData.station_code,
          targetTemp: details.extractedData.t,
          targetDate: details.extractedData.day,
          tempUnit: details.extractedData.t_sys === "F" ? "F" : "C",
          outcome: position.outcome,
          tokenId: position.asset,
          expectHigher,
          timezone: details.extractedData.timezone,
        };

        await activateMarketBot(payload);
        setActiveBotSlugs((previous) => [...previous, slug]);
      }
    } catch (error) {
      addToast(
        "error",
        "Bot toggle failed",
        error instanceof Error ? error.message : "Unknown error",
      );
      console.error(error);
    } finally {
      setBotLoading(false);
    }
  }

  function confirmManualSell(
    marketSlug: string,
    tokenId: string,
    outcome: string,
    size: number,
  ) {
    setSellConfirmation({ marketSlug, tokenId, outcome, size });
  }

  async function handleManualSell() {
    if (!sellConfirmation) {
      return;
    }

    const { marketSlug, tokenId, outcome, size } = sellConfirmation;
    setSellingTokenId(tokenId);
    setPendingSells((previous) => ({
      ...previous,
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
      setPendingSells((previous) => ({
        ...previous,
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
      await shellControls.refreshAccountSummary();
      void loadPositions();
      void loadEventLog();
    } catch (error) {
      setPendingSells((previous) => ({
        ...previous,
        [tokenId]: {
          tokenId,
          marketSlug,
          outcome,
          requestedSize: size,
          status: "error",
          remainingSize: size,
          orderId: null,
          message: error instanceof Error ? error.message : "Sell failed",
          updatedAt: Date.now(),
        },
      }));
      addToast(
        "error",
        "Sell failed",
        error instanceof Error ? error.message : "Unknown error",
      );
    } finally {
      setSellingTokenId(null);
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

    setPendingSells((previous) => {
      let changed = false;
      const next = { ...previous };

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

      return changed ? next : previous;
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
      <main className="layout layout-single">
        {viewingMarketSlug ? (
          <WeatherMarketDetailsPanel
            marketSlug={viewingMarketSlug}
            activeBotSlugs={activeBotSlugs}
            addToast={addToast}
            botLoading={botLoading}
            expectHigher={expectHigher}
            getPendingSellState={getPendingSellState}
            lastPollTime={lastPollTime}
            onBack={() => setViewingMarketSlug(null)}
            onConfirmManualSell={confirmManualSell}
            onExpectHigherChange={setExpectHigher}
            onRefreshPositions={loadPositions}
            onToggleBot={toggleBotForSlug}
            positionsPayload={positionsPayload}
            renderPendingSellBadge={renderPendingSellBadge}
            sellingTokenId={sellingTokenId}
          />
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
                {isRefreshing ? <span className="spinner-dot" /> : null}
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
            {positionsError ? <StatusMessage>{positionsError}</StatusMessage> : null}
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
                              <th style={{ width: "80px", cursor: "pointer" }} onClick={() => toggleSort("bot")}>
                                Bot {renderSortIcon("bot")}
                              </th>
                              <th style={{ cursor: "pointer" }} onClick={() => toggleSort("market")}>
                                Market {renderSortIcon("market")}
                              </th>
                              <th style={{ cursor: "pointer" }} onClick={() => toggleSort("avg")}>
                                Avg → Now {renderSortIcon("avg")}
                              </th>
                              <th style={{ cursor: "pointer" }} onClick={() => toggleSort("traded")}>
                                Traded {renderSortIcon("traded")}
                              </th>
                              <th style={{ cursor: "pointer" }} onClick={() => toggleSort("toWin")}>
                                To Win {renderSortIcon("toWin")}
                              </th>
                              <th style={{ cursor: "pointer" }} onClick={() => toggleSort("value")}>
                                Value {renderSortIcon("value")}
                              </th>
                              <th style={{ cursor: "pointer" }} onClick={() => toggleSort("ends")}>
                                Ends {renderSortIcon("ends")}
                              </th>
                              <th style={{ width: "80px" }}>Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {group.positions.map((row, index) => {
                              const key = `${row.conditionId ?? row.slug ?? "row"}-${row.outcome ?? ""}-${index}`;
                              const isBotActive = Boolean(row.slug && activeBotSlugs.includes(row.slug));
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
                                        <div
                                          style={{
                                            width: "32px",
                                            height: "32px",
                                            borderRadius: "4px",
                                            backgroundColor: "rgba(255,255,255,0.05)",
                                            marginTop: "2px",
                                          }}
                                        />
                                      )}
                                      <div>
                                        {row.slug ? (
                                          <button
                                            type="button"
                                            className="positions-link button-clear"
                                            style={{ fontWeight: "600", fontSize: "0.85rem", marginBottom: "4px", display: "block" }}
                                            onClick={() => {
                                              setLastPollTime(null);
                                              setViewingMarketSlug(row.slug!);
                                            }}
                                          >
                                            {row.title ?? row.slug ?? "—"}
                                          </button>
                                        ) : (
                                          <span style={{ fontWeight: "600", fontSize: "0.85rem", marginBottom: "4px", display: "block" }}>
                                            {row.title ?? row.slug ?? "—"}
                                          </span>
                                        )}
                                        <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.75rem" }}>
                                          <span
                                            style={{
                                              padding: "2px 6px",
                                              borderRadius: "3px",
                                              backgroundColor:
                                                row.outcome === "Yes"
                                                  ? "rgba(114, 221, 188, 0.12)"
                                                  : "rgba(255, 141, 141, 0.12)",
                                              color: row.outcome === "Yes" ? "var(--mint)" : "var(--rose)",
                                              fontWeight: "bold",
                                            }}
                                          >
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
                                        {row.cashPnl >= 0 ? "+" : ""}${row.cashPnl.toFixed(2)}
                                        {row.percentPnl != null
                                          ? ` (${row.percentPnl >= 0 ? "+" : ""}${row.percentPnl.toFixed(1)}%)`
                                          : ""}
                                      </div>
                                    ) : null}
                                  </td>
                                  <td className="positions-date" style={{ whiteSpace: "normal", minWidth: "90px" }}>
                                    {row.endDate ? (
                                      <div style={{ lineHeight: "1.2" }}>
                                        {formatPosDateParts(row.endDate).map((part, partIndex) => (
                                          <div
                                            key={`${row.endDate}-${partIndex}`}
                                            style={partIndex === 1 ? { fontSize: "0.7rem", opacity: 0.7, marginTop: "2px" } : {}}
                                          >
                                            {part}
                                          </div>
                                        ))}
                                      </div>
                                    ) : (
                                      "—"
                                    )}
                                  </td>
                                  <td style={{ width: "80px" }}>
                                    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                      {row.slug ? (
                                        <button
                                          type="button"
                                          className={`button button-small ${isBotActive ? "button-secondary" : "button-primary"}`}
                                          style={{ padding: "4px 10px", fontSize: "0.75rem", minWidth: "60px" }}
                                          onClick={() => void toggleBotForSlug(row.slug!, isBotActive)}
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
                                              row.size ?? 0,
                                            )
                                          }
                                          title={`Manually sell ${row.size ?? ""} ${row.outcome ?? ""} shares at market price`}
                                        >
                                          {sellingTokenId === row.asset ? "…" : "Sell"}
                                        </button>
                                      ) : null}
                                      {!row.slug && !row.asset ? "—" : null}
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
                          {entry.type === "error"
                            ? "✖ ERR"
                            : entry.type === "warn"
                              ? "⚠ WARN"
                              : entry.type === "success"
                                ? "✔ OK"
                                : "ℹ INFO"}
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

      {sellConfirmation ? (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3 className="modal-title">Are you sure?</h3>
            <p className="modal-body">
              You are about to sell <strong>{formatPosNum(sellConfirmation.size)}</strong> shares of{" "}
              <strong>{sellConfirmation.outcome}</strong>.
              <br />
              <br />
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
      ) : null}
    </>
  );
}

function renderPendingSellBadge(pending: PendingSellDisplayState) {
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
