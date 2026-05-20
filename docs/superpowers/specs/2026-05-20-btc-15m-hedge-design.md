# BTC 15m Hedge — Design

Status: approved for planning
Date: 2026-05-20

## Goal

Add a new automated Polymarket module in a separate UI tab named `BTC 15m Hedge`.
This bot is distinct from the existing `BTC 15m` contrarian strategy. It trades
one 15-minute BTC up/down market by building a hedged pair of `UP` and `DOWN`
shares using limit buy orders on both sides.

The objective is to accumulate a symmetric pair where:

- `pairedShares = min(upFilledShares, downFilledShares)`
- `combinedAverage = avgUp + avgDown`
- the pair is considered valid when `combinedAverage <= targetCombinedPrice`

Once a valid pair is assembled, the bot holds it until market expiration. It
does not attempt to sell early for profit. Only one hedge pair is allowed per
15-minute market.

## Strategy Summary

For each live `btc-updown-15m-*` market:

1. Place limit buy orders on both `UP` and `DOWN`.
2. Track fills independently for each side.
3. Continuously compute the paired portion:
   - `pairedShares = min(upShares, downShares)`
   - `pairedCost = pairedUpCost + pairedDownCost`
   - `combinedAverage = pairedCost / pairedShares`
4. If `pairedShares > 0` and `combinedAverage <= targetCombinedPrice`, the
   hedge pair is considered assembled.
5. After assembly:
   - cancel any remaining excess buy orders if they would grow one side beyond
     the target pair;
   - keep the symmetric pair open until settlement.
6. If the pair is still incomplete and time remaining is below the unwind
   threshold (`2 min` by requirement):
   - cancel remaining buy orders;
   - sell any unpaired inventory at the best available bid.

The bot must not open a second hedge cycle in the same market even if there is
time left after the pair is resolved or unwound.

## Scope and Boundaries

This is a new strategy module with separate state and separate API routes.
It should reuse shared Polymarket infrastructure but must not share runtime
state, trade history, or settings with the existing `BTC 15m` bot.

Out of scope for v1:

- multiple hedge pairs in the same 15-minute market;
- early profit-taking after the pair is assembled;
- dynamic machine-learned thresholds;
- mixing this strategy into the current contrarian `BTC 15m` tab;
- automatic re-entry after an unwind in the same market.

## Recommended Approach

Three approaches were considered:

1. Symmetric dual-order hedge bot
2. Sequential first-leg then second-leg hedge bot
3. Aggressive order-repricing hedge bot

Recommended: **Approach 1, symmetric dual-order hedge bot**.

Reason:

- closest to the stated strategy;
- easier to reason about than sequential leg logic;
- lower implementation risk than continuous aggressive repricing;
- clearer UI and simpler failure handling.

## Architecture

Backend strategy engine plus a dedicated frontend tab. Follow the same pattern
used by the current `btc15m/` module, but keep hedge strategy state isolated.

Proposed file layout:

| Path | Role |
|---|---|
| `backend/src/btc15m-hedge/index.ts` | Module entry, factory helpers, status/start/stop API integration |
| `backend/src/btc15m-hedge/strategy.ts` | Hedge state machine and execution loop |
| `backend/src/btc15m-hedge/state-store.ts` | Atomic JSON persistence for hedge strategy |
| `backend/src/btc15m-hedge/types.ts` | Strategy types, tracked legs, completed cycles |
| `frontend/src/App.tsx` | New `BTC 15m Hedge` tab |
| `frontend/src/styles.css` | New tab styling matching current BTC bot panels |
| `backend/src/server.ts` | New `/api/btc15m-hedge/*` routes |

Shared infrastructure to reuse:

- `PolymarketService`
- `ClobPublicClient`
- `ScalperUserWs`
- `BudgetManager`
- current market resolution helpers
- current Polymarket start-price / live-price sources

## Core State Model

The hedge bot needs explicit two-leg state rather than a single-side position.

### Engine phase

- `stopped`
- `running`
- `auto_stopped`

### Cycle phase

- `waiting_market`
- `building_pair`
- `paired_holding`
- `unwinding`
- `cycle_done`
- `market_idle`

### Leg state

Each side (`up`, `down`) keeps:

- token id
- active buy order id, price, remaining size, status
- filled shares
- cumulative filled cost
- average fill price

### Derived pair state

- `pairedShares = min(upFilledShares, downFilledShares)`
- `unpairedUpShares = max(0, upFilledShares - pairedShares)`
- `unpairedDownShares = max(0, downFilledShares - pairedShares)`
- `pairedAvgUp`
- `pairedAvgDown`
- `combinedAverage`
- `pairAssembledAt`

### Completed cycle record

One cycle row per market, containing:

- market slug
- target combined price
- max shares per side
- final paired shares
- average `UP` price
- average `DOWN` price
- combined average
- realized unpaired unwind PnL, if any
- final result:
  - `paired_hold`
  - `partial_unwind`
  - `failed_to_pair`
- timestamps

## Execution Rules

### 1. Market selection

Track only the current live Polymarket 15-minute BTC up/down market. On market
switch:

- cancel leftover open orders from the previous hedge cycle;
- persist final state;
- reset cycle to the new market;
- allow exactly one hedge attempt in the new market.

### 2. Configuration

Fields required in the new tab before bot start:

| Field | Purpose |
|---|---|
| `Working budget ($)` | Budget cap for this strategy |
| `Shares per side` | Max inventory per side |
| `Target combined price` | Pair is valid when `avgUp + avgDown <= this value` |
| `Entry cutoff (min)` | Stop trying to build new inventory when too near expiry |
| `Force unwind threshold (min)` | At this point cancel outstanding buys and dump unpaired inventory |

Defaults for v1:

- `Working budget`: 3
- `Shares per side`: 5
- `Target combined price`: user-defined, no hidden fixed value
- `Force unwind threshold`: 2

`Entry cutoff (min)` should default to something conservative such as `6`,
mirroring the existing bot unless user overrides it.

### 3. Building the pair

The bot starts in `building_pair`.

Rules:

- place limit buy orders on both sides;
- do not exceed `sharesPerSide` on either side;
- if one side fills faster, continue trying to fill the missing side;
- maintain exact accounting of partial fills and remaining open quantity;
- once a side has reached `sharesPerSide`, stop growing it further.

The bot must prevent runaway overfill:

- if live conditional balance exceeds local expectation, reconcile against
  actual Polymarket holdings;
- if an order is partially matched, do not treat `matched` as fully done;
- cancel leftover quantity when appropriate rather than leaving stale buy
  fragments live.

### 4. Declaring the pair assembled

The pair is assembled when:

- `pairedShares > 0`
- `combinedAverage <= targetCombinedPrice`

At that moment:

- transition to `paired_holding`;
- cancel any still-open buy orders that would only add unpaired exposure;
- freeze the paired metrics for reporting;
- do not open new buys in this market.

### 5. Handling imbalance before deadline

If one side is ahead of the other:

- keep attempting to buy the lagging side;
- maintain open buy only if still before `forceUnwindThreshold`;
- if there is no longer enough time, abort pair building.

### 6. Force unwind at 2 minutes

If time remaining is below `forceUnwindThreshold` and the pair is not fully
assembled:

- cancel all remaining buy orders;
- determine unpaired inventory per side;
- place best-bid sell for each unpaired remainder;
- record realized PnL from that unwind.

If there is already a valid paired portion, keep the paired portion held to
expiry and unwind only the excess unpaired remainder.

### 7. Settlement

In `paired_holding`, hold until market expiration.

At settlement:

- one side resolves to `1.00`, the other to `0.00`;
- compute final hedge profit based on the paired portion only;
- add any earlier unpaired unwind PnL;
- persist a single completed cycle row for the market.

## Budget Logic

Budget accounting differs from the contrarian bot because two legs may be open
at once.

Rules:

- reserve budget for each side's outstanding buy order;
- consume budget on actual fills only;
- release reservation on cancelled remainder;
- after pair assembly, consumed capital remains tied up until settlement;
- settlement credits the resolved value back to available budget;
- unpaired forced unwind credits actual sell proceeds immediately.

The strategy must never place orders whose total reserved+consumed amount
exceeds `workingBudgetUsd`.

## Error Handling and Reconciliation

The implementation must handle:

- stale local buy order that no longer exists on Polymarket;
- partial fill without a final fill event;
- live position larger or smaller than local in-memory state;
- market expiry with partially built pair;
- restart while holding paired inventory;
- restart while open buy orders are still live.

Required reconciliation behavior:

- on each tick in live mode, compare local state with real open orders and real
  conditional balances;
- if local buy orders are stale, clear them;
- if live position exists but local state is incomplete, recover it;
- if market has already expired, resolve paired and unpaired portions into the
  final trade row.

## API Shape

New routes:

- `GET /api/btc15m-hedge/status`
- `POST /api/btc15m-hedge/start`
- `POST /api/btc15m-hedge/stop`

Status payload should include:

- engine phase
- config
- current market
- time remaining
- `UP` leg state
- `DOWN` leg state
- paired summary
- budget snapshot
- recent logs
- completed cycle history

## Frontend Tab

Add a new top-level tab label:

- `BTC 15m Hedge`

The tab should mirror the visual density and structure of the current BTC bot
tabs:

- top action row with `Refresh` and `Start/Stop Bot`
- summary cards:
  - engine
  - mode
  - target combined price
  - budget left
- settings form
- live market monitor
- leg monitor:
  - `UP` buy state
  - `DOWN` buy state
  - paired summary
- completed cycle table
- logs / event section if useful

Important UI behavior:

- settings are editable before start;
- locked while bot is running;
- bot is off by default;
- this tab must not reuse the state object from the current `BTC 15m` bot.

## Testing Strategy

### Backend isolated tests

Add focused tests for:

- pair becomes valid when `avgUp + avgDown <= targetCombinedPrice`
- partial pair accepted when symmetric filled portion is profitable
- one side overfills, second side lags, and bot keeps buying lagging side
- force unwind of unpaired remainder at `< 2 min`
- paired portion remains held while excess remainder is sold
- settlement computes correct result
- restart recovery for open buys
- restart recovery for paired held inventory
- no second hedge cycle in the same market

### Frontend checks

- tab renders independently
- correct payload mapping
- button states
- settings lock while running
- status text for:
  - building pair
  - paired holding
  - unwinding
  - cycle done

## Risks and Constraints

Main implementation risks:

- partial fills on both sides causing incorrect paired accounting;
- stale residual orders producing unexpected extra shares;
- incorrect allocation between paired and unpaired quantities;
- expiry behavior when one side is partially paired and partially unpaired.

To reduce risk, v1 should prefer:

- simple deterministic accounting;
- exact per-leg cumulative fill tracking;
- aggressive stale-order reconciliation;
- one completed cycle per market, no re-entry.

## Implementation Boundary for the Next Step

The next implementation plan should decompose the work into:

1. backend module skeleton and persistence
2. hedge strategy state machine
3. live reconciliation and settlement logic
4. API wiring
5. frontend tab and controls
6. isolated tests

That is the intended scope for the first implementation plan.
