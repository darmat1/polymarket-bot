# Frontend Component Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the frontend into a shell-plus-screens structure so each tab owns its own logic while the header and balance refresh stay centralized.

**Architecture:** Keep one shared shell for header, balance refresh, and tab state, then move `positions`, `weather`, `btc5m`, and `btc15m` into isolated screen modules. Extract only genuinely shared types, formatters, UI wrappers, and thin API helpers; do not change backend endpoints or strategy behavior.

**Tech Stack:** React 19, TypeScript, Vite, existing CSS in `frontend/src/styles.css`

---

## File Structure Map

### Create

- `frontend/src/app/App.tsx` — thin app composition file that chooses the current screen.
- `frontend/src/app/AppShell.tsx` — owns `activeTab`, account summary load/refresh, header, tabs, and shell controls.
- `frontend/src/app/tabs.ts` — app tab ids, labels, and any shared tab metadata.
- `frontend/src/screens/positions/PositionsScreen.tsx` — positions screen container.
- `frontend/src/screens/weather/WeatherScreen.tsx` — weather screen container.
- `frontend/src/screens/btc5m/Btc5mScreen.tsx` — BTC 5m screen container.
- `frontend/src/screens/btc15m/Btc15mScreen.tsx` — BTC 15m screen container.
- `frontend/src/shared/api/http.ts` — shared JSON fetch helper.
- `frontend/src/shared/api/account.ts` — account summary endpoint wrapper.
- `frontend/src/shared/api/positions.ts` — positions and manual sell endpoint wrappers.
- `frontend/src/shared/api/weather.ts` — search, market details, history, and forecast wrappers.
- `frontend/src/shared/api/btc5m.ts` — BTC 5m status and toggle wrappers.
- `frontend/src/shared/api/btc15m.ts` — BTC 15m status, toggle, and reset budget wrappers.
- `frontend/src/shared/api/events.ts` — event log and active bot slug wrappers.
- `frontend/src/shared/hooks/useAccountSummary.ts` — shell-owned account summary state and guarded refresh.
- `frontend/src/shared/hooks/useToasts.ts` — generic toast state hook extracted from `App.tsx`.
- `frontend/src/shared/ui/Header.tsx` — shared header with balance and manual refresh action.
- `frontend/src/shared/ui/Tabs.tsx` — shared tab navigation.
- `frontend/src/shared/ui/Panel.tsx` — reusable panel wrapper.
- `frontend/src/shared/ui/StatusMessage.tsx` — shared status text wrapper.
- `frontend/src/shared/ui/EmptyState.tsx` — shared empty state wrapper.
- `frontend/src/shared/lib/format.ts` — number, money, price, duration, and status formatters from `App.tsx`.
- `frontend/src/shared/lib/dates.ts` — date/time helpers from `App.tsx`.
- `frontend/src/shared/lib/guards.ts` — guard helpers such as event filters and lightweight payload checks.
- `frontend/src/shared/types/api.ts` — shared API payload types currently declared in `App.tsx`.
- `frontend/src/shared/types/app.ts` — `AppTab`, `ShellControls`, and other app-level shared types.

### Modify

- `frontend/src/main.tsx` — import the new `app/App.tsx` entry.
- `frontend/src/App.tsx` — either delete after migration or turn into a compatibility re-export during the transition.
- `frontend/src/styles.css` — keep existing styles but reorganize selectors only as needed to support extracted components.

### Verification Surface

- `frontend/package.json` — use existing `build` script for compile verification.
- Manual browser verification after implementation on the existing Vite dev server.

## Implementation Notes

- The project does not currently include a frontend unit test runner. Use `pnpm --filter frontend build` as the required automated verification step for every task.
- Keep backend API paths and response shapes unchanged.
- Do not add a global state library or router in this refactor.
- Preserve current positions business rules from `CLAUDE.md`, especially grouping by `endDate`, current-day label `Actual Today`, current-day group first, and the current responsive layout behavior.

### Task 1: Extract Shared Types, Utilities, and API Wrappers

**Files:**
- Create: `frontend/src/shared/types/api.ts`
- Create: `frontend/src/shared/types/app.ts`
- Create: `frontend/src/shared/lib/format.ts`
- Create: `frontend/src/shared/lib/dates.ts`
- Create: `frontend/src/shared/lib/guards.ts`
- Create: `frontend/src/shared/api/http.ts`
- Create: `frontend/src/shared/api/account.ts`
- Create: `frontend/src/shared/api/positions.ts`
- Create: `frontend/src/shared/api/weather.ts`
- Create: `frontend/src/shared/api/btc5m.ts`
- Create: `frontend/src/shared/api/btc15m.ts`
- Create: `frontend/src/shared/api/events.ts`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Capture the shared contracts from `frontend/src/App.tsx` into dedicated modules**

```ts
// frontend/src/shared/types/app.ts
export type AppTab = "weather" | "positions" | "btc5m" | "btc15m";

export type ShellControls = {
  refreshAccountSummary: () => Promise<void>;
};
```

```ts
// frontend/src/shared/api/http.ts
export async function getJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = (await response.json()) as T & { error?: string };

  if (!response.ok || payload.error) {
    throw new Error(payload.error ?? `Request failed: ${response.status}`);
  }

  return payload;
}
```

- [ ] **Step 2: Move pure formatters and date helpers out of `App.tsx` without changing behavior**

```ts
// frontend/src/shared/lib/format.ts
export function formatUsdValue(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}
```

```ts
// frontend/src/shared/lib/dates.ts
export function formatDateInTimeZone(value: number | string | Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date(value));
}
```

- [ ] **Step 3: Add thin endpoint wrappers that preserve current request and response shapes**

```ts
// frontend/src/shared/api/account.ts
import { getJson } from "./http";
import type { AccountSummaryPayload } from "../types/api";

export function getAccountSummary() {
  return getJson<AccountSummaryPayload>("/api/account-summary");
}
```

```ts
// frontend/src/shared/api/btc15m.ts
import { getJson } from "./http";
import type { Btc15mStatusPayload } from "../types/api";

export function getBtc15mStatus() {
  return getJson<Btc15mStatusPayload>("/api/btc15m/status");
}
```

- [ ] **Step 4: Update `frontend/src/App.tsx` imports to consume the shared modules while still keeping the current screen markup intact**

```ts
// frontend/src/App.tsx
import { formatUsdValue, formatDurationMs, formatMarketPrice } from "./shared/lib/format";
import { formatDateInTimeZone } from "./shared/lib/dates";
import { getAccountSummary } from "./shared/api/account";
import type { AppTab } from "./shared/types/app";
```

- [ ] **Step 5: Run compile verification after the extraction**

Run: `pnpm --filter frontend build`

Expected: `tsc -b && vite build` completes successfully with no new TypeScript errors.

- [ ] **Step 6: Commit the shared extraction**

```bash
git add frontend/src/App.tsx frontend/src/shared
git commit -m "refactor(frontend): extract shared ui contracts and api helpers"
```

### Task 2: Introduce the App Shell, Header, Tabs, and Guarded Balance Refresh

**Files:**
- Create: `frontend/src/app/App.tsx`
- Create: `frontend/src/app/AppShell.tsx`
- Create: `frontend/src/app/tabs.ts`
- Create: `frontend/src/shared/hooks/useAccountSummary.ts`
- Create: `frontend/src/shared/hooks/useToasts.ts`
- Create: `frontend/src/shared/ui/Header.tsx`
- Create: `frontend/src/shared/ui/Tabs.tsx`
- Create: `frontend/src/shared/ui/Panel.tsx`
- Create: `frontend/src/shared/ui/StatusMessage.tsx`
- Create: `frontend/src/shared/ui/EmptyState.tsx`
- Modify: `frontend/src/main.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles.css`

- [ ] **Step 1: Create the tab metadata and a shell-owned account summary hook**

```ts
// frontend/src/app/tabs.ts
import type { AppTab } from "../shared/types/app";

export const APP_TABS: Array<{ id: AppTab; label: string }> = [
  { id: "positions", label: "Positions" },
  { id: "btc5m", label: "BTC 5m" },
  { id: "btc15m", label: "BTC 15m" },
  { id: "weather", label: "Weather" },
];
```

```ts
// frontend/src/shared/hooks/useAccountSummary.ts
import { useCallback, useRef, useState } from "react";
import { getAccountSummary } from "../api/account";
import type { AccountSummaryPayload } from "../types/api";

export function useAccountSummary() {
  const [accountSummary, setAccountSummary] = useState<AccountSummaryPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlightRef = useRef<Promise<void> | null>(null);

  const refreshAccountSummary = useCallback(async () => {
    if (inFlightRef.current) return inFlightRef.current;

    const pending = (async () => {
      setLoading(true);
      try {
        setAccountSummary(await getAccountSummary());
      } finally {
        setLoading(false);
        inFlightRef.current = null;
      }
    })();

    inFlightRef.current = pending;
    return pending;
  }, []);

  return { accountSummary, loading, refreshAccountSummary };
}
```

- [ ] **Step 2: Create the shell UI components with the manual balance refresh action**

```tsx
// frontend/src/shared/ui/Header.tsx
import type { AccountSummaryPayload } from "../types/api";

type HeaderProps = {
  accountSummary: AccountSummaryPayload | null;
  isRefreshing: boolean;
  onRefresh: () => void;
};

export function Header({ accountSummary, isRefreshing, onRefresh }: HeaderProps) {
  return (
    <header className="topbar">
      <div className="topbar-metrics">{/* existing balance metrics markup moved here */}</div>
      <div className="topbar-side">
        <button className="button button-secondary button-small" onClick={onRefresh} type="button">
          {isRefreshing ? "Refreshing..." : "Refresh Balance"}
        </button>
      </div>
    </header>
  );
}
```

```tsx
// frontend/src/shared/ui/Tabs.tsx
import { APP_TABS } from "../../app/tabs";
import type { AppTab } from "../types/app";

export function Tabs({ activeTab, onChange }: { activeTab: AppTab; onChange: (tab: AppTab) => void }) {
  return (
    <nav className="app-nav">
      {APP_TABS.map((tab) => (
        <button
          key={tab.id}
          className={`button tab-button ${activeTab === tab.id ? "tab-button-active" : ""}`}
          onClick={() => onChange(tab.id)}
          type="button"
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
```

- [ ] **Step 3: Build `AppShell.tsx` and hand the refresh contract down to the current screen**

```tsx
// frontend/src/app/AppShell.tsx
import { useEffect, useMemo, useState } from "react";
import { Header } from "../shared/ui/Header";
import { Tabs } from "../shared/ui/Tabs";
import { useAccountSummary } from "../shared/hooks/useAccountSummary";
import type { AppTab, ShellControls } from "../shared/types/app";

export function AppShell({ renderScreen }: { renderScreen: (args: { activeTab: AppTab; shellControls: ShellControls }) => React.ReactNode }) {
  const [activeTab, setActiveTab] = useState<AppTab>("positions");
  const { accountSummary, loading, refreshAccountSummary } = useAccountSummary();

  useEffect(() => {
    void refreshAccountSummary();
  }, [refreshAccountSummary]);

  const shellControls = useMemo<ShellControls>(
    () => ({ refreshAccountSummary }),
    [refreshAccountSummary],
  );

  return (
    <div className="shell">
      <Header
        accountSummary={accountSummary}
        isRefreshing={loading}
        onRefresh={() => void refreshAccountSummary()}
      />
      <Tabs activeTab={activeTab} onChange={setActiveTab} />
      {renderScreen({ activeTab, shellControls })}
    </div>
  );
}
```

- [ ] **Step 4: Replace the old root import path so the app starts through the shell**

```tsx
// frontend/src/main.tsx
import { App } from "./app/App";
import "./styles.css";
```

```tsx
// frontend/src/app/App.tsx
import { AppShell } from "./AppShell";

export function App() {
  return <AppShell renderScreen={() => null} />;
}
```

- [ ] **Step 5: Run compile verification after the shell is in place**

Run: `pnpm --filter frontend build`

Expected: build succeeds and the new `app/*` entry compiles cleanly.

- [ ] **Step 6: Commit the shell layer**

```bash
git add frontend/src/app frontend/src/shared/hooks frontend/src/shared/ui frontend/src/main.tsx frontend/src/styles.css frontend/src/App.tsx
git commit -m "refactor(frontend): add shell header and tab infrastructure"
```

### Task 3: Extract `PositionsScreen` and `WeatherScreen`

**Files:**
- Create: `frontend/src/screens/positions/PositionsScreen.tsx`
- Create: `frontend/src/screens/weather/WeatherScreen.tsx`
- Modify: `frontend/src/app/App.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles.css`

- [ ] **Step 1: Move the positions-specific state, effects, and JSX into `PositionsScreen.tsx`**

```tsx
// frontend/src/screens/positions/PositionsScreen.tsx
import { useEffect, useMemo, useState } from "react";
import type { ShellControls } from "../../shared/types/app";

export function PositionsScreen({ shellControls }: { shellControls: ShellControls }) {
  const [positionsPayload, setPositionsPayload] = useState(null);
  const [positionsError, setPositionsError] = useState<string | null>(null);

  useEffect(() => {
    // move existing positions load/polling logic here
  }, []);

  async function handleManualSellComplete() {
    await shellControls.refreshAccountSummary();
  }

  return <main className="layout">{/* existing positions tab JSX moved here */}</main>;
}
```

- [ ] **Step 2: Preserve positions business rules during the extraction**

```ts
// inside PositionsScreen.tsx
const groupedPositions = useMemo(() => {
  // move the current grouping logic unchanged
  // must preserve:
  // - grouping by endDate
  // - "Actual Today" label
  // - current-day group first
}, [/* existing deps */]);
```

- [ ] **Step 3: Move the weather-specific search, forecast, history, and market detail logic into `WeatherScreen.tsx`**

```tsx
// frontend/src/screens/weather/WeatherScreen.tsx
import { useEffect, useState } from "react";
import type { ShellControls } from "../../shared/types/app";

export function WeatherScreen({ shellControls: _shellControls }: { shellControls: ShellControls }) {
  const [search, setSearch] = useState("");
  const [events, setEvents] = useState([]);

  useEffect(() => {
    // move existing weather tab loads and polling here
  }, []);

  return <main className="layout">{/* existing weather tab JSX moved here */}</main>;
}
```

- [ ] **Step 4: Update `frontend/src/app/App.tsx` to route `positions` and `weather` through the new screen modules**

```tsx
// frontend/src/app/App.tsx
import { AppShell } from "./AppShell";
import { PositionsScreen } from "../screens/positions/PositionsScreen";
import { WeatherScreen } from "../screens/weather/WeatherScreen";

export function App() {
  return (
    <AppShell
      renderScreen={({ activeTab, shellControls }) => {
        if (activeTab === "positions") return <PositionsScreen shellControls={shellControls} />;
        if (activeTab === "weather") return <WeatherScreen shellControls={shellControls} />;
        return null;
      }}
    />
  );
}
```

- [ ] **Step 5: Run compile verification after extracting the first two screens**

Run: `pnpm --filter frontend build`

Expected: build succeeds with positions and weather logic removed from the new root composition layer.

- [ ] **Step 6: Manually verify the extracted screens in the browser**

Run: `pnpm --filter frontend dev`

Check:
- `Positions` tab loads.
- Positions still group by date.
- The current-day group still appears as `Actual Today`.
- Manual sell still triggers the balance refresh path.
- `Weather` tab search and detail views still render.

- [ ] **Step 7: Commit the first screen extraction**

```bash
git add frontend/src/app/App.tsx frontend/src/screens/positions frontend/src/screens/weather frontend/src/styles.css frontend/src/App.tsx
git commit -m "refactor(frontend): extract positions and weather screens"
```

### Task 4: Extract `Btc5mScreen` and Wire Shell Refresh on Completed Trade Events

**Files:**
- Create: `frontend/src/screens/btc5m/Btc5mScreen.tsx`
- Modify: `frontend/src/app/App.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles.css`

- [ ] **Step 1: Move BTC 5m state, polling, actions, and derived status rendering into `Btc5mScreen.tsx`**

```tsx
// frontend/src/screens/btc5m/Btc5mScreen.tsx
import { useEffect, useRef, useState } from "react";
import type { ShellControls } from "../../shared/types/app";

export function Btc5mScreen({ shellControls }: { shellControls: ShellControls }) {
  const [status, setStatus] = useState(null);
  const previousCompletionRef = useRef<string | null>(null);

  useEffect(() => {
    // move current btc5m polling here
  }, []);

  useEffect(() => {
    const completionKey = status?.lastCompletedMarketSlug ?? null;
    if (completionKey && previousCompletionRef.current !== completionKey) {
      previousCompletionRef.current = completionKey;
      void shellControls.refreshAccountSummary();
    }
  }, [shellControls, status]);

  return <main className="layout layout-single">{/* existing BTC 5m JSX */}</main>;
}
```

- [ ] **Step 2: Keep the refresh trigger narrow and tied to confirmed lifecycle state**

```ts
// inside Btc5mScreen.tsx
// Only trigger balance refresh when a new completed market is observed.
// Do not refresh on every polling response, phase change, or log append.
```

- [ ] **Step 3: Update `frontend/src/app/App.tsx` to render `Btc5mScreen` for the `btc5m` tab**

```tsx
import { Btc5mScreen } from "../screens/btc5m/Btc5mScreen";

// inside renderScreen
if (activeTab === "btc5m") return <Btc5mScreen shellControls={shellControls} />;
```

- [ ] **Step 4: Run compile verification after the BTC 5m extraction**

Run: `pnpm --filter frontend build`

Expected: build succeeds and no BTC 5m logic remains in the top-level app composition.

- [ ] **Step 5: Manually verify the BTC 5m flow**

Run: `pnpm --filter frontend dev`

Check:
- `BTC 5m` tab renders.
- Refresh button still works in the header.
- Start/stop actions still work.
- Polling stops when leaving the tab.
- A completed trade event path triggers the shell balance refresh.

- [ ] **Step 6: Commit the BTC 5m extraction**

```bash
git add frontend/src/app/App.tsx frontend/src/screens/btc5m frontend/src/styles.css frontend/src/App.tsx
git commit -m "refactor(frontend): extract btc5m screen"
```

### Task 5: Extract `Btc15mScreen`, Finish the Root Cleanup, and Verify the Whole App

**Files:**
- Create: `frontend/src/screens/btc15m/Btc15mScreen.tsx`
- Modify: `frontend/src/app/App.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles.css`

- [ ] **Step 1: Move BTC 15m form state, status polling, actions, and analytics rendering into `Btc15mScreen.tsx`**

```tsx
// frontend/src/screens/btc15m/Btc15mScreen.tsx
import { useEffect, useRef, useState } from "react";
import type { ShellControls } from "../../shared/types/app";

export function Btc15mScreen({ shellControls }: { shellControls: ShellControls }) {
  const [status, setStatus] = useState(null);
  const [formConfig, setFormConfig] = useState({
    workingBudgetUsd: 3,
    shares: 5,
    buyPrice: 0.52,
    trailStep: 50,
    trailDist: 100,
    trailUpdateIntervalSec: 5,
    repeatThresholdMin: 3,
    forceSellThresholdMin: 2,
    neutralZoneUsd: 30,
  });
  const lastRefreshKeyRef = useRef<string | null>(null);

  useEffect(() => {
    // move current btc15m polling and form sync here
  }, []);

  useEffect(() => {
    const refreshKey = status?.completedTrades?.[0]?.id ?? null;
    if (refreshKey && lastRefreshKeyRef.current !== refreshKey) {
      lastRefreshKeyRef.current = refreshKey;
      void shellControls.refreshAccountSummary();
    }
  }, [shellControls, status]);

  return <main className="layout layout-single btc15m-tab">{/* existing BTC 15m JSX */}</main>;
}
```

- [ ] **Step 2: Update `frontend/src/app/App.tsx` to fully switch over to screen-based rendering**

```tsx
// frontend/src/app/App.tsx
import { AppShell } from "./AppShell";
import { PositionsScreen } from "../screens/positions/PositionsScreen";
import { WeatherScreen } from "../screens/weather/WeatherScreen";
import { Btc5mScreen } from "../screens/btc5m/Btc5mScreen";
import { Btc15mScreen } from "../screens/btc15m/Btc15mScreen";

export function App() {
  return (
    <AppShell
      renderScreen={({ activeTab, shellControls }) => {
        if (activeTab === "positions") return <PositionsScreen shellControls={shellControls} />;
        if (activeTab === "weather") return <WeatherScreen shellControls={shellControls} />;
        if (activeTab === "btc5m") return <Btc5mScreen shellControls={shellControls} />;
        return <Btc15mScreen shellControls={shellControls} />;
      }}
    />
  );
}
```

- [ ] **Step 3: Reduce `frontend/src/App.tsx` to a compatibility wrapper or remove it from active use**

```tsx
// frontend/src/App.tsx
export { App } from "./app/App";
```

- [ ] **Step 4: Run compile verification for the full refactor**

Run: `pnpm --filter frontend build`

Expected: build succeeds with the new screen-based architecture and the old giant `App.tsx` no longer owning application behavior.

- [ ] **Step 5: Run final manual verification across all tabs**

Run: `pnpm --filter frontend dev`

Check:
- `Positions`, `Weather`, `BTC 5m`, and `BTC 15m` tabs all render.
- Header balance refresh button works.
- Strategy screens can trigger header balance refresh after confirmed trade completion.
- Positions manual sell path can trigger header balance refresh.
- No tab leaks polling or websocket behavior after leaving it.
- Existing responsive behavior still matches the project rules.

- [ ] **Step 6: Commit the final screen extraction**

```bash
git add frontend/src/app frontend/src/screens frontend/src/shared frontend/src/App.tsx frontend/src/main.tsx frontend/src/styles.css
git commit -m "refactor(frontend): split app into shell and tab screens"
```

## Self-Review

### Spec coverage

- Shared shell with header, balances, and tabs: covered by Task 2.
- Separate screen ownership for `positions`, `weather`, `btc5m`, and `btc15m`: covered by Tasks 3, 4, and 5.
- Manual shell balance refresh: covered by Task 2.
- Screen-triggered shell balance refresh after confirmed deal completion: covered by Tasks 3, 4, and 5.
- Shared utilities and API helpers only where appropriate: covered by Task 1.
- Incremental, behavior-preserving migration order: covered across Tasks 1 through 5.

### Placeholder scan

- No `TODO`, `TBD`, or “implement later” placeholders are left in task steps.
- All commands are concrete and use the existing frontend scripts.

### Type consistency

- `AppTab` and `ShellControls` are defined once in `frontend/src/shared/types/app.ts`.
- `refreshAccountSummary()` is the only shell refresh interface used across tasks.
- Screen component names and paths are consistent across the task list.
