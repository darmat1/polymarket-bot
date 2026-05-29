// frontend/src/screens/split/SplitScreen.tsx
import { useState } from "react";
import { analyzeEvent, executeSplit, type SplitAnalysis } from "../../shared/api/split";

export function SplitScreen() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [analysis, setAnalysis] = useState<SplitAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState("1");
  const [splitting, setSplitting] = useState(false);
  const [splitResult, setSplitResult] = useState<string | null>(null);

  async function handleAnalyze() {
    setLoading(true);
    setError(null);
    setAnalysis(null);
    setSplitResult(null);
    try {
      const result = await analyzeEvent(url.trim());
      setAnalysis(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleSplit() {
    if (!analysis?.negRiskConditionId) return;
    setSplitting(true);
    setSplitResult(null);
    try {
      const amountNum = parseFloat(amount);
      if (isNaN(amountNum) || amountNum <= 0) throw new Error("Invalid amount");
      const result = await executeSplit(
        analysis.negRiskConditionId,
        amountNum,
        analysis.bins.length,
      );
      setSplitResult(
        `✓ Split executed! Tx: ${result.splitTxHash.slice(0, 10)}...` +
        (result.approveTxHash ? ` (approve: ${result.approveTxHash.slice(0, 10)}...)` : ""),
      );
    } catch (e) {
      setSplitResult(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSplitting(false);
    }
  }

  const arbColor =
    analysis?.arbOpportunity === "split" ? "#6bcb77" :
    analysis?.arbOpportunity === "merge" ? "#ffd93d" : "#888";

  const arbLabel =
    analysis?.arbOpportunity === "split"
      ? `⬆ Sum ${(analysis.sumYesMid * 100).toFixed(1)}¢ > $1 — Split opportunity`
      : analysis?.arbOpportunity === "merge"
      ? `⬇ Sum ${(analysis!.sumYesMid * 100).toFixed(1)}¢ < $1 — Merge opportunity`
      : analysis
      ? `Sum ${(analysis.sumYesMid * 100).toFixed(1)}¢ ≈ $1 — No arb`
      : null;

  return (
    <div style={{ padding: "24px", maxWidth: 900, margin: "0 auto", fontFamily: "monospace" }}>
      {/* URL input */}
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ color: "#ffd93d", marginBottom: 12, fontSize: 16 }}>NEG RISK SPLIT ANALYZER</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleAnalyze()}
            placeholder="https://polymarket.com/event/..."
            style={{
              flex: 1, padding: "8px 12px", background: "#1a1a2e", border: "1px solid #333",
              borderRadius: 6, color: "#fff", fontSize: 13,
            }}
          />
          <button
            onClick={handleAnalyze}
            disabled={loading || !url.trim()}
            style={{
              padding: "8px 20px", background: "#6bcb77", border: "none", borderRadius: 6,
              color: "#000", fontWeight: 700, cursor: "pointer", fontSize: 13,
            }}
          >
            {loading ? "…" : "Analyze"}
          </button>
        </div>
        {error && <div style={{ color: "#ff6b6b", marginTop: 8, fontSize: 12 }}>{error}</div>}
      </div>

      {analysis && (
        <>
          {/* Market info */}
          <div style={{ background: "#1a1a2e", borderRadius: 8, padding: 16, marginBottom: 16 }}>
            <div style={{ color: "#6bcb77", fontWeight: 700, marginBottom: 4 }}>
              {analysis.eventTitle}
            </div>
            <div style={{ color: "#888", fontSize: 12, marginBottom: 8 }}>
              Resolves: {analysis.resolutionDate}
            </div>
            {analysis.isNegRisk ? (
              <span style={{ background: "#6bcb7722", color: "#6bcb77", padding: "2px 8px", borderRadius: 4, fontSize: 12 }}>
                ✓ Neg Risk — {analysis.bins.length} bins
              </span>
            ) : (
              <span style={{ background: "#ff6b6b22", color: "#ff6b6b", padding: "2px 8px", borderRadius: 4, fontSize: 12 }}>
                ✗ Not a neg risk market — Split not available
              </span>
            )}
            {arbLabel && (
              <div style={{ color: arbColor, marginTop: 8, fontSize: 13 }}>{arbLabel}</div>
            )}
          </div>

          {/* Bins table */}
          {analysis.isNegRisk && (
            <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 16, fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #333" }}>
                  <th style={{ textAlign: "left",  padding: "6px 12px", color: "#888" }}>Bin</th>
                  <th style={{ textAlign: "right", padding: "6px 12px", color: "#888" }}>Bid</th>
                  <th style={{ textAlign: "right", padding: "6px 12px", color: "#888" }}>Ask</th>
                  <th style={{ textAlign: "right", padding: "6px 12px", color: "#888" }}>Mid</th>
                  <th style={{ textAlign: "right", padding: "6px 12px", color: "#888" }}>
                    Effective cost (split ${parseFloat(amount) || 1})
                  </th>
                </tr>
              </thead>
              <tbody>
                {analysis.bins.map((bin, i) => {
                  const amtNum = parseFloat(amount) || 1;
                  const othersSum = analysis.bins
                    .filter((_, j) => j !== i)
                    .reduce((s, b) => s + (b.midPrice ?? 0), 0);
                  const effectiveCost = amtNum - othersSum * amtNum;
                  const mid = bin.midPrice;
                  return (
                    <tr key={i} style={{ borderBottom: "1px solid #1a1a2e" }}>
                      <td style={{ padding: "5px 12px", color: "#ccc" }}>{bin.label}</td>
                      <td style={{ padding: "5px 12px", textAlign: "right", color: "#aaa" }}>
                        {bin.bestBid !== null ? `${(bin.bestBid * 100).toFixed(1)}¢` : "—"}
                      </td>
                      <td style={{ padding: "5px 12px", textAlign: "right", color: "#aaa" }}>
                        {bin.bestAsk !== null ? `${(bin.bestAsk * 100).toFixed(1)}¢` : "—"}
                      </td>
                      <td style={{ padding: "5px 12px", textAlign: "right", color: mid !== null ? "#fff" : "#555" }}>
                        {mid !== null ? `${(mid * 100).toFixed(1)}¢` : "—"}
                      </td>
                      <td style={{ padding: "5px 12px", textAlign: "right", color: "#6bcb77" }}>
                        {mid !== null ? `$${effectiveCost.toFixed(3)}` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {/* Split action */}
          {analysis.isNegRisk && analysis.negRiskConditionId && (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ color: "#888", fontSize: 13 }}>Amount USDC:</span>
              <input
                type="number"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                min="0.01"
                step="1"
                style={{
                  width: 80, padding: "6px 10px", background: "#1a1a2e",
                  border: "1px solid #333", borderRadius: 6, color: "#fff", fontSize: 13,
                }}
              />
              <button
                onClick={handleSplit}
                disabled={splitting || !amount || analysis?.arbOpportunity === "merge"}
                style={{
                  padding: "8px 20px", background: "#ffd93d", border: "none", borderRadius: 6,
                  color: "#000", fontWeight: 700, cursor: "pointer", fontSize: 13,
                }}
              >
                {splitting ? "Splitting…" : `Split $${amount}`}
              </button>
              {analysis?.arbOpportunity === "merge" && !splitResult && (
                <span style={{ fontSize: 12, color: "#ffd93d" }}>
                  ⚠ Merge opportunity — buy all bins on CLOB then Merge for profit
                </span>
              )}
              {splitResult && (
                <span style={{
                  fontSize: 12,
                  color: splitResult.startsWith("✓") ? "#6bcb77" : "#ff6b6b",
                }}>
                  {splitResult}
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
