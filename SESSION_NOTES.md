# Session Notes

This file is a continuity note for the assistant. Treat it as the current working instruction set for the next session.

## Current Project Rules

- Keep active bot polling at exactly `65000ms`.
- Keep weather station history cache TTL at exactly `60000ms`.
- For temperature ranges like `62-63F`, always use the lower bound as target `t`.
- Always respect `dryRun` before placing real orders.

## Current State

The app has recently shifted toward automatic account and market monitoring.

Implemented and expected to remain in place:

- BTC 5m panel exists in the frontend.
- Backend exposes BTC 5m snapshot and candle endpoints.
- BTC 5m prediction uses Groq first, with heuristic fallback.
- Portfolio summary reflects Polymarket account state, not only wallet USDC.
- Positions and balances auto-refresh from the Polymarket user websocket.
- Manual sells show lifecycle badges.
- The old `User WS` debug tab was removed.
- Scanner can load recent blockchain market-creation history from the backend.

## Backend Features Already Added

### BTC 5m

- `GET /api/btc-5m-current`
- `GET /api/btc-candles?limit=N`

Related backend behavior:

- BTC candles come from Binance `BTCUSDT` 1m candles.
- BTC 5m snapshot includes prediction data.
- Prediction cache TTL is `60s`.
- Market selector order is:
  - current `live`
  - `upcoming` only if within `10 minutes`
  - otherwise latest `recent`
- Missing CLOB `/book` data should not fail the whole BTC 5m panel.

### Scanner / Account

- `GET /api/scanner-events`
- Account summary returns:
  - `portfolio_value`
  - `available_to_trade`
  - `usdc_balance`

## Frontend Features Already Added

### BTC 5m Panel

The `BTC 5m` tab currently shows:

- selected market slug and question
- market status: `live | upcoming | recent`
- start BTC price
- current BTC price
- price change since market start
- 1-minute BTC chart
- dry-run `Auto Buy Yes` / `Auto Buy No` toggles
- current position `avg`
- `avg * 1.1` sell threshold display
- re-entry guidance versus `avg`
- prediction card

### Portfolio / Positions UI

- Top bar shows:
  - `Portfolio`
  - `Available`
  - `Wallet USDC`
- Background websocket sync reconnects automatically.
- It loads auth from `/api/user-ws-auth`.
- It sends `PING` heartbeats.
- On `order` and `trade` events it refreshes positions and account summary.
- Manual sell statuses include:
  - `submitting`
  - `open`
  - `partial`
  - `filled`
  - `error`

## Known Problems

### BTC 5m Market Resolution

This is still incomplete.

Current limitations:

- Gamma discovery for short-lived `btc-updown-5m-*` markets is imperfect.
- Nearby windows may be missing from Gamma search results.
- Real tradeable token IDs are not reliably resolved yet.
- Because of that, CLOB `/book` often returns no useful `yes` / `no` data.
- The current selector is more reasonable than before, but it is still discovery-driven.

### Scanner Runtime Dependency

- Historical scanner data can come from the backend route.
- Real-time scanner updates still depend on the separate listener process.
- Docker service: `listener`
- Entry point: `backend/dist/blockchain-listener.js`

## Highest-Priority Next Task

Build a reliable resolver for the actual current BTC 5m market and its real token IDs.

That work should include:

1. Determine the authoritative source for live/current `btc-updown-5m-*` windows.
2. Resolve real tradeable token IDs for `Up` and `Down`.
3. Verify `GET /book` works with those resolved token IDs.
4. Feed real market pricing into prediction logic.
5. Update the UI label to explicitly indicate why the selected market is shown:
   - `Actual Live`
   - `Nearest Upcoming`
   - `Latest Recent`

## Secondary Task

Add a `skip bad entry` rule that combines:

- Groq direction
- underlying BTC trend
- real market midpoint or spread
- current position `avg`

## Verification Requirements

- After any backend change affecting routes, server behavior, or background services, restart with:
  - `docker-compose up --build -d`
- If `docker-compose` is unavailable, state that blocker explicitly.

Expected verification when continuing this work:

1. Confirm `/api/btc-5m-current` returns the intended live or nearest-valid market.
2. Confirm `/api/btc-candles` returns candle data.
3. Confirm resolved BTC 5m token IDs return valid CLOB `/book` data.
4. Confirm scanner history loads from `/api/scanner-events`.
5. If the listener is running, confirm live scanner updates arrive.
6. Confirm manual sell badge transitions still work.

## Environment Notes From Prior Session

Previously observed tool availability issue:

- `node`: not found
- `pnpm`: not found
- `npm`: not found
- `bun`: not found
- `docker-compose`: not found

Do not assume these are now fixed. Re-check before claiming verification.

## Files Most Likely Relevant Next

- `backend/src/app.ts`
- `backend/src/server.ts`
- `frontend/src/App.tsx`
- `frontend/src/styles.css`
- `SESSION_NOTES.md`
- `CLAUDE.md`

## Resume Prompt

Continue from `SESSION_NOTES.md`.

First focus on reliable live-market resolution for `btc-updown-5m-*` and obtaining real tradeable token IDs that return valid CLOB `/book` data.

Then wire those real market prices into prediction and the `skip bad entry` logic.

Preserve the `65000ms` bot polling rule, the `60000ms` weather cache TTL, and `dryRun` safety before any real trading logic.

## Continuity Rule

If the session is at risk of ending before the work is fully wrapped, update this file with:

- current implementation state
- files changed
- remaining risks
- concrete next steps
