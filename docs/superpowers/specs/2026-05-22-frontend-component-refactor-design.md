# Frontend Component Refactor — Design

Status: approved for planning
Date: 2026-05-22

## Goal

Refactor the frontend away from a single oversized `App.tsx` into a screen-based
component structure that is safer to modify incrementally, especially when new
strategy bots are added.

The current frontend mixes global shell UI, tab state, per-screen rendering,
API calls, polling, websocket lifecycle, local forms, formatters, and utility
logic in one file. That makes edits high-risk: changes for one strategy often
touch unrelated UI and regress the rest of the application.

The target state is:

- one shared shell with a header and tab navigation;
- one isolated screen module per tab;
- narrow contracts between shell and screens;
- common utilities extracted once into shared modules;
- no behavioral changes to backend API contracts during the refactor.

## Scope and Boundaries

In scope for this refactor:

- split `positions`, `weather`, `btc5m`, and `btc15m` into separate screen
  modules;
- create a shared app shell with:
  - header;
  - account balance display;
  - manual balance refresh action;
  - tab navigation;
- move common formatters, lightweight shared UI, and API helpers into shared
  modules;
- allow strategy screens to request a shell-level account refresh after
  confirmed trade lifecycle events.

Out of scope for this refactor:

- changing backend endpoints or response shapes;
- rewriting strategy behavior;
- introducing a global state library;
- introducing a generalized "bot framework" abstraction shared by all
  strategies;
- converting tabs to React Router unless a later task explicitly requires it.

## Recommended Approach

Three approaches were considered:

1. Keep `App.tsx` as the center and only extract JSX fragments.
2. Split by screens with a small shared layer for shell, API helpers, and UI.
3. Adopt a heavier layered architecture such as full feature-sliced design.

Recommended: **Approach 2, screen-based modules plus a small shared layer**.

Reason:

- matches the product structure directly: the app is organized around tabs and
  strategies;
- creates strong edit boundaries for future bot work;
- keeps the architecture simple enough for this codebase;
- avoids over-abstracting two existing strategy tabs into a premature common
  framework.

## Proposed Structure

```text
frontend/src/
  app/
    App.tsx
    AppShell.tsx
    tabs.ts
  screens/
    positions/
      PositionsScreen.tsx
      components/...
    weather/
      WeatherScreen.tsx
      components/...
    btc5m/
      Btc5mScreen.tsx
      components/...
    btc15m/
      Btc15mScreen.tsx
      components/...
  shared/
    api/
      http.ts
      account.ts
      positions.ts
      weather.ts
      btc5m.ts
      btc15m.ts
      events.ts
    hooks/
      useAccountSummary.ts
      useToasts.ts
    ui/
      Header.tsx
      Tabs.tsx
      Panel.tsx
      StatusMessage.tsx
      EmptyState.tsx
    lib/
      format.ts
      dates.ts
      guards.ts
    types/
      api.ts
      app.ts
```

This structure is intentionally screen-first. New strategies should be added as
new screen folders rather than as extensions of a shared bot monolith.

## Responsibilities

### `App.tsx`

`App.tsx` becomes a thin composition file. It should:

- mount the shell;
- select the active tab;
- render the current screen component.

It should not own screen-specific polling, websocket, strategy forms, or table
markup.

### `AppShell.tsx`

`AppShell.tsx` owns app-level concerns only:

- `activeTab`;
- account summary loading;
- manual account balance refresh;
- header rendering;
- tab navigation rendering;
- passing shell controls into the current screen.

It should not know strategy-specific details.

### Screen modules

Each screen owns its own:

- `fetch` logic;
- polling intervals;
- `useEffect` lifecycle;
- websocket setup and cleanup;
- local forms;
- local derived view state;
- local child components.

This applies to:

- `PositionsScreen`
- `WeatherScreen`
- `Btc5mScreen`
- `Btc15mScreen`

### Shared modules

Shared modules are only for things that are actually common:

- API wrappers around existing endpoints;
- pure formatters and date helpers;
- narrow reusable UI primitives;
- shared payload types;
- small generic hooks such as toast state.

Do not move strategy behavior into shared code unless two or more screens
already depend on the same stable contract.

## Shell-to-Screen Contract

Screens need a way to ask the shell to refresh account balances after real
portfolio-affecting events. That should be done through an explicit prop-based
contract.

Proposed interface:

```ts
export type ShellControls = {
  refreshAccountSummary: () => Promise<void>;
};
```

Each screen receives `shellControls` from the shell. Screens may call
`refreshAccountSummary()` when they need the header balances to reflect the
latest confirmed state.

Use cases:

- manual balance refresh from the header;
- strategy screen triggers refresh after a confirmed completed trade;
- `PositionsScreen` triggers refresh after manual sell workflow events.

This avoids:

- direct mutation of shell state from screens;
- hidden coupling through module globals;
- an event bus or global store for a simple single-purpose interaction.

## Account Refresh Rules

The shell owns the account summary fetch implementation and should protect it
against duplicate refresh bursts.

Expected behavior:

- the header exposes a manual refresh control;
- the shell guards against parallel refresh requests;
- repeated refresh requests close together should be coalesced or ignored while
  one is already in flight;
- screens should trigger refresh only on confirmed state-changing events.

Refresh triggers must be tied to actual balance-impacting events, for example:

- order filled;
- position closed;
- trade completed;
- manual sell submitted and then filled or otherwise confirmed complete.

Screens should not trigger account refresh for every log line or every polling
tick.

## Screen Details

### `PositionsScreen`

Owns:

- positions loading;
- positions grouping and sorting;
- manual sell flow;
- event log panel if it remains tied to the positions experience;
- refreshing positions-related data on its own cadence.

Must preserve current business rules:

- group positions by `endDate`;
- the current-day group must be labeled `Actual Today`;
- the current-day group must be shown first;
- action buttons remain vertically stacked;
- the current responsive layout behavior remains intact.

### `WeatherScreen`

Owns:

- search and selected market state;
- weather forecast loads;
- station history loads;
- market detail loads;
- weather-specific polling and derived display state.

### `Btc5mScreen`

Owns:

- bot status fetches;
- bot start/stop actions;
- screen-local polling;
- screen-local logs and derived display;
- refresh requests to shell after confirmed trade lifecycle events.

### `Btc15mScreen`

Owns:

- status fetches;
- start/stop actions;
- reset budget action;
- form state for strategy config;
- screen-local polling;
- screen-local logs and analytics;
- refresh requests to shell after confirmed trade lifecycle events.

## API Layer

The refactor should introduce thin API helpers around existing endpoints. These
helpers should:

- preserve current request and response shapes;
- live in `shared/api/*`;
- avoid embedding screen-specific business logic.

Examples:

- `getAccountSummary()`
- `getPositions()`
- `getBtc5mStatus()`
- `toggleBtc5mBot()`
- `getBtc15mStatus()`
- `toggleBtc15mBot()`
- `resetBtc15mBudget()`
- `searchEvents()`
- `getHourlyForecast()`

These wrappers exist to reduce duplication and make screens smaller, not to
create a second business layer.

## Migration Plan

The refactor should be done incrementally in a behavior-preserving order.

1. Extract shared types, pure formatters, and pure helper functions from
   `App.tsx`.
2. Introduce `app/AppShell.tsx`, `shared/ui/Header.tsx`, and
   `shared/ui/Tabs.tsx`.
3. Move account summary ownership and manual refresh into the shell.
4. Extract `PositionsScreen`.
5. Extract `WeatherScreen`.
6. Extract `Btc5mScreen`.
7. Extract `Btc15mScreen`.
8. Remove obsolete code from `App.tsx` until it becomes a thin composition
   layer.

This order keeps the shell contract stable before moving the strategy screens
that depend on balance refresh.

## Testing and Verification

Verification after refactor must cover:

- tab switching across all screens;
- header account summary display;
- manual balance refresh from the header;
- shell balance refresh after:
  - completed strategy trade events;
  - confirmed manual sell events;
- polling only while the relevant screen is mounted;
- websocket cleanup on screen unmount;
- current positions grouping and ordering rules;
- responsive behavior currently required by the project rules.

Where possible, testing should stay focused on:

- screen extraction regressions;
- shell-to-screen refresh contract;
- lifecycle cleanup for intervals and sockets.

## Risks and Mitigations

### Risk: lifecycle leaks

Moving logic into screens can accidentally leave polling intervals or websocket
connections alive after tab switches.

Mitigation:

- keep lifecycle setup and cleanup inside each screen;
- keep each polling source local to the owning screen.

### Risk: duplicate balance refreshes

Multiple events may request header refresh close together.

Mitigation:

- shell-level in-flight guard for `refreshAccountSummary`;
- optional coalescing of near-simultaneous requests.

### Risk: accidental behavioral changes during refactor

A structural refactor can quietly alter existing user behavior.

Mitigation:

- keep backend API contracts unchanged;
- preserve existing tab semantics;
- migrate screen by screen;
- verify every tab after each extraction step.

### Risk: new shared layer becoming another dumping ground

Mitigation:

- `shared` accepts only truly reusable primitives;
- strategy-specific components stay under their screen folders;
- avoid creating a generic strategy abstraction without repeated proven need.

## Success Criteria

The refactor is successful when:

- `frontend/src/App.tsx` is reduced to a thin app composition layer;
- each tab is owned by a separate screen module;
- the header balance can be refreshed manually;
- strategy and positions screens can request a shell-level balance refresh after
  confirmed balance-changing actions;
- future strategy tabs can be added by creating a new screen folder instead of
  editing a large central file;
- the visible UI behavior remains consistent with the current application.
