import { useEffect, useState } from "react";

import {
  getBtc15mHedgeStatus,
  startBtc15mHedgeBot,
  stopBtc15mHedgeBot,
  checkMarket,
} from "../../shared/api/btc15mHedge";
import { formatTimeRemaining } from "../../shared/lib/dates";
import {
  formatBtcDelta,
  formatBtcPrice,
  formatPosNum,
  formatUsd,
  formatUsdPrice,
} from "../../shared/lib/format";
import type { Btc15mHedgeStatusPayload, CheckMarketPayload } from "../../shared/types/api";

type AddToast = (
  type: "info" | "success" | "warn" | "error",
  title: string,
  message: string,
) => void;

type Btc15mHedgeScreenProps = {
  addToast: AddToast;
};

export function Btc15mHedgeScreen({ addToast }: Btc15mHedgeScreenProps) {
  const [status, setStatus] = useState<Btc15mHedgeStatusPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [marketUrl, setMarketUrl] = useState("");
  const [marketInfo, setMarketInfo] = useState<CheckMarketPayload | null>(null);
  const [checkingMarket, setCheckingMarket] = useState(false);
  const [formConfig, setFormConfig] = useState({
    buyPrice: 0.40,
    shares: 5,
  });
  const [buyPriceInput, setBuyPriceInput] = useState("0.40");
  const [sharesInput, setSharesInput] = useState("5");
  const [isInitialized, setIsInitialized] = useState(false);

  const cycle = status?.cycle;
  const pairedShares = cycle?.pairedShares || 0;
  const upAvg = cycle?.upLeg.avgEntryPrice || 0;
  const downAvg = cycle?.downLeg.avgEntryPrice || 0;
  const combinedAvg = upAvg && downAvg ? upAvg + downAvg : 0;
  const unpairedUp = cycle ? Math.max(0, cycle.upLeg.filledShares - pairedShares) : 0;
  const unpairedDown = cycle ? Math.max(0, cycle.downLeg.filledShares - pairedShares) : 0;

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const payload = await getBtc15mHedgeStatus();
        if (!cancelled) {
          setStatus(payload);
        }
      } catch (error) {
        if (!cancelled) {
          addToast("error", "BTC 15m Hedge status failed", error instanceof Error ? error.message : "Unknown error");
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

    if (!isInitialized || status.enginePhase === "running") {
      setFormConfig({
        buyPrice: status.config.buyPrice,
        shares: status.config.shares,
      });
      setBuyPriceInput(status.config.buyPrice.toFixed(2));
      setSharesInput(String(status.config.shares));
      setMarketUrl(status.config.marketUrl);
      setIsInitialized(true);
    }
  }, [status, isInitialized]);

  // Poll prices every 10s while a valid market is being viewed
  useEffect(() => {
    if (!marketInfo?.valid || !marketUrl.trim()) {
      return;
    }

    const interval = setInterval(async () => {
      try {
        const result = await checkMarket(marketUrl);
        if (result.valid) {
          setMarketInfo(result);
        }
      } catch {
        // silent — keep last known prices
      }
    }, 10000);

    return () => clearInterval(interval);
  }, [marketInfo?.valid, marketUrl]);

  async function loadStatus() {
    setLoading(true);
    try {
      const payload = await getBtc15mHedgeStatus();
      setStatus(payload);
    } catch (error) {
      addToast("error", "BTC 15m Hedge status failed", error instanceof Error ? error.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  async function handleCheckMarket() {
    if (!marketUrl.trim()) {
      addToast("warn", "Market URL required", "Please enter a market URL");
      return;
    }

    setCheckingMarket(true);
    try {
      const result = await checkMarket(marketUrl);

      if (result.valid && result.isExpired && result.currentMarket) {
        const currentUrl = `https://polymarket.com/event/${result.currentMarket.slug}`;
        setMarketUrl(currentUrl);
        // Re-check the current market so the UI shows ACTIVE + fresh prices
        try {
          const freshResult = await checkMarket(currentUrl);
          setMarketInfo(freshResult);
        } catch {
          // Fall back to the original result so the user still sees data
          setMarketInfo(result);
        }
        addToast("info", "Switched to current market", result.currentMarket.question);
      } else {
        setMarketInfo(result);
        if (result.valid) {
          addToast("success", "Market valid", `${result.crypto} ${result.timeframe} market found`);
        } else {
          addToast("error", "Invalid market", result.error || "Could not parse market");
        }
      }
    } catch (error) {
      addToast("error", "Check market failed", error instanceof Error ? error.message : "Unknown error");
    } finally {
      setCheckingMarket(false);
    }
  }

  // Computed: is the market expired with no replacement?
  const isMarketExpiredNoReplacement = marketInfo?.isExpired === true && !marketInfo?.currentMarket;

  async function toggleBot() {
    if (loading) {
      return;
    }

    const isActive = status?.enginePhase === "running";
    setLoading(true);
    try {
      if (isActive) {
        const payload = await stopBtc15mHedgeBot();
        setStatus(payload);
        addToast("success", "Hedge bot stopped", "Bot stopped.");
      } else {
        if (!marketUrl.trim()) {
          addToast("error", "Market URL required", "Please enter a market URL and check it first");
          setLoading(false);
          return;
        }

        // Block starting on expired markets
        if (isMarketExpiredNoReplacement) {
          addToast("error", "Market expired", "This market has expired and no active replacement was found. Please use a link to a currently active market.");
          setLoading(false);
          return;
        }

        const buyPrice = Number.parseFloat(buyPriceInput);
        const shares = Number.parseInt(sharesInput, 10);
        if (!Number.isFinite(buyPrice) || buyPrice <= 0 || !Number.isFinite(shares) || shares <= 0) {
          addToast("error", "Invalid order settings", "Enter a buy price like 0.40 and shares greater than 0.");
          setLoading(false);
          return;
        }
        
        const payload = await startBtc15mHedgeBot({
          marketUrl: marketUrl.trim(),
          buyPrice,
          shares,
        });
        setStatus(payload);
        setMarketInfo(null); // switch to live monitor
        addToast("success", "Hedge bot started", "Placing limit orders on both UP and DOWN");
      }
    } catch (error) {
      addToast("error", "Hedge bot toggle failed", error instanceof Error ? error.message : "Unknown error");
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
            <p className="section-kicker">Universal crypto hedging</p>
            <h2>UP + DOWN paired hedge bot</h2>
          </div>
          <div className="btc15m-actions">
            <button className="button button-secondary" onClick={() => void loadStatus()} type="button" disabled={loading}>
              {loading ? "..." : "Refresh"}
            </button>
            <button className={`button ${status?.enginePhase === "running" ? "button-secondary" : "button-primary"}`} onClick={() => void toggleBot()} type="button" disabled={loading || (status?.enginePhase !== "running" && isMarketExpiredNoReplacement)}>
              {loading ? "..." : status?.enginePhase === "running" ? "Stop Bot" : isMarketExpiredNoReplacement ? "Market Expired" : "Start Bot"}
            </button>
          </div>
        </div>

        <article className="btc15m-card">
          <div className="panel-head">
            <div>
              <p className="section-kicker">Market selection</p>
              <h2>Check market</h2>
            </div>
          </div>
          <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem" }}>
            <input
              type="text"
              placeholder="https://polymarket.com/event/..."
              value={marketUrl}
              onChange={(e) => setMarketUrl(e.target.value)}
              style={{ flex: 1, padding: "0.5rem", fontSize: "0.9rem" }}
            />
            <button 
              className="button button-primary" 
              onClick={() => void handleCheckMarket()} 
              type="button" 
              disabled={checkingMarket}
            >
              {checkingMarket ? "Checking..." : "Check Market"}
            </button>
          </div>

          {marketInfo ? (
            <div className="btc15m-monitor-grid">
              <span><em>Valid</em><strong className={marketInfo.valid ? "pnl-pos" : "pnl-neg"}>{marketInfo.valid ? "YES" : "NO"}</strong></span>
              <span><em>Crypto</em><strong>{marketInfo.crypto ?? "—"}</strong></span>
              <span><em>Timeframe</em><strong>{marketInfo.timeframe ?? "—"}</strong></span>
              <span><em>Status</em><strong className={marketInfo.isExpired ? "pnl-neg" : "pnl-pos"}>{marketInfo.isExpired ? "EXPIRED" : "ACTIVE"}</strong></span>
              {marketInfo.valid && marketInfo.endTimeMs ? (
                <span><em>Time left</em><strong>{formatTimeRemaining(marketInfo.endTimeMs)}</strong></span>
              ) : null}
              {marketInfo.currentMarket ? (
                <span><em>Active market</em><strong>{marketInfo.currentMarket.slug}</strong></span>
              ) : null}
              {marketInfo.valid && (marketInfo.upPrice != null || marketInfo.downPrice != null) ? (
                <>
                  <span><em>UP Price</em><strong className="btc15m-value-gold">{formatUsdPrice(marketInfo.upPrice)}</strong></span>
                  <span><em>DOWN Price</em><strong className="btc15m-value-gold">{formatUsdPrice(marketInfo.downPrice)}</strong></span>
                </>
              ) : null}
            </div>
          ) : null}
        </article>

        <article className="btc15m-card">
          <div className="panel-head">
            <div>
              <p className="section-kicker">Order settings</p>
              <h2>Limit order configuration</h2>
            </div>
          </div>
          <div className="btc15m-settings-grid">
            <label className="btc15m-settings-field">
              <span>Buy price ($)</span>
              <input
                type="text"
                inputMode="decimal"
                placeholder="0.40"
                value={buyPriceInput}
                disabled={status?.enginePhase === "running"}
                onChange={(event) => {
                  const nextValue = event.target.value.replace(",", ".");
                  if (!/^\d*(?:\.\d{0,2})?$/.test(nextValue)) {
                    return;
                  }
                  setBuyPriceInput(nextValue);
                  const parsed = Number.parseFloat(nextValue);
                  setFormConfig((previous) => ({
                    ...previous,
                    buyPrice: Number.isFinite(parsed) ? parsed : 0,
                  }));
                }}
              />
            </label>
            <label className="btc15m-settings-field">
              <span>Shares per side</span>
              <input
                type="text"
                inputMode="numeric"
                placeholder="5"
                value={sharesInput}
                disabled={status?.enginePhase === "running"}
                onChange={(event) => {
                  const nextValue = event.target.value.replace(/\D+/g, "");
                  setSharesInput(nextValue);
                  const parsed = Number.parseInt(nextValue, 10);
                  setFormConfig((previous) => ({
                    ...previous,
                    shares: Number.isFinite(parsed) ? parsed : 0,
                  }));
                }}
              />
            </label>
          </div>
          <p className="status status-muted" style={{ marginTop: "0.5rem" }}>
            Bot will place limit orders: {formConfig.shares} shares @ ${formConfig.buyPrice.toFixed(2)} on both UP and DOWN
          </p>
          {status?.enginePhase === "auto_stopped" ? <p className="status status-warn">Auto-stopped after budget exhaustion.</p> : null}
          {status?.lastError ? <p className="status status-error">{status.lastError}</p> : null}
        </article>

        <div className="btc15m-summary-grid">
          <article className="btc15m-stat-card"><span>Engine</span><strong className={status?.enginePhase === "running" ? "pnl-pos" : "pnl-neg"}>{status?.enginePhase?.toUpperCase() ?? "STOPPED"}</strong></article>
          <article className="btc15m-stat-card"><span>Mode</span><strong>{status?.dryRun === false ? "LIVE" : "SIM"}</strong></article>
          <article className="btc15m-stat-card"><span>Phase</span><strong>{status?.cycle.phase ?? "—"}</strong></article>
          <article className="btc15m-stat-card"><span>Paired Shares</span><strong>{status?.cycle.pairedShares ?? 0}</strong></article>
          <article className="btc15m-stat-card"><span>UP Filled</span><strong>{status?.cycle.upLeg.filledShares ?? 0}</strong></article>
          <article className="btc15m-stat-card"><span>DOWN Filled</span><strong>{status?.cycle.downLeg.filledShares ?? 0}</strong></article>
        </div>

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
            <span><em>Phase</em><strong>{status?.cycle.phase ?? "—"}</strong></span>
          </div>

          <div className="btc15m-side-split">
            {([
              { key: "up" as const, leg: status?.cycle.upLeg, titleCls: "btc15m-side-title-up" },
              { key: "down" as const, leg: status?.cycle.downLeg, titleCls: "btc15m-side-title-down" },
            ]).map(({ key, leg, titleCls }) => (
              <div key={key} className="btc15m-side-col">
                <h3 className={`btc15m-side-title ${titleCls}`}>{key.toUpperCase()}</h3>
                <div className="btc15m-monitor-grid">
                  <span><em>Token ID</em><strong>{leg?.tokenId ?? "—"}</strong></span>
                  <span><em>Order Price</em><strong>{formatUsdPrice(leg?.orderPrice ?? null)}</strong></span>
                  <span><em>Order Size</em><strong>{leg?.orderSize ?? 0}</strong></span>
                  <span><em>Order Status</em><strong>{leg?.orderStatus ?? "—"}</strong></span>
                  <span><em>Filled Shares</em><strong>{leg?.filledShares ?? 0}</strong></span>
                  <span><em>Filled Cost</em><strong>{formatUsd(leg?.filledCostUsd)}</strong></span>
                  <span><em>Avg Entry</em><strong>{formatUsdPrice(leg?.avgEntryPrice ?? null)}</strong></span>
                </div>
              </div>
            ))}
          </div>

          {cycle && (cycle.upLeg.filledShares > 0 || cycle.downLeg.filledShares > 0) ? (
            <div className="btc15m-monitor-grid" style={{ marginTop: "1rem", borderTop: "1px solid var(--border-color, #333)", paddingTop: "1rem" }}>
              <span><em>Paired Shares</em><strong className="pnl-pos">{pairedShares}</strong></span>
              <span><em>Avg UP</em><strong>{formatUsdPrice(upAvg)}</strong></span>
              <span><em>Avg DOWN</em><strong>{formatUsdPrice(downAvg)}</strong></span>
              <span><em>Combined Average</em><strong className="btc15m-value-gold">{formatUsdPrice(combinedAvg)}</strong></span>
              <span><em>Unpaired UP</em><strong>{unpairedUp}</strong></span>
              <span><em>Unpaired DOWN</em><strong>{unpairedDown}</strong></span>
            </div>
          ) : null}
        </article>

        <article className="btc15m-card">
          <div className="panel-head">
            <div>
              <p className="section-kicker">History</p>
              <h2>Completed cycles</h2>
            </div>
          </div>
          <div className="positions-table-wrap">
            <table className="positions-table btc15m-trade-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Market</th>
                  <th>Buy Price</th>
                  <th>Shares</th>
                  <th>UP Filled</th>
                  <th>DOWN Filled</th>
                  <th>Avg UP</th>
                  <th>Avg DOWN</th>
                  <th>Combined</th>
                  <th>Total Cost</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {status?.completedCycles.slice().reverse().map((cycle) => {
                  const combined = (cycle.avgUpPrice || 0) + (cycle.avgDownPrice || 0);
                  return (
                    <tr key={cycle.id}>
                      <td>{new Date(cycle.closedAt).toLocaleString()}</td>
                      <td>{cycle.marketSlug}</td>
                      <td>{formatUsdPrice(cycle.buyPrice)}</td>
                      <td>{cycle.shares}</td>
                      <td>{cycle.upFilled}</td>
                      <td>{cycle.downFilled}</td>
                      <td>{formatUsdPrice(cycle.avgUpPrice)}</td>
                      <td>{formatUsdPrice(cycle.avgDownPrice)}</td>
                      <td className="btc15m-value-gold">{combined ? formatUsdPrice(combined) : "—"}</td>
                      <td>{formatUsd(cycle.totalCostUsd)}</td>
                      <td>{cycle.result}</td>
                    </tr>
                  );
                })}
                {!status?.completedCycles.length ? (
                  <tr><td colSpan={11} className="status status-muted">No completed cycles yet.</td></tr>
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
            {status?.logs.slice().reverse().slice(0, 50).map((log, index) => (
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
