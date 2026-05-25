import { useEffect, useMemo, useRef, useState } from "react";

import {
  getBtc15mAutoStatus,
  hardResetBtc15mAutoBot as hardResetBtc15mAutoBotRequest,
  resetBtc15mAutoBudget as resetBtc15mAutoBudgetRequest,
  toggleBtc15mAutoBot as toggleBtc15mAutoBotRequest,
} from "../../shared/api/btc15mAuto";
import { formatTimeRemaining } from "../../shared/lib/dates";
import {
  formatBtcDelta,
  formatBtcPrice,
  formatPosNum,
  formatUsd,
  formatUsdPrice,
} from "../../shared/lib/format";
import type { Btc15mAutoCompletedTrade, Btc15mAutoCycle, Btc15mAutoStatusPayload } from "../../shared/types/api";

type AddToast = (
  type: "info" | "success" | "warn" | "error",
  title: string,
  message: string,
) => void;

type Btc15mAutoScreenProps = {
  addToast: AddToast;
};

export function Btc15mAutoScreen({ addToast }: Btc15mAutoScreenProps) {
  const [status, setStatus] = useState<Btc15mAutoStatusPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const previousPhaseRef = useRef<string | null>(null);
  const statusWsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [formConfig, setFormConfig] = useState({
    workingBudgetUsd: 5,
    buyAmountUsd: 5,
    minBuyPrice: 0.2,
    maxBuyPrice: 0.8,
    trailStep: 0.05,
    trailDist: 0.02,
    trailUpdateIntervalSec: 3,
    repeatThresholdMin: 6,
    forceSellThresholdMin: 2,
    neutralZoneUsd: 5,
  });

  const analytics = status?.dryRun ? status.sessionAnalytics : status?.analytics;
  const trades: Btc15mAutoCompletedTrade[] = status?.dryRun
    ? (status.sessionTrades ?? [])
    : (status?.completedTrades ?? []);
  const showStopFor = (cycle: Btc15mAutoCycle | undefined) =>
    Boolean(cycle?.position && cycle.trailStopPrice !== null && cycle.trailStopPrice !== undefined);
  const showPlannedBuyFor = (cycle: Btc15mAutoCycle | undefined, sidePrice: number | null | undefined) => {
    if (!status || !cycle) return false;
    if (cycle.position || cycle.plannedBuyPrice === null || cycle.plannedBuyPrice === undefined) return false;
    if (sidePrice === null || sidePrice === undefined) return false;
    return sidePrice > status.config.minBuyPrice && sidePrice < status.config.maxBuyPrice;
  };
  const showPositionStopUp = showStopFor(status?.upCycle);
  const showPositionStopDown = showStopFor(status?.downCycle);
  const showPositionPlannedBuyUp = useMemo(
    () => showPlannedBuyFor(status?.upCycle, status?.upPrice ?? null),
    [status],
  );
  const showPositionPlannedBuyDown = useMemo(
    () => showPlannedBuyFor(status?.downCycle, status?.downPrice ?? null),
    [status],
  );

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const payload = await getBtc15mAutoStatus();
        if (!cancelled) {
          setStatus(payload);
        }
      } catch (error) {
        if (!cancelled) {
          addToast("error", "BTC 15m Auto status failed", error instanceof Error ? error.message : "Unknown error");
        }
      }
    };

    void load();
    const intervalId = setInterval(() => void load(), 3000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [addToast]);

  useEffect(() => {
    let cancelled = false;

    const connect = () => {
      if (cancelled) {
        return;
      }
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}`);
      statusWsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as { type?: string; payload?: Btc15mAutoStatusPayload };
          if (message.type === "btc15m_auto_status" && message.payload) {
            setStatus(message.payload);
          }
        } catch {
        }
      };

      ws.onclose = () => {
        if (statusWsRef.current === ws) {
          statusWsRef.current = null;
        }
        if (!cancelled) {
          reconnectTimeoutRef.current = setTimeout(connect, 1000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      statusWsRef.current?.close();
      statusWsRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!status?.config) {
      return;
    }

    const phase = status.enginePhase;
    const previousPhase = previousPhaseRef.current;
    previousPhaseRef.current = phase;

    const isFirstLoad = previousPhase === null;
    const justStopped = previousPhase === "running" && phase !== "running";
    if (!isFirstLoad && !justStopped) {
      return;
    }
    if (phase === "running") {
      return;
    }

    setFormConfig({
      workingBudgetUsd: status.config.workingBudgetUsd,
      buyAmountUsd: status.config.buyAmountUsd,
      minBuyPrice: status.config.minBuyPrice,
      maxBuyPrice: status.config.maxBuyPrice,
      trailStep: status.config.trailStep,
      trailDist: status.config.trailDist,
      trailUpdateIntervalSec: status.config.trailUpdateIntervalSec,
      repeatThresholdMin: status.config.repeatThresholdMin,
      forceSellThresholdMin: status.config.forceSellThresholdMin,
      neutralZoneUsd: status.config.neutralZoneUsd,
    });
  }, [status]);

  async function loadStatus() {
    setLoading(true);
    try {
      const payload = await getBtc15mAutoStatus();
      setStatus(payload);
    } catch (error) {
      addToast("error", "BTC 15m Auto status failed", error instanceof Error ? error.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  async function resetBudget() {
    setLoading(true);
    try {
      const payload = await resetBtc15mAutoBudgetRequest();
      setStatus(payload);
      addToast("success", "BTC 15m Auto budget reset", "Working budget restored.");
    } catch (error) {
      addToast("error", "BTC 15m Auto budget reset failed", error instanceof Error ? error.message : "Unknown error");
    } finally {
      setLoading(false);
      void loadStatus();
    }
  }

  async function hardResetBot() {
    if (loading) return;
    if (status?.enginePhase === "running") {
      addToast("error", "Stop the bot first", "Hard-reset can only run when the bot is stopped.");
      return;
    }
    if (!window.confirm(
      "Hard-reset BTC 15m Auto?\n\nThis WIPES ALL local state:\n• both UP and DOWN cycles (orders, positions, trail stops)\n• completed trade history\n• budget restored to working budget\n\nUse this only after the bot is stopped AND you've manually closed any positions on Polymarket. This does NOT cancel orders on Polymarket.",
    )) {
      return;
    }
    setLoading(true);
    try {
      const payload = await hardResetBtc15mAutoBotRequest();
      setStatus(payload);
      addToast("success", "BTC 15m Auto hard-reset", "All local state wiped. Ready for a clean Start.");
    } catch (error) {
      addToast("error", "BTC 15m Auto hard-reset failed", error instanceof Error ? error.message : "Unknown error");
    } finally {
      setLoading(false);
      void loadStatus();
    }
  }

  async function toggleBot() {
    if (loading) {
      return;
    }

    const isActive = status?.enginePhase === "running";
    setLoading(true);
    try {
      const payload = await toggleBtc15mAutoBotRequest(isActive, formConfig);
      setStatus(payload);
        addToast(
          "success",
          isActive ? "BTC 15m Auto stopped" : "BTC 15m Auto started",
          isActive ? "Bot stopped." : "UP trailing buy cycle is watching the current 15m market.",
        );
    } catch (error) {
      addToast("error", "BTC 15m Auto toggle failed", error instanceof Error ? error.message : "Unknown error");
    } finally {
      setLoading(false);
      void loadStatus();
    }
  }

  return (
    <main className="layout layout-single btc15m-tab panel-density-compact">
      <section className="panel btc15m-panel">
        <div className="panel-head">
          <div>
            <p className="section-kicker">Bitcoin 15-minute auto markets</p>
            <h2>UP trailing buy bot</h2>
          </div>
          <div className="btc15m-actions">
            <button className="button button-secondary" onClick={() => void loadStatus()} type="button" disabled={loading}>
              {loading ? "..." : "Refresh"}
            </button>
            <button className="button button-secondary" onClick={() => void resetBudget()} type="button" disabled={loading || status?.enginePhase === "running"}>
              {loading ? "..." : "Clear budget"}
            </button>
            <button
              className="button button-secondary"
              onClick={() => void hardResetBot()}
              type="button"
              disabled={loading || status?.enginePhase === "running"}
              title="Wipe ALL local state (cycles, positions, trade history, budget). Bot must be stopped. Does NOT cancel orders on Polymarket."
              style={{ borderColor: "var(--rose, #fb7185)", color: "var(--rose, #fb7185)" }}
            >
              Reset bot
            </button>
            <button className={`button ${status?.enginePhase === "running" ? "button-secondary" : "button-primary"}`} onClick={() => void toggleBot()} type="button" disabled={loading}>
              {loading ? "..." : status?.enginePhase === "running" ? "Stop Bot" : "Start Bot"}
            </button>
          </div>
        </div>

        <div className="btc15m-summary-grid">
          <article className="btc15m-stat-card"><span>Engine</span><strong className={status?.enginePhase === "running" ? "pnl-pos" : "pnl-neg"}>{status?.enginePhase?.toUpperCase() ?? "STOPPED"}</strong></article>
          <article className="btc15m-stat-card"><span>Mode</span><strong>{status?.dryRun === false ? "LIVE" : "SIM"}</strong></article>
          <article className="btc15m-stat-card"><span>Session Start</span><strong>{formatUsd(analytics?.sessionStartBudgetUsd ?? status?.budget?.initialBudget)}</strong></article>
          <article className="btc15m-stat-card"><span>Profit Sum</span><strong className="pnl-pos">{formatUsd(analytics?.grossProfitUsd)}</strong></article>
          <article className="btc15m-stat-card"><span>Loss Sum</span><strong className="pnl-neg">{formatUsd(analytics?.grossLossUsd)}</strong></article>
          <article className="btc15m-stat-card"><span>Balance Now</span><strong>{formatUsd(status?.analytics?.remainingBudgetUsd ?? status?.budget?.availableBudget)}</strong></article>
        </div>

        <article className="btc15m-card">
          <div className="panel-head">
            <div>
              <p className="section-kicker">Settings</p>
              <h2>Cycle controls</h2>
            </div>
            <span className={`event-badge ${status?.dryRun === false ? "event-badge-error" : "event-badge-warn"}`}>
              {status?.dryRun === false ? "LIVE" : "SIM"}
            </span>
          </div>
          <div className="btc15m-settings-grid">
            {([
              ["Working budget ($)", "workingBudgetUsd", 0.5],
              ["Buy amount ($)", "buyAmountUsd", 0.01],
              ["Min buy ($)", "minBuyPrice", 0.01],
              ["Max buy ($)", "maxBuyPrice", 0.01],
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
                  value={formConfig[key]}
                  disabled={status?.enginePhase === "running"}
                  onChange={(event) => setFormConfig((previous) => ({
                    ...previous,
                    [key]: Number(event.target.value),
                  }))}
                />
              </label>
            ))}
          </div>
          {status?.enginePhase === "auto_stopped" ? <p className="status status-warn">Auto-stopped after budget exhaustion.</p> : null}
          {status?.lastError ? <p className="status status-error">{status.lastError}</p> : null}
        </article>

        <article className="btc15m-card">
          <div className="panel-head">
            <div>
              <p className="section-kicker">Live monitor</p>
              <h2>{status?.market?.question ?? "Waiting for live 15m market"}</h2>
            </div>
            {status?.market?.slug ? <a className="positions-link" href={`https://polymarket.com/event/${status.market.slug}`} target="_blank" rel="noreferrer">Open market ↗</a> : null}
          </div>
          {/* Common cards — full width, apply to the whole market regardless of side */}
          <div className="btc15m-monitor-grid">
            <span><em>Market</em><strong>{status?.market?.slug ?? "—"}</strong></span>
            <span><em>Time left</em><strong>{status?.market ? formatTimeRemaining(status.market.endTimeMs) : "—"}</strong></span>
            <span><em>Start BTC</em><strong>{formatBtcPrice(status?.marketStartBtcPrice)}</strong></span>
            <span><em>Current BTC</em><strong>{formatBtcPrice(status?.currentBtcPrice)}</strong></span>
            <span><em>Delta</em><strong>{formatBtcDelta(status)}</strong></span>
            <span><em>Cycle</em><strong>{status?.upCycle.cyclePhase ?? "—"} / {status?.downCycle.cyclePhase ?? "—"}</strong></span>
          </div>

          {/* Two-column split: UP and DOWN run as independent parallel cycles, shared budget. */}
          <div className="btc15m-side-split">
            {([
              { key: "up" as const, cycle: status?.upCycle, sidePrice: status?.upPrice, showStop: showPositionStopUp, showPlanned: showPositionPlannedBuyUp, titleCls: "btc15m-side-title-up", priceLabel: "Up Price" },
              { key: "down" as const, cycle: status?.downCycle, sidePrice: status?.downPrice, showStop: showPositionStopDown, showPlanned: showPositionPlannedBuyDown, titleCls: "btc15m-side-title-down", priceLabel: "Down Price" },
            ]).map(({ key, cycle, sidePrice, showStop, showPlanned, titleCls, priceLabel }) => (
              <div key={key} className="btc15m-side-col">
                <h3 className={`btc15m-side-title ${titleCls}`}>{key.toUpperCase()}</h3>
                <div className="btc15m-monitor-grid">
                  <span><em>{priceLabel}</em><strong>{formatUsdPrice(sidePrice ?? null)}</strong></span>
                  {cycle?.position ? (
                    <span>
                      <em>Stop Sell</em>
                      <strong className="btc15m-value-stop">{formatUsdPrice(cycle.trailStopPrice ?? null)}</strong>
                    </span>
                  ) : (
                    <span>
                      <em>Planned Buy</em>
                      <strong className="btc15m-value-planned">{formatUsdPrice(cycle?.plannedBuyPrice ?? null)}</strong>
                    </span>
                  )}
                  <span><em>Buy State</em><strong>{cycle?.buyBlockReason ?? cycle?.cyclePhase ?? "—"}</strong></span>
                </div>
                <div className="btc15m-cycle-grid">
                  <div>
                    <h3>Buy order</h3>
                    {cycle?.buyOrder ? (
                      <dl><dt>Side</dt><dd>{cycle.buyOrder.bettingSide.toUpperCase()}</dd><dt>Price</dt><dd>{formatUsdPrice(cycle.buyOrder.price)}</dd><dt>Size</dt><dd>{formatPosNum(cycle.buyOrder.size)}</dd><dt>Status</dt><dd>{cycle.buyOrder.status}</dd></dl>
                    ) : <p className="status status-muted">none</p>}
                  </div>
                  <div>
                    <h3>Position</h3>
                    {cycle?.position ? (
                      <dl><dt>Side</dt><dd>{cycle.position.bettingSide.toUpperCase()}</dd><dt>Shares</dt><dd>{formatPosNum(cycle.position.shares)}</dd><dt>Avg</dt><dd>{formatUsdPrice(cycle.position.avgEntryPrice)}</dd><dt>Cost</dt><dd>{formatUsd(cycle.position.costBasisUsd)}</dd>{showStop ? <><dt>Stop</dt><dd className="pnl-neg">{formatUsdPrice(cycle.trailStopPrice ?? null)}</dd></> : null}</dl>
                    ) : showPlanned ? (
                      <dl><dt>Planned Buy</dt><dd className="btc15m-value-gold">{formatUsdPrice(cycle?.plannedBuyPrice ?? null)}</dd></dl>
                    ) : <p className="status status-muted">none</p>}
                  </div>
                  <div>
                    <h3>Sell order</h3>
                    {cycle?.sellOrder ? (
                      <dl><dt>Price</dt><dd>{formatUsdPrice(cycle.sellOrder.price)}</dd><dt>Size</dt><dd>{formatPosNum(cycle.sellOrder.size)}</dd><dt>Status</dt><dd>{cycle.sellOrder.status}</dd><dt>Order</dt><dd>{cycle.sellOrder.orderId ?? "—"}</dd></dl>
                    ) : <p className="status status-muted">none</p>}
                  </div>
                </div>
              </div>
            ))}
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
            <span>Trades: {analytics?.totalTrades ?? 0}</span>
            <span>Wins: {analytics?.wins ?? 0}</span>
            <span>Losses: {analytics?.losses ?? 0}</span>
            <span>Win rate: {((analytics?.winRate ?? 0) * 100).toFixed(1)}%</span>
            <span>PnL: {formatUsd(analytics?.totalPnlUsd)}</span>
          </div>
          <div className="positions-table-wrap">
            <table className="positions-table btc15m-trade-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Market</th>
                  <th>Side</th>
                  <th>Buy</th>
                  <th>Sell</th>
                  <th>Qty</th>
                  <th>Cost</th>
                  <th>Proceeds</th>
                  <th>Fees</th>
                  <th>PnL</th>
                  <th>Result</th>
                  <th>Exit</th>
                </tr>
              </thead>
              <tbody>
                {trades.slice().reverse().map((trade) => {
                  const totalFees = (trade.buyFeeUsd ?? 0) + (trade.sellFeeUsd ?? 0);
                  return (
                    <tr key={trade.id} className={trade.result === "win" ? "btc15m-row-win" : "btc15m-row-loss"}>
                      <td>{new Date(trade.closedAt).toLocaleString()}</td>
                      <td>{trade.marketSlug.replace("btc-updown-15m-", "")}</td>
                      <td>{trade.bettingSide.toUpperCase()}</td>
                      <td>{formatUsdPrice(trade.buyPrice)}</td>
                      <td>{formatUsdPrice(trade.sellPrice)}</td>
                      <td>{formatPosNum(trade.shares)}</td>
                      <td>{trade.buyCostUsd !== undefined ? formatUsd(trade.buyCostUsd) : "—"}</td>
                      <td>{trade.sellProceedsUsd !== undefined ? formatUsd(trade.sellProceedsUsd) : "—"}</td>
                      <td>{trade.buyFeeUsd !== undefined || trade.sellFeeUsd !== undefined ? formatUsd(totalFees) : "—"}</td>
                      <td>{formatUsd(trade.pnlUsd)}</td>
                      <td>{trade.result}</td>
                      <td>{trade.exitReason}</td>
                    </tr>
                  );
                })}
                {trades.length === 0 ? (
                  <tr><td colSpan={12} className="status status-muted">No trades yet.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </article>

        <article className="btc15m-card">
          <div className="panel-head">
            <div>
              <p className="section-kicker">Activity</p>
              <h2>Bot logs</h2>
            </div>
          </div>
          <div className="btc15m-logs">
            {status?.logs.slice(0, 50).map((log, index) => (
              <div key={index} className={`btc15m-log-entry btc15m-log-${log.type}`}>
                <span className="btc15m-log-time">{new Date(log.timestamp).toLocaleTimeString()}</span>
                <span className="btc15m-log-message">{log.message}</span>
              </div>
            ))}
            {!status?.logs.length ? (
              <p className="status status-muted">No logs yet.</p>
            ) : null}
          </div>
        </article>
      </section>
    </main>
  );
}
