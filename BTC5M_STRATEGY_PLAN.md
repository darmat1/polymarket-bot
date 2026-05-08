# BTC 5m Strategy Plan

Goal: implement and compare realistic simulated strategies for `btc-updown-5m-*` markets before enabling any real trading.

Primary objective:
- Maximize net account balance, not raw win rate and not merely market resolution accuracy.
- A trade is good only if total cash in minus total cash out produces positive net PnL after fees and execution costs.

Rules:
- Keep all BTC 5m entries and exits in simulation mode for now.
- Do not connect these strategies to real `placeLimitOrder` flow yet.
- Prefer websocket-driven execution and evaluation over polling.
- Treat PnL after spread/slippage as the main truth metric.

## Profitability Model

Core principle:
- The bot does not need to hold until settlement to be successful.
- The bot should exit whenever selling the position improves realized balance versus continuing to hold.

Example:
- Buy costs `1.02` total including fees.
- If the simulated sell returns `1.05`, the trade is profitable even if the market has not settled.
- Therefore the correct target is realized account growth, not "winning the bet" in the binary sense.

Implication:
- Every strategy must use balance-based entry/exit accounting.
- Entry cost must include modeled fees.
- Exit proceeds must include modeled fees/slippage.
- Report both gross and net PnL, but optimize for net PnL.

## Loss-Control Principle

Core principle:
- If profit turns negative, the bot must have rules for cutting the position early.
- It is often better to sell lower and preserve part of the stake than to risk losing the entire position at settlement.

Required behavior:
- Add explicit stop-loss logic for all strategies.
- Stop-loss should be based on live exit value, not only on market resolution.
- Forced loss exits are acceptable if they improve expected balance preservation.

Exit hierarchy:
- Take profit when realized exit value is sufficiently positive.
- Stop out when realized exit value falls below allowed drawdown threshold.
- Time stop if trade is stagnant and expected edge disappears.
- Forced flatten near expiry if holding risk is no longer justified.

## Strategy Shortlist

### 1. Momentum + Book Confirmation

Idea:
- Enter only when BTC spot momentum and Polymarket live book both confirm the same direction.

Entry conditions:
- BTC spot short-horizon move is positive for `up` or negative for `down`.
- `best_bid_ask` updates move in the same direction for the selected token.
- Spread is below a configured threshold.
- Book is not too thin near top of book.
- No entry if market is too close to settlement.

Exit conditions:
- Take profit when net exit proceeds exceed total entry cost by configured minimum profit.
- Fast stop if BTC spot momentum reverses.
- Stop-loss when net exit proceeds fall below configured max tolerated loss.
- Time stop if expected move does not continue within a short window.
- Forced exit near market end.

Why test it:
- Best fit for the existing realtime websocket architecture.
- Most likely to capture short-lived BTC 5m directional bursts.

### 2. Order Book Imbalance + Short Hold

Idea:
- Trade only when the active side of the book is materially stronger than the opposite side.

Entry conditions:
- Top-of-book and nearby depth imply strong imbalance.
- Recent price updates agree with the imbalance direction.
- Spread remains acceptable.
- No entry on stale or low-activity book.

Exit conditions:
- Small net TP based on realized balance improvement.
- Immediate exit when imbalance collapses.
- Hard stop-loss when live exit value degrades below threshold.
- Very short max holding time.

Why test it:
- Gives a pure microstructure strategy independent from slower candle indicators.
- Useful as a baseline against momentum-driven entries.

### 3. Hybrid Regime Strategy

Idea:
- Use different rules depending on time remaining in the 5m market.

Regimes:
- Early regime: momentum-friendly.
- Middle regime: allow only stronger confirmations.
- Late regime: reduce entries, tighten exits, prefer risk-off behavior.

Entry conditions:
- Same base signals as strategy 1 or 2.
- Thresholds become stricter as settlement approaches.

Exit conditions:
- TP/stop driven by live book.
- Hard flatten before expiry.

Why test it:
- BTC 5m event contracts often behave differently near the end of the market.
- One static rule set is unlikely to be robust across the full 5m window.

## Implementation Order

### Phase 1: Simulation Observability

Add metrics and logs first:
- Live spread at entry.
- Live best ask used for simulated buys.
- Live best bid used for simulated sells.
- Time-to-expiry at entry and exit.
- BTC spot move over short windows around entry.
- Whether entry was caused by momentum, imbalance, or hybrid regime.
- Exit reason: TP, stop, reversal, time stop, settlement, forced flatten.

Add aggregate reporting:
- PnL by strategy.
- PnL by direction (`up` vs `down`).
- PnL by spread bucket.
- PnL by time-to-expiry bucket.
- Average hold time.
- Win rate.
- Max drawdown.

### Phase 2: Strategy 1

Implement:
- BTC spot short-window momentum signal.
- Live book confirmation gate.
- Spread filter.
- Time stop and reversal stop.

Target outcome:
- Determine whether simple directional confirmation has real edge after execution costs.

### Phase 3: Strategy 2

Implement:
- Order book imbalance score.
- Activity/staleness filter.
- Small TP and quick invalidation logic.

Target outcome:
- Compare microstructure-only edge versus momentum-assisted edge.

### Phase 4: Strategy 3

Implement:
- Time-to-expiry regime switching.
- Different thresholds for early/mid/late phases.

Target outcome:
- Check whether regime-aware behavior improves stability and reduces late-entry losses.

## Concrete Rules To Prototype

### Shared Filters

- No new entry if spread exceeds configured max.
- No new entry if market is not `live`.
- No new entry if live book has no valid best bid/ask.
- No new entry within a final cutoff window before market end.
- Only one open simulated position at a time in the first iteration.
- Every open position must continuously compute:
  - total entry cost,
  - current estimated exit proceeds,
  - current net PnL,
  - max allowed loss threshold,
  - target profit threshold.

### Strategy 1 Draft Rules

- Compute BTC spot drift over recent short windows.
- Require drift above positive threshold for `up` and below negative threshold for `down`.
- Require Polymarket best ask or midpoint to have moved in same direction over recent websocket samples.
- Enter using live `bestAsk`.
- Exit on:
  - net take-profit,
  - net stop-loss,
  - opposite momentum threshold,
  - max hold timeout,
  - final flatten cutoff.

### Strategy 2 Draft Rules

- Build imbalance score from top-of-book and nearby visible levels if available.
- Enter only when imbalance exceeds threshold and recent trade/book updates confirm it.
- Use smaller profit targets than momentum strategy.
- Exit quickly when imbalance score decays.
- Exit immediately if net loss threshold is breached.

### Strategy 3 Draft Rules

- Early window: allow momentum entries with moderate threshold.
- Middle window: require stronger book confirmation.
- Late window: no fresh entries or only very selective imbalance trades.
- Force flat shortly before settlement.

## Metrics Required Before Any Real Trading

Must measure in simulation first:
- Net PnL after modeled fees/slippage.
- Gross PnL versus net PnL delta.
- Trade count large enough to avoid false confidence.
- Stability across different days.
- No dependence on a few outlier wins.
- Positive expectancy by regime, not only overall.

Must log per trade:
- Total entry cost.
- Estimated exit proceeds at each decision point.
- Realized exit proceeds.
- Net PnL.
- Whether exit was TP, stop-loss, reversal, timeout, or settlement.

Minimum acceptance bar:
- Positive net expectancy.
- Controlled drawdown.
- Clear evidence that live websocket execution improves results over poll-only logic.

## Risks To Watch

- Spread too wide for small edge.
- Adverse selection: book looks good right before reversal.
- Book spoofing / fake depth.
- Market going stale near settlement.
- Strategy overfitting to a few sessions.
- Simulated fills being too optimistic versus real fills.

## Next Session Tasks

1. Add strategy identifiers and richer trade logs to `btc5m-sim` state.
2. Add live execution metrics to every simulated entry and exit.
3. Implement Strategy 1 first.
4. Replay/test for enough sessions to compare baseline vs Strategy 1.
5. Only then add Strategy 2 and Strategy 3.

## Non-Goals For Next Session

- No real order placement.
- No automatic switch out of `dryRun`.
- No martingale or averaging-down logic.
- No UI redesign unless needed for strategy observability.
