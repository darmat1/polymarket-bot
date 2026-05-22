import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  getBtc15mStatus,
  resetBtc15mBudget as resetBtc15mBudgetRequest,
  toggleBtc15mBot as toggleBtc15mBotRequest,
} from "./shared/api/btc15m";
import {
  getBtc5mStatus,
  toggleBtc5mBot as toggleBtc5mBotRequest,
} from "./shared/api/btc5m";
import { formatTimeRemaining } from "./shared/lib/dates";
import {
  describeBtc5mStatus,
  formatBtc5mPrice,
  formatBtcDelta,
  formatBtcPrice,
  formatPosDate,
  formatPosNum,
  formatUsd,
  formatUsdPrice,
} from "./shared/lib/format";
import { useToasts } from "./shared/hooks/useToasts";
import type { AppShellRenderProps } from "./app/AppShell";
import type { Btc15mCompletedTrade, Btc15mStatusPayload, Btc5mBotStatus } from "./shared/types/api";
import { PositionsScreen } from "./screens/positions/PositionsScreen";
import { WeatherScreen } from "./screens/weather/WeatherScreen";

type AppProps = AppShellRenderProps;

export function App({ activeTab, setTabsVisible, shellControls }: AppProps) {
  const { addToast, removeToast, toasts } = useToasts();

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
        <main className="layout layout-single">
          <section className="panel btc5m-panel">
            <div className="panel-head">
              <div>
                <p className="section-kicker">Bitcoin 5-minute markets</p>
                <h2>UP 60¢ → 70¢ scalper</h2>
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

            <StatusText>{describeBtc5mStatus(btc5mStatus)}</StatusText>

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
                <StatusText tone="muted">No BTC 5m bot events yet.</StatusText>
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

function StatusText({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "muted";
}) {
  return <p className={`status${tone === "muted" ? " status-muted" : ""}`}>{children}</p>;
}
