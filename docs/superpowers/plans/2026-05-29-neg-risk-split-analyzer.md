# Neg Risk Split Analyzer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Split" tab where the user pastes a Polymarket event URL, sees a per-bin analysis of a neg risk split (prices, effective cost, weather forecast overlay), and can execute the split on-chain.

**Architecture:** New `neg-risk-split.ts` on the backend handles Gamma API fetching + CLOB price lookups + viem on-chain execution. Two new REST endpoints expose this to the frontend. A new `SplitScreen.tsx` renders the analysis table and split button.

**Tech Stack:** TypeScript, viem (already installed), existing GammaClient + ClobPublicClient, React frontend following existing screen patterns.

---

## Contract addresses (Polygon mainnet)

```
CTF:              0x4D97DCd97eC945f40cF65F87097ACe5EA0476045
NegRiskAdapter:   0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296
NegRiskExchange:  0xC5d563A36AE78145C45a50134d48A1215220f80a
USDC:             0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
```

---

## File map

| File | Action | Responsibility |
|------|--------|----------------|
| `backend/src/neg-risk-split.ts` | Create | Analysis + on-chain split execution |
| `backend/src/server.ts` | Modify | Add 2 new endpoints |
| `frontend/src/screens/split/SplitScreen.tsx` | Create | Full split analyzer UI |
| `frontend/src/shared/api/split.ts` | Create | API calls to backend |
| `frontend/src/shared/types/app.ts` | Modify | Add "split" to AppTab |
| `frontend/src/app/AppShell.tsx` | Modify | Add Split tab to nav |
| `frontend/src/App.tsx` | Modify | Add split route |

---

## Task 1: Backend — analysis function

**Files:**
- Create: `backend/src/neg-risk-split.ts`

### What it does

1. Parse slug from event URL (e.g. `https://polymarket.com/event/highest-temperature-in-london-on-may-29-2026` → `highest-temperature-in-london-on-may-29-2026`)
2. Fetch all markets in the event from Gamma API via `GET /events?slug=<eventSlug>`
3. For each market (bin): get YES token ID + fetch best bid from CLOB `/book`
4. Detect if neg risk by checking `negRiskId` field on the event
5. Compute effective cost per bin and sum of all YES prices

- [ ] **Step 1: Create the file with types and slug parser**

```typescript
// backend/src/neg-risk-split.ts
import { loadSettings } from "./config.js";
import { GammaClient } from "./gamma.js";
import { ClobPublicClient } from "./clob.js";

export interface SplitBin {
  label: string;          // e.g. "26°C"
  yesTokenId: string;
  bestBid: number | null; // cents, e.g. 0.39 = 39¢
  bestAsk: number | null;
  midPrice: number | null;
}

export interface SplitAnalysis {
  eventSlug: string;
  eventTitle: string;
  resolutionDate: string;
  isNegRisk: boolean;
  negRiskConditionId: string | null;
  bins: SplitBin[];
  sumYesMid: number;       // sum of all YES midprices — compare to 1.0
  arbOpportunity: "split" | "merge" | "none"; // >1 = split, <1 = merge, ≈1 = none
  isWeatherMarket: boolean;
}

export function parseEventSlug(url: string): string {
  // handles both /event/<slug> and /event/<slug>/<outcome>
  const match = url.match(/polymarket\.com\/event\/([^/?#]+)/);
  if (!match) throw new Error("Could not parse Polymarket event URL");
  return match[1];
}
```

- [ ] **Step 2: Add analyzeNegRiskEvent function**

```typescript
// append to backend/src/neg-risk-split.ts

export async function analyzeNegRiskEvent(eventUrl: string): Promise<SplitAnalysis> {
  const settings = loadSettings();
  const eventSlug = parseEventSlug(eventUrl);

  // Fetch event from Gamma API
  const gammaHost = settings.gammaHost; // "https://gamma-api.polymarket.com"
  const gamma = new GammaClient(gammaHost);

  const url = new URL("/events", gammaHost);
  url.searchParams.set("slug", eventSlug);
  url.searchParams.set("limit", "1");
  const eventsRes = await fetch(url.toString());
  if (!eventsRes.ok) throw new Error(`Gamma API error: ${eventsRes.status}`);
  const events = await eventsRes.json() as any[];
  if (!events || events.length === 0) throw new Error(`Event not found: ${eventSlug}`);

  const event = events[0];
  const markets: any[] = event.markets ?? [];
  const negRiskConditionId: string | null = event.negRiskId ?? null;
  const isNegRisk = !!negRiskConditionId && markets.length > 2;

  // For each market, get YES token ID and CLOB price
  const clobHost = settings.polymarketHost; // "https://clob.polymarket.com"
  const clob = new ClobPublicClient(clobHost);

  const bins: SplitBin[] = await Promise.all(
    markets.map(async (m: any) => {
      // Each market has clobTokenIds: [yesTokenId, noTokenId]
      const tokenIds: string[] = m.clobTokenIds ?? [];
      const yesTokenId = tokenIds[0] ?? "";

      let bestBid: number | null = null;
      let bestAsk: number | null = null;
      if (yesTokenId) {
        try {
          const top = await clob.getTopOfBook(yesTokenId);
          bestBid = top.bid;
          bestAsk = top.ask;
        } catch { /* no liquidity */ }
      }

      const midPrice = bestBid !== null && bestAsk !== null
        ? (bestBid + bestAsk) / 2
        : (bestBid ?? bestAsk);

      return {
        label: m.groupItemTitle ?? m.outcomes?.[0] ?? m.question ?? "?",
        yesTokenId,
        bestBid,
        bestAsk,
        midPrice,
      };
    })
  );

  const sumYesMid = bins.reduce((s, b) => s + (b.midPrice ?? 0), 0);
  const ARB_THRESHOLD = 0.02; // 2¢ buffer for gas + slippage
  const arbOpportunity =
    sumYesMid < 1.0 - ARB_THRESHOLD ? "merge" :
    sumYesMid > 1.0 + ARB_THRESHOLD ? "split" : "none";

  const titleLower = (event.title ?? eventSlug).toLowerCase();
  const isWeatherMarket = titleLower.includes("temperature") || titleLower.includes("temp");

  return {
    eventSlug,
    eventTitle: event.title ?? eventSlug,
    resolutionDate: event.endDate ?? "",
    isNegRisk,
    negRiskConditionId,
    bins,
    sumYesMid,
    arbOpportunity,
    isWeatherMarket,
  };
}
```

- [ ] **Step 3: Compile check**

```bash
cd /Users/andrew/Projects/PM/backend && pnpm run build 2>&1
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/neg-risk-split.ts
git commit -m "feat: add neg-risk split analysis function"
```

---

## Task 2: Backend — split execution function

**Files:**
- Modify: `backend/src/neg-risk-split.ts`

### What it does

1. Check current pUSD allowance for NegRiskAdapter
2. If insufficient: send `approve` transaction
3. Send `splitPosition` on NegRiskAdapter
4. Return tx hash

The NegRiskAdapter `splitPosition` ABI (from Gnosis CTF standard, adapted for neg risk):
```
function splitPosition(
  address collateralToken,
  bytes32 parentCollectionId,
  bytes32 conditionId,
  uint256[] partition,
  uint256 amount
) external
```

For a neg risk event with N bins, partition = `[1, 2, 4, 8, ...]` (power-of-2 bitmask per bin).

- [ ] **Step 1: Add viem imports and contract constants**

```typescript
// Add at top of backend/src/neg-risk-split.ts
import { createWalletClient, createPublicClient, http, parseUnits, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { ethers } from "ethers";

const NEG_RISK_ADAPTER  = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296" as const;
const USDC_ADDRESS      = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as const;

const ERC20_ABI = [
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner",   type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount",  type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const NEG_RISK_ADAPTER_ABI = [
  {
    name: "splitPosition",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "collateralToken",      type: "address" },
      { name: "parentCollectionId",   type: "bytes32" },
      { name: "conditionId",          type: "bytes32" },
      { name: "partition",            type: "uint256[]" },
      { name: "amount",               type: "uint256" },
    ],
    outputs: [],
  },
] as const;
```

- [ ] **Step 2: Add executeNegRiskSplit function**

```typescript
// Append to backend/src/neg-risk-split.ts

export interface SplitResult {
  approveTxHash: string | null; // null if approve not needed
  splitTxHash: string;
  amountUsdc: number;
  binCount: number;
}

export async function executeNegRiskSplit(
  negRiskConditionId: string,
  amountUsdc: number,
  binCount: number,
): Promise<SplitResult> {
  const settings = loadSettings();
  if (!settings.privateKey) throw new Error("No private key configured");

  const rpcUrl = process.env.POLYGON_RPC_URL ?? "https://polygon.llamarpc.com";
  const normalized = settings.privateKey.startsWith("0x")
    ? settings.privateKey as `0x${string}`
    : `0x${settings.privateKey}` as `0x${string}`;

  const account = privateKeyToAccount(normalized);
  const publicClient = createPublicClient({ chain: polygon, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: polygon, transport: http(rpcUrl) });

  // USDC has 6 decimals
  const amountRaw = parseUnits(amountUsdc.toFixed(6), 6);

  // 1. Check allowance
  const allowance = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account.address, NEG_RISK_ADAPTER],
  }) as bigint;

  let approveTxHash: string | null = null;
  if (allowance < amountRaw) {
    // Approve max uint256 so we don't need to approve again
    const MAX = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
    approveTxHash = await walletClient.writeContract({
      address: USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [NEG_RISK_ADAPTER, MAX],
    });
    // Wait for approval to be mined
    await publicClient.waitForTransactionReceipt({ hash: approveTxHash as `0x${string}` });
  }

  // 2. Build partition: [1, 2, 4, 8, ...] for N bins
  const partition = Array.from({ length: binCount }, (_, i) => BigInt(1 << i));

  // 3. Execute splitPosition
  const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
  const splitTxHash = await walletClient.writeContract({
    address: NEG_RISK_ADAPTER,
    abi: NEG_RISK_ADAPTER_ABI,
    functionName: "splitPosition",
    args: [
      USDC_ADDRESS,
      ZERO_BYTES32,
      negRiskConditionId as `0x${string}`,
      partition,
      amountRaw,
    ],
  });

  return {
    approveTxHash,
    splitTxHash,
    amountUsdc,
    binCount,
  };
}
```

- [ ] **Step 3: Compile check**

```bash
cd /Users/andrew/Projects/PM/backend && pnpm run build 2>&1
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/neg-risk-split.ts
git commit -m "feat: add neg-risk split execution via viem"
```

---

## Task 3: Backend — new endpoints

**Files:**
- Modify: `backend/src/server.ts`

- [ ] **Step 1: Add import at top of server.ts**

Find the existing imports block and add:
```typescript
import { analyzeNegRiskEvent, executeNegRiskSplit } from "./neg-risk-split.js";
```

- [ ] **Step 2: Add endpoints before the final `export { app }`**

Find the last route in server.ts and add after it:

```typescript
// POST /api/split/analyze
app.post("/api/split/analyze", async (req, res) => {
  const { eventUrl } = req.body as { eventUrl?: string };
  if (!eventUrl?.trim()) {
    res.status(400).json({ error: "eventUrl is required" });
    return;
  }
  try {
    const analysis = await analyzeNegRiskEvent(eventUrl.trim());
    res.json(analysis);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
  }
});

// POST /api/split/execute
app.post("/api/split/execute", async (req, res) => {
  const { conditionId, amountUsdc, binCount } = req.body as {
    conditionId?: string;
    amountUsdc?: number;
    binCount?: number;
  };
  if (!conditionId || !amountUsdc || !binCount) {
    res.status(400).json({ error: "conditionId, amountUsdc, binCount are required" });
    return;
  }
  try {
    const result = await executeNegRiskSplit(conditionId, amountUsdc, binCount);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});
```

- [ ] **Step 3: Compile and deploy**

```bash
cd /Users/andrew/Projects/PM/backend && pnpm run build 2>&1
docker-compose up --build -d 2>&1 | tail -10
```
Expected: clean build, container started.

- [ ] **Step 4: Smoke test analyze endpoint**

```bash
curl -s -X POST http://localhost:3001/api/split/analyze \
  -H "Content-Type: application/json" \
  -d '{"eventUrl":"https://polymarket.com/event/highest-temperature-in-london-on-may-29-2026"}' \
  | jq '{isNegRisk, binCount: (.bins | length), sumYesMid, arbOpportunity}'
```
Expected: `{ isNegRisk: true, binCount: 10, sumYesMid: ~1.0, arbOpportunity: "none" }`

- [ ] **Step 5: Commit**

```bash
git add backend/src/server.ts
git commit -m "feat: add /api/split/analyze and /api/split/execute endpoints"
```

---

## Task 4: Frontend API client

**Files:**
- Create: `frontend/src/shared/api/split.ts`

- [ ] **Step 1: Create the file**

```typescript
// frontend/src/shared/api/split.ts
import { postJson } from "./http";

export interface SplitBin {
  label: string;
  yesTokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
}

export interface SplitAnalysis {
  eventSlug: string;
  eventTitle: string;
  resolutionDate: string;
  isNegRisk: boolean;
  negRiskConditionId: string | null;
  bins: SplitBin[];
  sumYesMid: number;
  arbOpportunity: "split" | "merge" | "none";
  isWeatherMarket: boolean;
}

export interface SplitResult {
  approveTxHash: string | null;
  splitTxHash: string;
  amountUsdc: number;
  binCount: number;
}

export function analyzeEvent(eventUrl: string) {
  return postJson<SplitAnalysis>("/api/split/analyze", { eventUrl });
}

export function executeSplit(conditionId: string, amountUsdc: number, binCount: number) {
  return postJson<SplitResult>("/api/split/execute", { conditionId, amountUsdc, binCount });
}
```

- [ ] **Step 2: Compile check (frontend)**

```bash
cd /Users/andrew/Projects/PM/frontend && pnpm run build 2>&1 | head -20
```
Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/shared/api/split.ts
git commit -m "feat: add split API client"
```

---

## Task 5: Frontend — SplitScreen

**Files:**
- Create: `frontend/src/screens/split/SplitScreen.tsx`

- [ ] **Step 1: Create the screen**

```tsx
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
    analysis?.arbOpportunity === "merge" ? "#6bcb77" : "#888";

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
                disabled={splitting || !amount}
                style={{
                  padding: "8px 20px", background: "#ffd93d", border: "none", borderRadius: 6,
                  color: "#000", fontWeight: 700, cursor: "pointer", fontSize: 13,
                }}
              >
                {splitting ? "Splitting…" : `Split $${amount}`}
              </button>
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
```

- [ ] **Step 2: Compile check**

```bash
cd /Users/andrew/Projects/PM/frontend && pnpm run build 2>&1 | head -20
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/screens/split/SplitScreen.tsx
git commit -m "feat: add SplitScreen component"
```

---

## Task 6: Wire up the tab

**Files:**
- Modify: `frontend/src/shared/types/app.ts`
- Modify: `frontend/src/app/AppShell.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Add "split" to AppTab type**

In `frontend/src/shared/types/app.ts`, add `"split"`:
```typescript
export type AppTab =
  | "positions"
  | "weather"
  | "split"
  | "btc5m"
  | "btc15m"
  | "btc15mAuto"
  | "btc15mHedge";
```

- [ ] **Step 2: Add tab button in AppShell.tsx**

Find the nav tab buttons in `AppShell.tsx` and add after "weather":
```tsx
<button
  onClick={() => setActiveTab("split")}
  style={{ /* copy style from adjacent tab button */ fontWeight: activeTab === "split" ? 700 : 400 }}
>
  Split
</button>
```

- [ ] **Step 3: Add route in App.tsx**

Find the existing tab conditions and add:
```tsx
) : activeTab === "split" ? (
  <SplitScreen />
```

Also add import at top:
```tsx
import { SplitScreen } from "./screens/split/SplitScreen";
```

- [ ] **Step 4: Build and deploy**

```bash
cd /Users/andrew/Projects/PM && docker-compose up --build -d 2>&1 | tail -10
```
Expected: clean build, container started.

- [ ] **Step 5: Manual test**
  - Open http://localhost:3001
  - Click "Split" tab
  - Paste `https://polymarket.com/event/highest-temperature-in-london-on-may-29-2026`
  - Click "Analyze"
  - Expected: table with ~10 bins, prices, effective costs, arbitrage indicator

- [ ] **Step 6: Commit**

```bash
git add frontend/src/shared/types/app.ts frontend/src/app/AppShell.tsx frontend/src/App.tsx
git commit -m "feat: wire up Split tab in navigation"
```
