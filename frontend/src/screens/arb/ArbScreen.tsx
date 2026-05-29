import { useEffect, useRef, useState } from "react";
import type { ArbOpportunity, ArbScanResult, ArbScanStreamEvent } from "../../shared/api/arb";

const GOLD = "#ffd93d";
const MINT = "#6bcb77";
const ROSE = "#ff6b6b";
const DIM  = "#555";

function fmt(v: number) {
  return (v * 100).toFixed(1) + "¢";
}

function fmtUsd(v: number) {
  return "$" + v.toFixed(2);
}

function fmtSignedUsd(v: number) {
  return `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
}

function fmtShares(v: number) {
  return v.toFixed(v >= 10 ? 1 : 2);
}

function ArbRow({ opp }: { opp: ArbOpportunity }) {
  const [open, setOpen] = useState(false);
  const isSplit = opp.arbType === "split";
  const execution = opp.execution;
  const watch = opp.watchPlan;
  const profitColor = execution.netProfitUsd > 0 ? MINT : GOLD;
  const missingBins = isSplit ? opp.binCount - opp.binsWithBid : opp.binCount - opp.binsWithAsk;
  const investorNetColor = !execution.investorExecutable
    ? GOLD
    : (execution.investorNetProfitUsd ?? 0) > 0 ? MINT : ROSE;
  const investorNetLine = execution.investorExecutable && execution.investorNetReturnUsd !== null
    ? `$${execution.investorInputUsd.toFixed(0)} → ${fmtUsd(execution.investorNetReturnUsd)}`
    : "$1 → no depth";
  const investorGrossLine = execution.investorExecutable && execution.investorGrossReturnUsd !== null
    ? `gross ${fmtUsd(execution.investorGrossReturnUsd)}`
    : "gross unavailable";

  return (
    <>
      <tr
        onClick={() => setOpen(o => !o)}
        style={{ cursor: "pointer", borderBottom: "1px solid #1e1e2e" }}
      >
        <td style={{ padding: "10px 12px", color: "#e0e0e0", maxWidth: 340 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: "monospace", fontSize: 13 }}>{opp.eventTitle}</span>
            {opp.isClean && (
              <span title="Current book depth supports a positive-net executable arb" style={{
                background: "rgba(107,203,119,0.2)",
                color: MINT,
                border: `1px solid ${MINT}`,
                borderRadius: 4,
                padding: "1px 6px",
                fontSize: 11,
                fontFamily: "monospace",
                whiteSpace: "nowrap",
              }}>
                🔒 CLEAN ARB
              </span>
            )}
            {!opp.isClean && watch.watchable && (
              <span title={watch.reason} style={{
                background: "rgba(255,217,61,0.14)",
                color: GOLD,
                border: `1px solid ${GOLD}`,
                borderRadius: 4,
                padding: "1px 6px",
                fontSize: 11,
                fontFamily: "monospace",
                whiteSpace: "nowrap",
              }}>
                WATCH
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: DIM, marginTop: 3 }}>
            {opp.binCount} bins · vol ${(opp.volume / 1000).toFixed(0)}k · liq ${(opp.liquidity / 1000).toFixed(0)}k
            {!execution.executable && missingBins > 0 && (
              <span style={{ color: GOLD, marginLeft: 6 }}>
                ⚠ {missingBins}/{opp.binCount} bins unsellable
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: investorNetColor, marginTop: 3, fontFamily: "monospace" }}>
            Net $1: {investorNetLine}
            {execution.investorNetProfitUsd !== null && (
              <span style={{ color: DIM }}> ({fmtSignedUsd(execution.investorNetProfitUsd)})</span>
            )}
          </div>
          {watch.watchable && (
            <div style={{ fontSize: 11, color: GOLD, marginTop: 3, fontFamily: "monospace" }}>
              Watch: sell now {fmtUsd(watch.immediateReturnUsd)}, hold {watch.heldBins.length} bin{watch.heldBins.length === 1 ? "" : "s"}, target avg {watch.targetAvgFutureBid !== null ? fmt(watch.targetAvgFutureBid) : "–"}
            </div>
          )}
        </td>
        <td style={{ padding: "10px 12px", textAlign: "center" }}>
          <span style={{
            background: isSplit ? "rgba(107,203,119,0.15)" : "rgba(255,217,61,0.15)",
            color: isSplit ? MINT : GOLD,
            border: `1px solid ${isSplit ? MINT : GOLD}`,
            borderRadius: 4,
            padding: "2px 8px",
            fontSize: 12,
            fontFamily: "monospace",
          }}>
            {isSplit ? "↑ SPLIT" : "↓ MERGE"}
          </span>
        </td>
        <td style={{ padding: "10px 12px", textAlign: "right", fontFamily: "monospace", fontSize: 13 }}>
          <div style={{ color: profitColor }}>{fmtSignedUsd(execution.netProfitUsd)} net</div>
          <div style={{ color: DIM, fontSize: 10, marginTop: 2 }}>
            size {fmtUsd(execution.maxInvestmentUsd)}
          </div>
          <div style={{ color: DIM, fontSize: 10, marginTop: 2 }}>
            {(execution.netProfitPerDollar * 100).toFixed(2)}¢ / $1 after buffer
          </div>
        </td>
        <td style={{ padding: "10px 12px", textAlign: "right", fontFamily: "monospace", color: "#aaa", fontSize: 12 }}>
          <div>{isSplit ? fmt(opp.sumBids) : fmt(opp.sumAsks)}</div>
          {execution.avgExecutionSum !== null && (
            <div style={{ color: DIM, fontSize: 10, marginTop: 2 }}>
              avg {fmt(execution.avgExecutionSum)}
            </div>
          )}
        </td>
        <td style={{ padding: "10px 12px", textAlign: "center", color: DIM, fontSize: 12 }}>
          {open ? "▲" : "▼"}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} style={{ background: "#0d0d1a", padding: "10px 16px 16px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, marginBottom: 10, fontFamily: "monospace", fontSize: 11 }}>
              <div style={{ color: "#ccc" }}>
                <div style={{ color: DIM }}>Net $1 return</div>
                <div style={{ color: investorNetColor }}>
                  {investorNetLine}
                </div>
                <div style={{ color: DIM, marginTop: 2 }}>{investorGrossLine}</div>
              </div>
              <div style={{ color: "#ccc" }}>
                <div style={{ color: DIM }}>Max executable</div>
                <div>{fmtUsd(execution.maxInvestmentUsd)} → {fmtUsd(execution.maxReturnUsd)}</div>
              </div>
              <div style={{ color: "#ccc" }}>
                <div style={{ color: DIM }}>Net after buffers</div>
                <div style={{ color: execution.netProfitUsd > 0 ? MINT : GOLD }}>
                  {fmtSignedUsd(execution.netProfitUsd)}
                </div>
              </div>
              <div style={{ color: "#ccc" }}>
                <div style={{ color: DIM }}>Limit</div>
                <div>{execution.limitingBin ?? "no full depth"}</div>
              </div>
            </div>
            {watch.watchable && (
              <div style={{ border: `1px solid rgba(255,217,61,0.35)`, borderRadius: 6, padding: "8px 10px", marginBottom: 10, fontFamily: "monospace", fontSize: 11, color: "#ccc" }}>
                <div style={{ color: GOLD, marginBottom: 4 }}>WATCH / HOLD MONITOR</div>
                <div>
                  If split {fmtUsd(watch.inputUsd)} now: sell liquid bins for {fmtUsd(watch.immediateReturnUsd)}, hold {fmtShares(watch.heldShares)} shares across {watch.heldBins.length} bin{watch.heldBins.length === 1 ? "" : "s"}.
                </div>
                <div style={{ marginTop: 3 }}>
                  Break even needs future held-bin proceeds {fmtUsd(watch.breakEvenFutureReturnUsd)} (avg {watch.requiredAvgFutureBid !== null ? fmt(watch.requiredAvgFutureBid) : "–"}). Target +{fmtUsd(watch.targetProfitUsd)} needs {fmtUsd(watch.targetFutureReturnUsd)} (avg {watch.targetAvgFutureBid !== null ? fmt(watch.targetAvgFutureBid) : "–"}).
                </div>
                <div style={{ color: DIM, marginTop: 3 }}>
                  Buffer included: {fmtUsd(watch.bufferUsd)}. This is monitoring only, not instant arb.
                </div>
              </div>
            )}
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "monospace" }}>
              <thead>
                <tr style={{ color: DIM }}>
                  <th style={{ textAlign: "left", padding: "4px 8px" }}>Bin</th>
                  <th style={{ textAlign: "right", padding: "4px 8px" }}>Bid</th>
                  <th style={{ textAlign: "right", padding: "4px 8px" }}>Ask</th>
                  <th style={{ textAlign: "right", padding: "4px 8px" }}>Depth</th>
                  <th style={{ textAlign: "right", padding: "4px 8px" }}>Avg fill</th>
                  <th style={{ textAlign: "right", padding: "4px 8px" }}>Value</th>
                </tr>
              </thead>
              <tbody>
                {opp.bins.map((b, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid #1a1a2e" }}>
                    <td style={{ padding: "3px 8px", color: b.isLimiting ? GOLD : "#ccc" }}>
                      {b.label}{b.isLimiting ? "  LIMIT" : ""}
                    </td>
                    <td style={{ padding: "3px 8px", textAlign: "right", color: b.bestBid ? "#aef" : DIM }}>
                      {b.bestBid != null ? `${fmt(b.bestBid)} / ${fmtShares(b.bestBidSize ?? 0)}` : "–"}
                    </td>
                    <td style={{ padding: "3px 8px", textAlign: "right", color: b.bestAsk ? "#fca" : DIM }}>
                      {b.bestAsk != null ? `${fmt(b.bestAsk)} / ${fmtShares(b.bestAskSize ?? 0)}` : "–"}
                    </td>
                    <td style={{ padding: "3px 8px", textAlign: "right", color: b.executableDepth > 0 ? "#ccc" : DIM }}>
                      {fmtShares(b.executableDepth)}
                    </td>
                    <td style={{ padding: "3px 8px", textAlign: "right", color: b.avgExecutionPrice !== null ? "#ccc" : DIM }}>
                      {b.avgExecutionPrice !== null ? fmt(b.avgExecutionPrice) : "–"}
                    </td>
                    <td style={{ padding: "3px 8px", textAlign: "right", color: b.executionValue !== null ? "#ccc" : DIM }}>
                      {b.executionValue !== null ? fmtUsd(b.executionValue) : "–"}
                    </td>
                  </tr>
                ))}
                <tr style={{ borderTop: "1px solid #333" }}>
                  <td style={{ padding: "4px 8px", color: DIM }}>Sum</td>
                  <td style={{ padding: "4px 8px", textAlign: "right", color: opp.sumBids > 1 ? MINT : "#aef" }}>
                    {fmt(opp.sumBids)}
                  </td>
                  <td style={{ padding: "4px 8px", textAlign: "right", color: opp.sumAsks < 1 ? MINT : "#fca" }}>
                    {fmt(opp.sumAsks)}
                  </td>
                  <td />
                  <td style={{ padding: "4px 8px", textAlign: "right", color: execution.avgExecutionSum !== null ? MINT : DIM }}>
                    {execution.avgExecutionSum !== null ? fmt(execution.avgExecutionSum) : "–"}
                  </td>
                  <td style={{ padding: "4px 8px", textAlign: "right", color: execution.maxReturnUsd > execution.maxInvestmentUsd ? MINT : GOLD }}>
                    {fmtUsd(execution.maxReturnUsd)}
                  </td>
                </tr>
              </tbody>
            </table>
            <div style={{ color: DIM, fontFamily: "monospace", fontSize: 10, marginTop: 8 }}>
              Buffers: gas {fmtUsd(execution.gasBufferUsd)}, slippage {execution.slippageBufferBps} bps ({fmtUsd(execution.slippageBufferUsd)}). Top-line signal: {(opp.topLineProfitPerDollar * 100).toFixed(2)}¢ / $1.
            </div>
            <div style={{ marginTop: 8 }}>
              <a
                href={`https://polymarket.com/event/${opp.eventSlug}`}
                target="_blank"
                rel="noreferrer"
                style={{ color: GOLD, fontSize: 11, textDecoration: "none" }}
              >
                ↗ Open on Polymarket
              </a>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function ArbScreen() {
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<ArbScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ processedEvents: number; totalEvents: number } | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    return () => {
      sourceRef.current?.close();
    };
  }, []);

  function doScan() {
    sourceRef.current?.close();
    setScanning(true);
    setError(null);
    setProgress(null);
    setResult({
      scannedEvents: 0,
      opportunities: [],
      scannedAt: new Date().toISOString(),
    });

    const source = new EventSource("/api/arb/scan/stream");
    sourceRef.current = source;

    source.onmessage = (event) => {
      let payload: ArbScanStreamEvent;
      try {
        payload = JSON.parse(event.data) as ArbScanStreamEvent;
      } catch {
        setError("Invalid arb scan stream response");
        setScanning(false);
        source.close();
        sourceRef.current = null;
        return;
      }

      if (payload.type === "started") {
        setResult({
          scannedEvents: 0,
          opportunities: [],
          scannedAt: payload.scannedAt,
        });
        return;
      }

      if (payload.type === "error") {
        setError(payload.error);
        setScanning(false);
        source.close();
        sourceRef.current = null;
        return;
      }

      setProgress({
        processedEvents: payload.processedEvents,
        totalEvents: payload.totalEvents,
      });
      setResult((current) => ({
        scannedEvents: payload.totalEvents,
        opportunities: [
          ...(current?.opportunities ?? []),
          ...payload.opportunities,
        ],
        scannedAt: payload.scannedAt,
      }));

      if (payload.type === "done") {
        setScanning(false);
        source.close();
        sourceRef.current = null;
      }
    };

    source.onerror = () => {
      setError("Arb scan stream disconnected");
      setScanning(false);
      source.close();
      sourceRef.current = null;
    };
  }

  return (
    <div style={{ padding: "24px 32px", maxWidth: 1100, margin: "0 auto" }}>
      <h2 style={{ color: GOLD, fontFamily: "monospace", letterSpacing: 2, marginBottom: 24 }}>
        NEG RISK ARB SCANNER
      </h2>

      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24 }}>
        <button
          onClick={doScan}
          disabled={scanning}
          style={{
            background: scanning ? "#333" : MINT,
            color: "#000",
            border: "none",
            borderRadius: 6,
            padding: "10px 28px",
            fontFamily: "monospace",
            fontWeight: 700,
            fontSize: 14,
            cursor: scanning ? "not-allowed" : "pointer",
          }}
        >
          {scanning ? "Scanning…" : "Scan Markets"}
        </button>
        {result && (
          <span style={{ color: DIM, fontSize: 12, fontFamily: "monospace" }}>
            {progress
              ? `Scanned ${progress.processedEvents}/${progress.totalEvents} events`
              : `Scanned ${result.scannedEvents} events`}
            {" · "}
            {new Date(result.scannedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {error && (
        <div style={{ color: ROSE, fontFamily: "monospace", fontSize: 13, marginBottom: 16 }}>{error}</div>
      )}

      {result && result.opportunities.length === 0 && !scanning && (
        <div style={{ color: DIM, fontFamily: "monospace", fontSize: 13 }}>
          No arb opportunities found above threshold.
        </div>
      )}

      {result && result.opportunities.length > 0 && (
        <>
          <div style={{ color: MINT, fontFamily: "monospace", fontSize: 12, marginBottom: 12 }}>
            {result.opportunities.length} opportunit{result.opportunities.length === 1 ? "y" : "ies"} found
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #333" }}>
                <th style={{ textAlign: "left", padding: "8px 12px", color: DIM, fontFamily: "monospace", fontSize: 12, fontWeight: 400 }}>
                  Event
                </th>
                <th style={{ textAlign: "center", padding: "8px 12px", color: DIM, fontFamily: "monospace", fontSize: 12, fontWeight: 400 }}>
                  Type
                </th>
                <th style={{ textAlign: "right", padding: "8px 12px", color: DIM, fontFamily: "monospace", fontSize: 12, fontWeight: 400 }}>
                  Net / Size
                </th>
                <th style={{ textAlign: "right", padding: "8px 12px", color: DIM, fontFamily: "monospace", fontSize: 12, fontWeight: 400 }}>
                  Sum
                </th>
                <th style={{ width: 24 }} />
              </tr>
            </thead>
            <tbody>
              {result.opportunities.map(opp => (
                <ArbRow key={opp.eventSlug} opp={opp} />
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
