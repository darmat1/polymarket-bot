import { useEffect, useMemo, useRef, useState } from "react";

import {
  getBtc15mAutoStatus,
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
import type { Btc15mAutoCompletedTrade, Btc15mAutoStatusPayload } from "../../shared/types/api";

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
  const [formConfig, setFormConfig] = useState({
    workingBudgetUsd: 5,
    shares: 5,
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
  const showPositionStop = Boolean(status?.cycle.position && status.cycle.trailStopPrice !== null && status.cycle.trailStopPrice !== undefined);
  const showPositionPlannedBuy = useMemo(() => {
    if (!status || status.cycle.position || status.cycle.plannedBuyPrice === null || status.cycle.plannedBuyPrice === undefined) {
      return false;
    }
    return status.upPrice !== null
      && status.upPrice > status.config.minBuyPrice
      && status.upPrice < status.config.maxBuyPrice;
  }, [status]);

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
      shares: status.config.shares,
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
            <button className="button button-secondary" onClick={() => void resetBudget()} type="button" disabled={loading}>
              {loading ? "..." : "Clear budget"}
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
              ["Shares per cycle", "shares", 1],
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
          <div className="btc15m-monitor-grid">
            <span><em>Market</em><strong>{status?.market?.slug ?? "—"}</strong></span>
            <span><em>Time left</em><strong>{status?.market ? formatTimeRemaining(status.market.endTimeMs) : "—"}</strong></span>
            <span><em>Start BTC</em><strong>{formatBtcPrice(status?.marketStartBtcPrice)}</strong></span>
            <span><em>Current BTC</em><strong>{formatBtcPrice(status?.currentBtcPrice)}</strong></span>
            <span><em>Up Price</em><strong>{formatUsdPrice(status?.upPrice)}</strong></span>
            <span><em>Planned Buy</em><strong>{formatUsdPrice(status?.cycle.plannedBuyPrice ?? null)}</strong></span>
            <span><em>Buy State</em><strong>{status?.cycle.buyBlockReason ?? "armed"}</strong></span>
            <span><em>Delta</em><strong>{formatBtcDelta(status)}</strong></span>
            <span><em>Cycle</em><strong>{status?.cycle.cyclePhase ?? "—"}</strong></span>
          </div>
          <div className="btc15m-cycle-grid">
            <div>
              <h3>Buy order</h3>
              {status?.cycle.buyOrder ? (
                <dl><dt>Side</dt><dd>{status.cycle.buyOrder.bettingSide.toUpperCase()}</dd><dt>Price</dt><dd>{formatUsdPrice(status.cycle.buyOrder.price)}</dd><dt>Size</dt><dd>{formatPosNum(status.cycle.buyOrder.size)}</dd><dt>Status</dt><dd>{status.cycle.buyOrder.status}</dd></dl>
              ) : <p className="status status-muted">none</p>}
            </div>
            <div>
              <h3>Position</h3>
              {status?.cycle.position ? (
                <dl><dt>Side</dt><dd>{status.cycle.position.bettingSide.toUpperCase()}</dd><dt>Shares</dt><dd>{formatPosNum(status.cycle.position.shares)}</dd><dt>Avg</dt><dd>{formatUsdPrice(status.cycle.position.avgEntryPrice)}</dd><dt>Cost</dt><dd>{formatUsd(status.cycle.position.costBasisUsd)}</dd>{showPositionStop ? <><dt>Stop</dt><dd className="pnl-neg">{formatUsdPrice(status.cycle.trailStopPrice ?? null)}</dd></> : null}</dl>
              ) : showPositionPlannedBuy ? (
                <dl><dt>Planned Buy</dt><dd className="btc15m-value-gold">{formatUsdPrice(status?.cycle.plannedBuyPrice ?? null)}</dd></dl>
              ) : <p className="status status-muted">none</p>}
            </div>
            <div>
              <h3>Sell order</h3>
              {status?.cycle.sellOrder ? (
                <dl><dt>Price</dt><dd>{formatUsdPrice(status.cycle.sellOrder.price)}</dd><dt>Size</dt><dd>{formatPosNum(status.cycle.sellOrder.size)}</dd><dt>Status</dt><dd>{status.cycle.sellOrder.status}</dd><dt>Order</dt><dd>{status.cycle.sellOrder.orderId ?? "—"}</dd></dl>
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
            <span>Trades: {analytics?.totalTrades ?? 0}</span>
            <span>Wins: {analytics?.wins ?? 0}</span>
            <span>Losses: {analytics?.losses ?? 0}</span>
            <span>Win rate: {((analytics?.winRate ?? 0) * 100).toFixed(1)}%</span>
            <span>PnL: {formatUsd(analytics?.totalPnlUsd)}</span>
          </div>
          <div className="positions-table-wrap">
            <table className="positions-table btc15m-trade-table">
              <thead><tr><th>Time</th><th>Market</th><th>Side</th><th>Buy</th><th>Sell</th><th>Qty</th><th>PnL</th><th>Result</th><th>Exit</th></tr></thead>
              <tbody>
                {trades.slice().reverse().map((trade) => (
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
                {trades.length === 0 ? (
                  <tr><td colSpan={9} className="status status-muted">No trades yet.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </article>
      </section>
    </main>
  );
}
