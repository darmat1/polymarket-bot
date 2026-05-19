# BTC 15m Trading Module — Design

Status: approved for planning
Date: 2026-05-19 (revised 2026-05-20 to align with current `main`)

## Goal

Add an automated trading module for Polymarket 15-minute BTC up/down markets
(`btc-updown-15m-*`, e.g. `https://polymarket.com/uk/event/btc-updown-15m-1779220800`).
The module lives in a new `BTC 15m` tab. It runs a contrarian (mean-reversion)
strategy: when BTC moves away from the market start price, place a cheap limit
buy on the losing side, expecting reversion, and take profit on a bounce. It
coexists with the existing Scalper feature and `BTC 5M Bot`, leaving them
unchanged.

## Strategy

For each live 15m market:

1. The market has a fixed **start price** (BTC price at market open).
2. While no buy order is filled, watch BTC versus the start price:
   - BTC **above** start -> cheap side is **DOWN** -> place a limit buy of
     `shares` shares at `buyPrice` on DOWN.
   - BTC **below** start -> cheap side is **UP** -> place a limit buy of
     `shares` shares at `buyPrice` on UP.
3. When the buy order fills, immediately place a limit sell of all held shares
   at `sellPrice`.
4. Selling all held shares = a successful trade.
5. After a successful trade, if more than `repeatThresholdMin` minutes remain
   in the market, repeat the cycle on the same market.
6. If shares are held, less than `forceSellThresholdMin` minutes remain, and
   the price never reached `sellPrice`, sell at the current price (best bid).
7. Cancel an irrelevant pending buy order: if a buy order is still unfilled and
   BTC returns to the start point (back inside the neutral zone, or the side
   flips), cancel it and prepare to place a buy on the opposite side if BTC
   moves the other way. Cancellation applies only to the **buy** order, never
   to a held position.

## Architecture

Backend strategy engine plus a frontend monitoring tab. Pattern mirrors
`btc5m-bot.ts` and `scalper/` in current `main`. The engine owns all strategy
state and timers, runs independently of the browser, and broadcasts state over
the existing WebSocket server.

File layout (matches the `scalper/` and `btc5m/` subdirectory pattern):

| Path | Role |
|---|---|
| `backend/src/btc15m/index.ts` | Entry, factory helpers, re-exports |
| `backend/src/btc15m/strategy.ts` | State machine, clock loop, cycle logic |
| `backend/src/btc15m/state-store.ts` | Atomic JSON persistence (own file) |
| `backend/src/btc15m/types.ts` | Types: cycle state, tracked order, trade row |
| Wiring in `backend/src/server.ts` | New `/api/btc15m/*` routes |
| Wiring in `backend/src/app.ts` | Engine init, broadcast plumbing |
| Wiring in `frontend/src/App.tsx` | `BTC 15m` tab (settings, monitor, analytics) |

Reference templates: `btc5m-bot.ts` (closest real-bot analog) and
`scalper/scalper-strategy.ts` (engine + lifecycle).

## Reused infrastructure (do not reimplement)

- **`PolymarketService.getInstance(settings)`** (`backend/src/polymarket-service.ts`)
  — singleton. Provides `initialize`, `placeLimitOrder`, `cancelOrder`, and
  implements `BudgetBalanceProvider`. This is the single trading entry point
  the engine uses; `btc5m-bot.ts` is the canonical consumer pattern.
- **`TradingClient.cancelOrder(orderId)` and `cancelOrders(orderIds)`** in
  `backend/src/trading.ts` — already wired to the SDK
  (`client.cancelOrder({ orderID })`). Used indirectly via `PolymarketService`.
- **`ScalperUserWs`** (`backend/src/scalper-user-ws.ts`) — reusable user
  WebSocket client with auth, ping, reconnect, and a normalized
  `ScalperUserWsMessage` payload (`orderId`, `assetIds`, `status`, etc.). The
  engine instantiates it with its own callback for fill / cancel / fail
  events; in `dryRun = true` the messages are ignored (same convention as
  `btc5m-bot.ts`).
- **`BudgetManager`** from `backend/src/scalper/budget-manager.ts` —
  instantiated with its own `Btc15mStateStore` and own `maxBotBudget`. Provides
  `reserve` / `release` / `consume` / `addFunds` / `getSnapshot`, and the
  `BudgetBalanceProvider` (`PolymarketService`) for startup balance
  verification against the real account.
- **State store pattern** from `scalper/state-store.ts` — atomic temp-file
  rename, queued updates, normalization. `Btc15mStateStore` mirrors it but
  holds our own shape (cycle state, tracked orders, completed trades).
- **Settings loader** (`backend/src/config.ts`) — extend with a `btc15m`
  subtree alongside `scalper` and `btc5m`. Env vars follow the
  `BTC15M_<NAME>` convention, mirroring `BTC5M_<NAME>`. Add
  `validateBtc15mSettings` alongside the existing validators.

## Market resolver and time tracking

15m markets are aligned to 15-minute UTC boundaries. The slug is
`btc-updown-15m-<unixSec>`, where `unixSec` is divisible by 900
(verified: `1779220800 / 900` is an integer).

The engine runs a clock loop (tick ~1-2s):

- Compute the current window slug: `Math.floor(now / 900) * 900`.
- Resolve the market via Gamma (`getMarketBySlug`); read `startTime`,
  `endTime`, and the UP / DOWN tradeable token IDs.
- Freeze the **start BTC price** once, when the live market is first seen,
  using Polymarket `priceToBeat` / `crypto-price` `openPrice` for the market
  window. Use Polymarket RTDS `crypto_prices_chainlink` (`btc/usd`) only for
  current live BTC ticks.
- When `now >= endTime`: close the current market — cancel any resting orders;
  any still-held position is left to market resolution — then resolve the next
  window and switch to it, resetting the cycle. The engine always tracks the
  actual current live 15m market.

## State machine

Engine level: `STOPPED` (default) or `RUNNING`. Start/Stop is user controlled.

Per-market cycle states (only while `RUNNING`):

- `WAITING_DIRECTION` — market live, no buy order resting.
- `BUY_PENDING` — limit buy resting, waiting for a fill.
- `HOLDING` — buy filled, limit sell at `sellPrice` resting.
- `FORCE_SELLING` — late market, selling held shares into the best bid.
- `CYCLE_DONE` — all held shares sold; decide repeat or wait.
- `MARKET_IDLE` — cycle finished, not enough time to repeat; wait for market end.

Transitions:

- `WAITING_DIRECTION`: side = sign of (BTC - start). DOWN if BTC is above
  `start + neutralZone`, UP if below `start - neutralZone`. Within the neutral
  zone, place no order. Once BTC is outside the neutral zone, **check the
  budget guardrail** (see below), then place a limit buy of `shares` at
  `buyPrice` on the cheap side -> `BUY_PENDING`.
- `BUY_PENDING`:
  - Buy fills -> place a limit sell of all held shares at `sellPrice` ->
    `HOLDING`.
  - BTC returns inside the neutral zone or the side flips -> cancel the buy
    order (`TradingClient.cancelOrder`) -> `WAITING_DIRECTION`.
  - Time to end < `forceSellThresholdMin` and nothing held -> cancel the buy
    order -> `MARKET_IDLE`.
- `HOLDING`:
  - Sell at `sellPrice` fills -> `CYCLE_DONE` (successful trade).
  - Time to end < `forceSellThresholdMin` and the target sell is unfilled ->
    cancel the target sell, place a sell at the best bid -> `FORCE_SELLING`.
  - The irrelevant-order cancellation rule does NOT apply to a held position.
- `FORCE_SELLING`:
  - Best-bid sell fills -> `CYCLE_DONE`.
  - Not filled before market end -> the position resolves at settlement.
- `CYCLE_DONE`:
  - Time to end > `repeatThresholdMin` -> new cycle -> `WAITING_DIRECTION`.
  - Otherwise -> `MARKET_IDLE`.

Concurrency: one market at a time, one open cycle (one position) at a time.

Partial fills: while held shares > 0 and not force-selling, the engine
maintains an active sell order at `sellPrice` for the held quantity. A
partially filled buy that is then cancelled (BTC back to start, or late
market) leaves the held partial quantity, which is sold per the normal rules.

## Orders, cancellation, fill detection

- **Placement**: via `PolymarketService.placeLimitOrder`. Respects `dryRun`
  and the `maxOrderUsdc` cap. Default cycle notional is `5 x $0.25 = $1.25`,
  well under the cap. Order ID extracted from response with the same helper
  pattern used in `btc5m-bot.ts` (`orderID` / `orderId` / `id`).
- **Cancellation**: `PolymarketService.cancelOrder(orderId)`.
- **Fill detection**:
  - `dryRun = true` (SIM): book-aware simulation. The engine subscribes to
    the target token's live order book via the existing Polymarket market
    WebSocket. A buy at `buyPrice` fills when `bestAsk <= buyPrice`; a sell
    at `sellPrice` fills when `bestBid >= sellPrice`; a best-bid force sell
    fills immediately at the current `bestBid`. PnL accrues to the
    `BudgetManager`'s virtual balance. This is intentionally more realistic
    than `btc5m-bot.ts`'s instant-fill dry-run, so the strategy's edge can be
    measured.
  - `dryRun = false` (LIVE): real orders via `PolymarketService`; fills
    detected via a reusable `ScalperUserWs` instance, matching on `orderId`
    or `assetIds` (same approach as `btc5m-bot.ts`). Status mapping uses the
    same helpers (`isFilledStatus`, `isFailureStatus`).

## Budget guardrail (uses `BudgetManager`)

- A configurable **working budget** (`workingBudgetUsd`, default `5`) is the
  total capital the bot may risk. Protects the wider Polymarket account.
- Backed by `BudgetManager` with its own `Btc15mStateStore` and its own
  `maxBotBudget` (separate from the scalper budget). On engine start the
  budget is initialized; the optional balance-check verifies the real account
  has at least the working budget available.
- Per cycle:
  - Before placing a buy, `reserve(stake, "cycle-start")`. If reservation
    throws (insufficient available budget), the engine **auto-stops** and logs
    "budget exhausted".
  - On buy fill, the reserved amount is `consume(...)`d (moves from locked to
    spent).
  - On a successful sell, `addFunds(proceeds, "cycle-close")` credits the
    proceeds back to available budget.
  - On buy cancellation (irrelevant order or late market with no fill),
    `release(reservedAmount, ...)` returns the reservation.
- All persists via `Btc15mStateStore`. Working budget and PnL survive
  restarts.

## Configuration

Settings panel in the `BTC 15m` tab, with defaults:

| Field | Default |
|---|---|
| Working budget (USD) | 5 |
| Shares per cycle | 5 |
| Buy price (USD) | 0.25 |
| Sell price (USD) | 0.40 |
| Repeat threshold (min) | 6 |
| Force-sell threshold (min) | 2 |
| Neutral zone (USD around start) | 5 |

The bot is **off by default**. Start/Stop is a single button. A `SIM` / `LIVE`
badge reflects the `dryRun` setting. Server-side defaults live under
`settings.btc15m` in `config.ts` (`stateFile`, `maxBotBudget`, plus any
backend-fixed defaults the UI does not override).

## Backend API and frontend polling

Mirroring the existing `/api/btc5m/*` and `/api/scalper/*` routes:

- `GET /api/btc15m/status` — current engine state, current cycle, budget
  snapshot, completed-trade table, recent log entries. Single payload that
  drives the whole UI.
- `POST /api/btc15m/start` — start the engine with a config body.
- `POST /api/btc15m/stop` — stop the engine.

No WebSocket broadcast for engine state — `btc5m-bot.ts` doesn't broadcast,
and the frontend polls. The `BTC 15m` tab polls `/api/btc15m/status` on a
short cadence (default 3 seconds, matching the BTC 5m bot UI) while the tab
is active.

## Frontend tab

- Add `"btc15m"` to the `AppTab` union (currently
  `"weather" | "positions" | "btc5m"`), a nav button next to `BTC 5M Bot`,
  a polling effect on `/api/btc15m/status`, and a render section, following
  the existing `BTC 5M Bot` tab.
- **Settings panel**: the configuration fields above plus Start/Stop and the
  `SIM` / `LIVE` badge.
- **Live monitor**: current market slug and question, time remaining, start
  and current BTC price with delta, active side, engine and cycle state.
- **Current cycle**: pending buy order (side / price / size / status),
  position (quantity / average), sell order (price / status).
- **Analytics table** (wins / losses): one row per completed trade — time,
  market, side (UP / DOWN), buy price, sell price, quantity, PnL, result
  (win / loss), exit reason (target sell / force sell / resolved). Summary
  header: total trades, wins, losses, win rate, total PnL, remaining budget.
- Premium dark theme: Mint for success, Rose for sell / error, Gold for
  headers.

## Persistence

`Btc15mStateStore` (mirrors `scalper/state-store.ts`: atomic temp-file
rename, queued updates, normalization) writes to its own state file
(`settings.btc15m.stateFile`, default e.g. `data/btc15m-trader-state.json`).
Persists: config, engine on/off, current market, cycle state, tracked open
orders, held position, `BudgetManager` snapshot, completed-trade analytics
table. Restored on startup; the engine starts `STOPPED` regardless.

## Safety

- Respect `dryRun` before any real order.
- Cycle notional is bounded and within `maxOrderUsdc`.
- The `BudgetManager` bounds cumulative exposure to `workingBudgetUsd`.
- One market and one cycle at a time.
- On unrecoverable errors the engine stops gracefully and logs the reason.
- Scalper and `BTC 5M Bot` are not modified; their state stores and budgets
  are independent.

## Risks and open items

- 15m market discovery and token-ID resolution must be reliable. The
  deterministic 15-minute boundary slug helps; legacy notes flag that 5m
  discovery was historically imperfect.
- LIVE-mode fill detection latency depends on the user WebSocket; a polling
  fallback (`getOrder`) mitigates this.
- The strategy must use Polymarket/Chainlink data for both start and current
  BTC price. If that source is unavailable, the bot skips trading the market
  rather than falling back to an external exchange.
- `btc5m-bot.ts` is in-memory (no state file). Our module adds persistence
  for the analytics table and budget — extra surface to test but the
  scalper state-store pattern is well established.

## Out of scope

- Multiple concurrent markets or concurrent cycles.
- Martingale or averaging-down logic.
- Changes to Scalper, `BTC 5M Bot`, or any other existing strategy.
