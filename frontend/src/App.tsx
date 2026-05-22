import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  getBtc15mStatus,
  resetBtc15mBudget as resetBtc15mBudgetRequest,
  toggleBtc15mBot as toggleBtc15mBotRequest,
} from "./shared/api/btc15m";
import { formatTimeRemaining } from "./shared/lib/dates";
import {
  formatBtcDelta,
  formatBtcPrice,
  formatPosDate,
  formatPosNum,
  formatUsd,
  formatUsdPrice,
} from "./shared/lib/format";
import { useToasts } from "./shared/hooks/useToasts";
import type { AppShellRenderProps } from "./app/AppShell";
import type { Btc15mCompletedTrade, Btc15mStatusPayload } from "./shared/types/api";
import { Btc5mScreen } from "./screens/btc5m/Btc5mScreen";
import { PositionsScreen } from "./screens/positions/PositionsScreen";
import { WeatherScreen } from "./screens/weather/WeatherScreen";

type AppProps = AppShellRenderProps;

export function App({ activeTab, setTabsVisible, shellControls }: AppProps) {
  const { addToast, removeToast, toasts } = useToasts();

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

  const btc15mAnalytics = btc15mStatus?.dryRun
    ? btc15mStatus.sessionAnalytics
    : btc15mStatus?.analytics;
  const btc15mTrades: Btc15mCompletedTrade[] = btc15mStatus?.dryRun
    ? (btc15mStatus.sessionTrades ?? [])
    : (btc15mStatus?.completedTrades ?? []);

  useEffect(() => {
    setTabsVisible(true);
  }, [activeTab, setTabsVisible]);

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
    const intervalId = setInterval(() => void load(), 3000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [activeTab, addToast]);

  useEffect(() => {
    if (!btc15mStatus?.config) {
      return;
    }

    const phase = btc15mStatus.enginePhase;
    const previousPhase = btc15mPrevPhaseRef.current;
    btc15mPrevPhaseRef.current = phase;

    const isFirstLoad = previousPhase === null;
    const justStopped = previousPhase === "running" && phase !== "running";
    if (!isFirstLoad && !justStopped) {
      return;
    }
    if (phase === "running") {
      return;
    }

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
  }, [btc15mStatus]);

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

  return (
    <>
      <div className="toast-stack">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.type}`}>
            <span className="toast-icon">
              {toast.type === "error" ? "✖" : toast.type === "warn" ? "⚠" : toast.type === "success" ? "✔" : "ℹ"}
            </span>
            <div className="toast-body">
              <strong>{toast.title}</strong>
              <span>{toast.message}</span>
            </div>
            <button className="toast-close" onClick={() => removeToast(toast.id)}>
              ×
            </button>
          </div>
        ))}
      </div>

      {activeTab === "positions" ? (
        <PositionsScreen
          addToast={addToast}
          setTabsVisible={setTabsVisible}
          shellControls={shellControls}
        />
      ) : activeTab === "weather" ? (
        <WeatherScreen shellControls={shellControls} />
      ) : activeTab === "btc5m" ? (
        <Btc5mScreen addToast={addToast} refreshAccountSummary={shellControls.refreshAccountSummary} />
      ) : (
        <main className="layout layout-single btc15m-tab">
          <section className="panel btc15m-panel">
            <div className="panel-head">
              <div>
                <p className="section-kicker">Bitcoin 15-minute markets</p>
                <h2>Contrarian 25¢ → 40¢ bot</h2>
              </div>
              <div className="btc15m-actions">
                <button className="button button-secondary" onClick={() => void loadBtc15mStatus()} type="button" disabled={btc15mLoading}>{btc15mLoading ? "..." : "Refresh"}</button>
                <button className="button button-secondary" onClick={() => void resetBtc15mBudget()} type="button" disabled={btc15mLoading}>{btc15mLoading ? "..." : "Clear budget"}</button>
                <button className={`button ${btc15mStatus?.enginePhase === "running" ? "button-secondary" : "button-primary"}`} onClick={() => void toggleBtc15mBot()} type="button" disabled={btc15mLoading}>
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
                      onChange={(event) => setBtc15mFormConfig((previous) => ({ ...previous, [key]: Number(event.target.value) }))}
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
                    {btc15mTrades.length === 0 ? (
                      <tr><td colSpan={9} className="status status-muted">No trades yet.</td></tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </article>
          </section>
        </main>
      )}
    </>
  );
}
