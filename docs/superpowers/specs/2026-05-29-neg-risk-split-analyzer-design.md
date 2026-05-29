# Neg Risk Split Analyzer — Design Spec
**Date:** 2026-05-29  
**Status:** Approved

---

## Overview

A new "Split" tab in the existing app that lets the user paste any Polymarket event URL, analyzes the neg risk split opportunity, shows expected positions/costs/profits per bin, overlays weather forecast for weather markets, and executes the CTF neg risk split with a manual button.

---

## User Flow

```
1. Paste Polymarket event URL
2. Click "Analyze"
3. Bot fetches market data (Gamma API) + CLOB prices
4. If weather market: fetch current temp + forecast (METAR)
5. Display analysis table
6. User enters split amount ($)
7. Click "Split $X" → execute on-chain
8. Tokens appear in wallet / Positions tab
```

---

## Frontend

### New tab: `"split"` in `AppTab` type

New screen: `frontend/src/screens/split/SplitScreen.tsx`

### Layout

**URL input section**
- Text field: "Paste Polymarket event URL"
- "Analyze" button
- Error state: "Not a neg risk market — Split not available"

**Market info card**
- Event name, resolution date, total volume
- Badge: `✓ Neg Risk (N bins)` in green
- Arbitrage indicator:
  - Sum of all YES prices shown
  - Green if sum < $1.00 (Merge opportunity)
  - Red if sum > $1.00 (Split opportunity)
  - Grey if ≈ $1.00 (no arb)

**Analysis table** (one row per bin)

| Bin | YES price | Effective cost via Split | vs direct CLOB | Weather |
|-----|-----------|--------------------------|----------------|---------|
| 25°C | 17¢ | 17¢ | = same | — |
| 26°C | 39¢ | 39¢ | = same | 🌡️ now: 26.8° |
| 27°C | 37¢ | 37¢ | cheaper* | 🟢 forecast |

*Split is cheaper than CLOB when the bin has low liquidity / wide spread on the orderbook.

**Effective cost formula:**
```
effective_cost(bin_i) = amount - (sum of other N-1 YES prices × amount / $1)
```

Weather overlay (only for weather markets):
- 🟢 Green highlight = forecast bin (from Groq extraction)
- 🌡️ = current temperature observation (from METAR)
- Uses existing weather infrastructure (station code, timezone from Groq)

**Split action block**
- Input: "Amount in USDC" (user-defined)
- Button: "Split $X" (disabled until amount > 0 and market analyzed)
- Post-split: success message with token amounts received

---

## Backend

### New file: `backend/src/neg-risk-split.ts`

**Functions:**

`analyzeNegRiskEvent(eventUrl: string)` 
- Extract slug from URL
- Fetch event from Gamma API (get all markets/bins + conditionId per bin)
- Call CLOB for best bid/ask on each token
- Detect if neg risk (via existing `getNegRisk()`)
- Return: bins[], prices[], conditionIds[], negRiskConditionId, isWeatherMarket

`executeNegRiskSplit(negRiskConditionId: string, amountUsdc: number)`
- Check pUSD allowance for NegRiskAdapter
- If insufficient: send `approve(NegRiskAdapter, amount)` tx
- Send `splitPosition(collateral, parentCollectionId, conditionId, partition, amount)` tx
- Return: txHash, tokensReceived[]

### New endpoints in `server.ts`

`POST /api/split/analyze`
- Body: `{ eventUrl: string }`
- Returns: market analysis object

`POST /api/split/execute`  
- Body: `{ conditionId: string, amount: number }`
- Returns: `{ txHash, tokens }`

---

## Contract addresses (Polygon mainnet)

| Contract | Address |
|----------|---------|
| CTF (ConditionalTokens) | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` |
| NegRiskAdapter | `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` |
| NegRiskExchange | `0xC5d563A36AE78145C45a50134d48A1215220f80a` |
| USDC (collateral) | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |

---

## Split execution — on-chain sequence

```
1. approve(NegRiskAdapter, amount)          ← pUSD ERC20
2. splitPosition(                            ← NegRiskAdapter
     collateralToken: USDC,
     parentCollectionId: bytes32(0),
     conditionId: <neg risk condition id>,
     partition: [1, 2, 4, 8, ...],          ← bitmask per bin
     amount: amountUsdc * 1e6               ← USDC has 6 decimals
   )
```

Result: user receives N YES tokens (one per bin), each with face value = amountUsdc.

---

## Weather overlay detection

If event URL matches weather pattern (e.g. contains "temperature", "highest-temp"):
- Run Groq extraction (reuse existing logic)
- Fetch METAR for station code
- Map current temp and forecast to bin index
- Highlight in table

Non-weather markets: show table without temperature column.

---

## Out of scope (tracked separately)

**Arbitrage Bot (Plan A)** — fully automated arb on neg risk markets:
- Monitor all active neg risk markets continuously
- When `sum(all YES bids) < $1`: buy all via CLOB + Merge → guaranteed profit
- When `sum(all YES asks) > $1`: Split + sell all via CLOB → guaranteed profit
- Profit condition: deviation > gas cost (~$0.01 on Polygon) + slippage
- Requires: price monitoring loop, atomic execution, slippage estimation
- Risk: front-running by faster bots, liquidity gaps mid-execution

---

## Files to create/modify

**New:**
- `frontend/src/screens/split/SplitScreen.tsx`
- `backend/src/neg-risk-split.ts`

**Modify:**
- `frontend/src/shared/types/app.ts` — add `"split"` to AppTab
- `frontend/src/app/AppShell.tsx` — add Split tab to nav
- `frontend/src/App.tsx` — add split route
- `backend/src/server.ts` — add 2 new endpoints
