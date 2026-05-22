import { useEffect, useRef, useState } from "react";

import {
  getBtc5mStatus,
  toggleBtc5mBot as toggleBtc5mBotRequest,
} from "../../shared/api/btc5m";
import {
  describeBtc5mStatus,
  formatBtc5mPrice,
  formatPosDate,
  formatPosNum,
} from "../../shared/lib/format";
import type { Btc5mBotStatus } from "../../shared/types/api";

type AddToast = (
  type: "info" | "success" | "warn" | "error",
  title: string,
  message: string,
) => void;

type Btc5mScreenProps = {
  addToast: AddToast;
  refreshAccountSummary: () => Promise<void>;
};

export function Btc5mScreen({
  addToast,
  refreshAccountSummary,
}: Btc5mScreenProps) {
  const [status, setStatus] = useState<Btc5mBotStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const previousCompletedMarketRef = useRef<string | null>(null);

  useEffect(() => {
    void loadStatus();
  }, []);

  useEffect(() => {
    const completionKey = status?.lastCompletedMarketSlug ?? null;
    if (!completionKey || previousCompletedMarketRef.current === completionKey) {
      return;
    }

    previousCompletedMarketRef.current = completionKey;
    void refreshAccountSummary();
  }, [refreshAccountSummary, status]);

  async function loadStatus() {
    setLoading(true);
    try {
      const payload = await getBtc5mStatus();
      setStatus(payload);
    } catch (error) {
      addToast("error", "BTC 5m status failed", error instanceof Error ? error.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  async function toggleBot() {
    const isActive = Boolean(status?.active);
    setLoading(true);
    try {
      const payload = await toggleBtc5mBotRequest(isActive);
      setStatus(payload);
      addToast(
        "success",
        isActive ? "BTC 5m bot stopped" : "BTC 5m bot started",
        isActive ? "Bot stopped." : "Bot will buy UP at 60¢ and sell all UP shares at 70¢.",
      );
      if (payload.lastCompletedMarketSlug && payload.lastCompletedMarketSlug !== previousCompletedMarketRef.current) {
        previousCompletedMarketRef.current = payload.lastCompletedMarketSlug;
        await refreshAccountSummary();
      }
    } catch (error) {
      addToast("error", "BTC 5m toggle failed", error instanceof Error ? error.message : "Unknown error");
    } finally {
      setLoading(false);
      void loadStatus();
    }
  }

  return (
    <main className="layout layout-single">
      <section className="panel btc5m-panel">
        <div className="panel-head">
          <div>
            <p className="section-kicker">Bitcoin 5-minute markets</p>
            <h2>UP 60¢ → 70¢ scalper</h2>
          </div>
          <div className="btc5m-actions">
            <button className="button button-secondary" onClick={() => void loadStatus()} type="button" disabled={loading}>{loading ? "..." : "Refresh"}</button>
            <button className={`button ${status?.active ? "button-secondary" : "button-primary"}`} onClick={() => void toggleBot()} type="button" disabled={loading}>{loading ? "..." : status?.active ? "Stop Bot" : "Start Bot"}</button>
          </div>
        </div>

        <div className="btc5m-summary-grid">
          <article className="btc5m-stat-card"><span>Status</span><strong className={status?.active ? "pnl-pos" : "pnl-neg"}>{status?.active ? "ACTIVE" : "STOPPED"}</strong></article>
          <article className="btc5m-stat-card"><span>Mode</span><strong>{status?.dryRun ? "dry-run" : "live"}</strong></article>
          <article className="btc5m-stat-card"><span>Buy / Sell</span><strong>{formatBtc5mPrice(status?.buyPriceLimit)} / {formatBtc5mPrice(status?.sellPriceLimit)}</strong></article>
          <article className="btc5m-stat-card"><span>Order Size</span><strong>{formatPosNum(status?.orderSize)}</strong></article>
        </div>

        <p className="status">{describeBtc5mStatus(status)}</p>

        <article className="btc5m-current-market-card">
          <div className="panel-head">
            <div>
              <p className="section-kicker">Current market</p>
              <h2>{status?.currentMarket?.question ?? "No active market found yet"}</h2>
            </div>
            {status?.currentMarket?.slug ? <a className="positions-link" href={`https://polymarket.com/event/${status.currentMarket.slug}`} target="_blank" rel="noreferrer">Open market ↗</a> : null}
          </div>
          <div className="btc5m-market-meta">
            <span>Slug: {status?.currentMarket?.slug ?? "—"}</span>
            <span>UP token: {status?.currentMarket?.upTokenId ?? "—"}</span>
            <span>Ends: {status?.currentMarket?.endDateIso ? formatPosDate(status.currentMarket.endDateIso) : "—"}</span>
            <span>Buy order: {status?.buyOrderId ?? "—"}</span>
            <span>Sell order: {status?.sellOrderId ?? "—"}</span>
            <span>Last completed: {status?.lastCompletedMarketSlug ?? "—"}</span>
          </div>
        </article>

        <article className="btc5m-current-market-card">
          <div className="panel-head">
            <div>
              <p className="section-kicker">Next market</p>
              <h2>{status?.nextMarket?.question ?? "No next 5-minute market queued yet"}</h2>
            </div>
            {status?.nextMarket?.slug ? <a className="positions-link" href={`https://polymarket.com/event/${status.nextMarket.slug}`} target="_blank" rel="noreferrer">Open next ↗</a> : null}
          </div>
          <div className="btc5m-market-meta">
            <span>Slug: {status?.nextMarket?.slug ?? "—"}</span>
            <span>Starts: {status?.nextMarket?.startDateIso ? formatPosDate(status.nextMarket.startDateIso) : "—"}</span>
            <span>Ends: {status?.nextMarket?.endDateIso ? formatPosDate(status.nextMarket.endDateIso) : "—"}</span>
            <span>Planned buy: {formatBtc5mPrice(status?.buyPriceLimit)} on UP</span>
            <span>Shares: {formatPosNum(status?.orderSize)}</span>
          </div>
        </article>

        {status?.lastError ? <div className="empty-state"><strong>Last error</strong><p>{status.lastError}</p></div> : null}

        <article className="btc5m-log-card">
          <div className="panel-head">
            <div>
              <p className="section-kicker">Bot log</p>
              <h2>Execution timeline</h2>
            </div>
          </div>
          {!status?.logs?.length ? (
            <p className="status status-muted">No BTC 5m bot events yet.</p>
          ) : (
            <div className="positions-table-wrap">
              <table className="positions-table">
                <thead><tr><th>Time</th><th>Type</th><th>Message</th></tr></thead>
                <tbody>
                  {status.logs.map((entry, index) => (
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
  );
}
