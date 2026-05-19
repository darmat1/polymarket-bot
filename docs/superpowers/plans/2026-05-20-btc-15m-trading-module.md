# BTC 15m Trading Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an automated contrarian (mean-reversion) trading bot for Polymarket 15-minute BTC up/down markets, exposed in a new `BTC 15m` tab, coexisting with Scalper and BTC 5M Bot.

**Architecture:** Backend strategy engine (`backend/src/btc15m/`) modeled on `btc5m-bot.ts` and `scalper/`. State machine with explicit cycle phases. Reuses `PolymarketService` (orders), `ScalperUserWs` (LIVE fills), `BudgetManager` + `scalper/state-store.ts` pattern (working-budget guardrail and persistence). Frontend `BTC 15m` tab polls `/api/btc15m/status` every 3s and exposes Start/Stop + configuration.

**Tech Stack:** TypeScript (strict), Node.js + `tsx`, `ws`, `@polymarket/clob-client-v2`, React (frontend), CSS for styling. Tests are ad-hoc isolated scripts using `node:assert/strict` run via `tsx` (matches existing convention `backend/src/__tests__/btc5m-bot.isolated.test.ts`).

**Spec:** `docs/superpowers/specs/2026-05-19-btc-15m-trading-module-design.md`

**User commit preference:** The user runs commits themselves. At each commit checkpoint, **pause and ask the user** before running `git commit`. Do not auto-commit.

---

## Spec-Constants Reference

Used across multiple tasks. The defaults below match the spec.

```
workingBudgetUsd       default 5
shares                 default 5
buyPrice               default 0.25
sellPrice              default 0.40
repeatThresholdMin     default 6
forceSellThresholdMin  default 2
neutralZoneUsd         default 5
marketWindowSec        900
tickIntervalMs         1500
statusPollMs           3000  (frontend)
stateFile              default "data/btc15m-trader-state.json"
```

---

## File Map

Create:
- `backend/src/btc15m/types.ts`
- `backend/src/btc15m/state-store.ts`
- `backend/src/btc15m/market-resolver.ts`
- `backend/src/btc15m/strategy.ts`
- `backend/src/btc15m/index.ts`
- `backend/src/btc15m/__tests__/state-store.isolated.test.ts`
- `backend/src/btc15m/__tests__/market-resolver.isolated.test.ts`
- `backend/src/btc15m/__tests__/strategy.isolated.test.ts`

Modify:
- `backend/src/config.ts` — add `Btc15mSettings`, env parsing, validator
- `backend/.env.example` — add `BTC15M_*` env vars
- `backend/src/server.ts` — add `/api/btc15m/{status,start,stop}` routes
- `frontend/src/App.tsx` — add `"btc15m"` tab + nav + status polling + settings/monitor/analytics
- `frontend/src/styles.css` — add btc15m section styles

**Do not modify**: anything under `backend/src/scalper/`, `backend/src/btc5m/`, `backend/src/btc5m-bot.ts`. Read-only references.

Be careful: the project uses ESM-style relative imports with `.js` extensions (e.g. `from "./types.js"`). New files MUST use the same convention even though the source is `.ts`.

---

## Task 1: Config — add `Btc15mSettings`

**Files:**
- Modify: `backend/src/config.ts`
- Modify: `backend/.env.example`

- [ ] **Step 1: Add the `Btc15mSettings` interface and validator stub.**

In `backend/src/config.ts`, right below `Btc5mSettings`, add:

```ts
export interface Btc15mSettings {
  buyPriceLimit: number;          // BTC15M_BUY_PRICE_LIMIT, default 0.25
  sellPriceLimit: number;         // BTC15M_SELL_PRICE_LIMIT, default 0.40
  orderSize: number;              // BTC15M_ORDER_SIZE, default 5
  workingBudgetUsd: number;       // BTC15M_WORKING_BUDGET, default 5
  repeatThresholdMin: number;     // BTC15M_REPEAT_MIN, default 6
  forceSellThresholdMin: number;  // BTC15M_FORCE_SELL_MIN, default 2
  neutralZoneUsd: number;         // BTC15M_NEUTRAL_ZONE_USD, default 5
  tickIntervalSec: number;        // BTC15M_TICK_INTERVAL_SEC, default 2
  stateFile: string;              // BTC15M_STATE_FILE, default "data/btc15m-trader-state.json"
}
```

Add `btc15m: Btc15mSettings` to the `Settings` interface (next to `btc5m: Btc5mSettings`).

- [ ] **Step 2: Parse env vars in `loadSettings()`.**

Inside `loadSettings()`, after the `btc5m` block, add:

```ts
const btc15m: Btc15mSettings = {
  buyPriceLimit: parseNumber(process.env.BTC15M_BUY_PRICE_LIMIT, 0.25),
  sellPriceLimit: parseNumber(process.env.BTC15M_SELL_PRICE_LIMIT, 0.4),
  orderSize: parseNumber(process.env.BTC15M_ORDER_SIZE, 5),
  workingBudgetUsd: parseNumber(process.env.BTC15M_WORKING_BUDGET, 5),
  repeatThresholdMin: parseNumber(process.env.BTC15M_REPEAT_MIN, 6),
  forceSellThresholdMin: parseNumber(process.env.BTC15M_FORCE_SELL_MIN, 2),
  neutralZoneUsd: parseNumber(process.env.BTC15M_NEUTRAL_ZONE_USD, 5),
  tickIntervalSec: parseNumber(process.env.BTC15M_TICK_INTERVAL_SEC, 2),
  stateFile: process.env.BTC15M_STATE_FILE?.trim() || "data/btc15m-trader-state.json",
};
```

Then `validateBtc15mSettings(btc15m);` before the `return`. Include `btc15m` in the returned `Settings` object.

- [ ] **Step 3: Implement the validator.**

At the bottom of `config.ts`, add:

```ts
function validateBtc15mSettings(settings: Btc15mSettings): void {
  for (const [name, value] of [
    ["BTC15M_BUY_PRICE_LIMIT", settings.buyPriceLimit],
    ["BTC15M_SELL_PRICE_LIMIT", settings.sellPriceLimit],
  ] as const) {
    if (!(value > 0 && value < 1)) {
      throw new Error(`${name} must be between 0 and 1.`);
    }
  }
  if (settings.sellPriceLimit <= settings.buyPriceLimit) {
    throw new Error("BTC15M_SELL_PRICE_LIMIT must be greater than BTC15M_BUY_PRICE_LIMIT.");
  }
  for (const [name, value] of [
    ["BTC15M_ORDER_SIZE", settings.orderSize],
    ["BTC15M_WORKING_BUDGET", settings.workingBudgetUsd],
    ["BTC15M_REPEAT_MIN", settings.repeatThresholdMin],
    ["BTC15M_FORCE_SELL_MIN", settings.forceSellThresholdMin],
    ["BTC15M_NEUTRAL_ZONE_USD", settings.neutralZoneUsd],
    ["BTC15M_TICK_INTERVAL_SEC", settings.tickIntervalSec],
  ] as const) {
    if (!(value > 0)) {
      throw new Error(`${name} must be greater than zero.`);
    }
  }
  if (settings.forceSellThresholdMin >= 15) {
    throw new Error("BTC15M_FORCE_SELL_MIN must be less than the 15-minute window.");
  }
}
```

- [ ] **Step 4: Add to `.env.example`.**

Append to `backend/.env.example`:

```
# BTC 15m trading module
BTC15M_BUY_PRICE_LIMIT=0.25
BTC15M_SELL_PRICE_LIMIT=0.40
BTC15M_ORDER_SIZE=5
BTC15M_WORKING_BUDGET=5
BTC15M_REPEAT_MIN=6
BTC15M_FORCE_SELL_MIN=2
BTC15M_NEUTRAL_ZONE_USD=5
BTC15M_TICK_INTERVAL_SEC=2
BTC15M_STATE_FILE=data/btc15m-trader-state.json
```

- [ ] **Step 5: Verify type-check.**

Run: `cd backend && pnpm run check`
Expected: PASS (no TypeScript errors).

- [ ] **Step 6: Commit checkpoint.**

Stage `backend/src/config.ts` and `backend/.env.example`. Ask the user to review and commit. Suggested message:
`feat(btc15m): add Btc15mSettings configuration and env vars`

---

## Task 2: `btc15m/types.ts` — shared types

**Files:**
- Create: `backend/src/btc15m/types.ts`

- [ ] **Step 1: Write the file.**

```ts
import type { BudgetSnapshot } from "../scalper/types.js";

export type Btc15mEnginePhase = "stopped" | "running" | "auto_stopped";

export type Btc15mCyclePhase =
  | "waiting_market"
  | "waiting_direction"
  | "buy_pending"
  | "holding"
  | "force_selling"
  | "cycle_done"
  | "market_idle";

export type Btc15mSide = "up" | "down";

export interface Btc15mMarketView {
  slug: string;
  question: string;
  startTimeMs: number;
  endTimeMs: number;
  upTokenId: string;
  downTokenId: string;
}

export interface Btc15mTrackedOrder {
  id: string;                  // local UUID
  orderId: string | null;      // remote CLOB order id
  side: "buy" | "sell";
  tokenId: string;
  bettingSide: Btc15mSide;     // which outcome (UP/DOWN) this order is on
  price: number;
  size: number;
  filledSize: number;
  status:
    | "submitting"
    | "open"
    | "partial"
    | "filled"
    | "cancel_requested"
    | "cancelled"
    | "expired"
    | "failed";
  reservedBudget: number;      // USD reserved via BudgetManager
  createdAt: number;
  updatedAt: number;
  errorMessage?: string | null;
}

export interface Btc15mPosition {
  bettingSide: Btc15mSide;
  tokenId: string;
  shares: number;
  avgEntryPrice: number;
  costBasisUsd: number;
}

export interface Btc15mCompletedTrade {
  id: string;
  marketSlug: string;
  bettingSide: Btc15mSide;
  buyPrice: number;
  sellPrice: number;
  shares: number;
  pnlUsd: number;
  result: "win" | "loss";
  exitReason: "target_sell" | "force_sell" | "resolved_unfilled";
  startedAt: number;
  closedAt: number;
}

export interface Btc15mAnalyticsSummary {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;     // 0..1
  totalPnlUsd: number;
  remainingBudgetUsd: number;
}

export interface Btc15mBotConfig {
  workingBudgetUsd: number;
  shares: number;
  buyPrice: number;
  sellPrice: number;
  repeatThresholdMin: number;
  forceSellThresholdMin: number;
  neutralZoneUsd: number;
  tickIntervalSec: number;
}

export interface Btc15mLogEntry {
  timestamp: number;
  message: string;
  type: "info" | "warn" | "error" | "success";
}

export interface Btc15mCycleState {
  cyclePhase: Btc15mCyclePhase;
  cycleStartedAt: number | null;
  buyOrder: Btc15mTrackedOrder | null;
  sellOrder: Btc15mTrackedOrder | null;
  position: Btc15mPosition | null;
}

export interface Btc15mBotStatus {
  enginePhase: Btc15mEnginePhase;
  dryRun: boolean;
  config: Btc15mBotConfig;
  market: Btc15mMarketView | null;
  marketStartBtcPrice: number | null;
  currentBtcPrice: number | null;
  cycle: Btc15mCycleState;
  completedTrades: Btc15mCompletedTrade[];
  analytics: Btc15mAnalyticsSummary;
  budget: BudgetSnapshot | null;
  logs: Btc15mLogEntry[];
  updatedAt: number;
  lastError: string | null;
}

export interface Btc15mPersistentState {
  version: 1;
  updatedAt: number;
  config: Btc15mBotConfig;
  completedTrades: Btc15mCompletedTrade[];
  budget: {
    initialBudget: number;
    availableBudget: number;
    lockedBudget: number;
    updatedAt: number;
  };
}

export interface Btc15mStateStoreOptions {
  filePath: string;
  defaultConfig: Btc15mBotConfig;
}
```

- [ ] **Step 2: Verify type-check.**

Run: `cd backend && pnpm run check`
Expected: PASS.

- [ ] **Step 3: Commit checkpoint.**

Stage `backend/src/btc15m/types.ts`. Ask user before commit. Suggested message:
`feat(btc15m): add shared types`

---

## Task 3: `btc15m/state-store.ts` — atomic JSON persistence

**Files:**
- Create: `backend/src/btc15m/state-store.ts`
- Create: `backend/src/btc15m/__tests__/state-store.isolated.test.ts`

Pattern mirrors `backend/src/scalper/state-store.ts`: atomic temp-file rename, queued updates via `updateQueue: Promise<void>`, normalization on load.

- [ ] **Step 1: Write the failing test.**

```ts
// backend/src/btc15m/__tests__/state-store.isolated.test.ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBtc15mStateStore } from "../state-store.js";
import type { Btc15mBotConfig, Btc15mCompletedTrade } from "../types.js";

const defaultConfig: Btc15mBotConfig = {
  workingBudgetUsd: 5,
  shares: 5,
  buyPrice: 0.25,
  sellPrice: 0.4,
  repeatThresholdMin: 6,
  forceSellThresholdMin: 2,
  neutralZoneUsd: 5,
  tickIntervalSec: 2,
};

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "btc15m-store-"));
  try {
    const filePath = join(dir, "state.json");
    const store = createBtc15mStateStore({ filePath, defaultConfig });

    // Initial load yields defaults when file missing
    const initial = await store.readState();
    assert.equal(initial.version, 1);
    assert.equal(initial.budget.initialBudget, 5);
    assert.equal(initial.budget.availableBudget, 5);
    assert.equal(initial.budget.lockedBudget, 0);
    assert.deepEqual(initial.completedTrades, []);

    // Update config persists
    await store.updateConfig({ ...defaultConfig, workingBudgetUsd: 10 });
    const reloaded = await store.readState();
    assert.equal(reloaded.config.workingBudgetUsd, 10);

    // Append completed trade
    const trade: Btc15mCompletedTrade = {
      id: "t1",
      marketSlug: "btc-updown-15m-1779220800",
      bettingSide: "down",
      buyPrice: 0.25,
      sellPrice: 0.4,
      shares: 5,
      pnlUsd: 0.75,
      result: "win",
      exitReason: "target_sell",
      startedAt: 1,
      closedAt: 2,
    };
    await store.appendCompletedTrade(trade);
    const afterTrade = await store.readState();
    assert.equal(afterTrade.completedTrades.length, 1);
    assert.equal(afterTrade.completedTrades[0].id, "t1");

    // Concurrent updates are serialized via internal queue
    await Promise.all([
      store.updateBudget((b) => {
        b.availableBudget = 9;
      }),
      store.updateBudget((b) => {
        b.lockedBudget = 1;
      }),
    ]);
    const afterConcurrent = await store.readState();
    assert.equal(afterConcurrent.budget.availableBudget, 9);
    assert.equal(afterConcurrent.budget.lockedBudget, 1);

    console.log("state-store: OK");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `cd backend && npx tsx src/btc15m/__tests__/state-store.isolated.test.ts`
Expected: FAIL — `Cannot find module '../state-store.js'`.

- [ ] **Step 3: Write the minimal implementation.**

Create `backend/src/btc15m/state-store.ts` modeled on `scalper/state-store.ts`. Required public surface (must satisfy the test):

```ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  Btc15mBotConfig,
  Btc15mCompletedTrade,
  Btc15mPersistentState,
  Btc15mStateStoreOptions,
} from "./types.js";

const PROJECT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export class Btc15mStateStore {
  private readonly filePath: string;
  private readonly defaultConfig: Btc15mBotConfig;
  private updateQueue: Promise<void> = Promise.resolve();

  constructor(options: Btc15mStateStoreOptions) {
    this.filePath = isAbsolute(options.filePath)
      ? options.filePath
      : resolve(PROJECT_ROOT, options.filePath);
    this.defaultConfig = options.defaultConfig;
  }

  async readState(): Promise<Btc15mPersistentState> {
    return this.loadState();
  }

  async updateConfig(config: Btc15mBotConfig): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.loadState();
      state.config = config;
      state.updatedAt = Date.now();
      await this.persistState(state);
    });
  }

  async updateBudget(
    updater: (budget: Btc15mPersistentState["budget"]) => void | Promise<void>,
  ): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.loadState();
      await updater(state.budget);
      state.budget.updatedAt = Date.now();
      state.updatedAt = state.budget.updatedAt;
      await this.persistState(state);
    });
  }

  async appendCompletedTrade(trade: Btc15mCompletedTrade): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.loadState();
      state.completedTrades = [...state.completedTrades, trade].slice(-500);
      state.updatedAt = Date.now();
      await this.persistState(state);
    });
  }

  private async loadState(): Promise<Btc15mPersistentState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return this.normalize(JSON.parse(raw) as Partial<Btc15mPersistentState>);
    } catch (error) {
      if (isMissingFileError(error)) {
        return this.createDefaultState();
      }
      throw error;
    }
  }

  private async persistState(state: Btc15mPersistentState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.updateQueue.then(operation);
    this.updateQueue = next.catch(() => undefined);
    return next;
  }

  private normalize(input: Partial<Btc15mPersistentState>): Btc15mPersistentState {
    const fallback = this.createDefaultState();
    return {
      version: 1,
      updatedAt: typeof input.updatedAt === "number" ? input.updatedAt : fallback.updatedAt,
      config: input.config ?? fallback.config,
      completedTrades: Array.isArray(input.completedTrades) ? input.completedTrades : [],
      budget: {
        initialBudget: numberOr(input.budget?.initialBudget, fallback.budget.initialBudget),
        availableBudget: numberOr(input.budget?.availableBudget, fallback.budget.availableBudget),
        lockedBudget: numberOr(input.budget?.lockedBudget, fallback.budget.lockedBudget),
        updatedAt: numberOr(input.budget?.updatedAt, fallback.budget.updatedAt),
      },
    };
  }

  private createDefaultState(): Btc15mPersistentState {
    const now = Date.now();
    return {
      version: 1,
      updatedAt: now,
      config: this.defaultConfig,
      completedTrades: [],
      budget: {
        initialBudget: this.defaultConfig.workingBudgetUsd,
        availableBudget: this.defaultConfig.workingBudgetUsd,
        lockedBudget: 0,
        updatedAt: now,
      },
    };
  }
}

export function createBtc15mStateStore(options: Btc15mStateStoreOptions): Btc15mStateStore {
  return new Btc15mStateStore(options);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT");
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `cd backend && npx tsx src/btc15m/__tests__/state-store.isolated.test.ts`
Expected: `state-store: OK` printed, exit 0.

- [ ] **Step 5: Type-check the whole backend.**

Run: `cd backend && pnpm run check`
Expected: PASS.

- [ ] **Step 6: Commit checkpoint.**

Stage `backend/src/btc15m/state-store.ts` and the test. Ask user before commit. Suggested message:
`feat(btc15m): add Btc15mStateStore with atomic persistence`

---

## Task 4: `btc15m/market-resolver.ts` — current/next 15m market + start BTC price

**Files:**
- Create: `backend/src/btc15m/market-resolver.ts`
- Create: `backend/src/btc15m/__tests__/market-resolver.isolated.test.ts`

15m markets are aligned to 15-min UTC boundaries (`unixSec % 900 === 0`). Slug = `btc-updown-15m-<unixSec>`. We use Gamma `getMarketBySlug` (already exposed in `backend/src/gamma.ts`) for market metadata, Polymarket `priceToBeat` / `crypto-price` `openPrice` for the market start price, and Polymarket RTDS `crypto_prices_chainlink` (`btc/usd`) for current live BTC ticks.

- [ ] **Step 1: Write the failing test.**

```ts
// backend/src/btc15m/__tests__/market-resolver.isolated.test.ts
import assert from "node:assert/strict";

import { currentWindowStartSec, nextWindowStartSec, slugForWindow } from "../market-resolver.js";

function main() {
  const t = Date.UTC(2026, 4, 20, 12, 7, 13); // 12:07:13 UTC
  const window = currentWindowStartSec(t);
  // 12:00:00 UTC same day in seconds
  assert.equal(window, Date.UTC(2026, 4, 20, 12, 0, 0) / 1000);
  assert.equal(window % 900, 0);

  const next = nextWindowStartSec(t);
  assert.equal(next, Date.UTC(2026, 4, 20, 12, 15, 0) / 1000);

  // Exact boundary case: 12:15:00.000 is the START of the next window
  const onBoundary = Date.UTC(2026, 4, 20, 12, 15, 0);
  assert.equal(currentWindowStartSec(onBoundary), Date.UTC(2026, 4, 20, 12, 15, 0) / 1000);

  assert.equal(slugForWindow(1779220800), "btc-updown-15m-1779220800");

  console.log("market-resolver: OK");
}

main();
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `cd backend && npx tsx src/btc15m/__tests__/market-resolver.isolated.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the minimal implementation.**

```ts
// backend/src/btc15m/market-resolver.ts
import { GammaClient } from "../gamma.js";
import type { Btc15mMarketView } from "./types.js";

const WINDOW_SEC = 900;
const SLUG_PREFIX = "btc-updown-15m-";

export function currentWindowStartSec(nowMs: number): number {
  return Math.floor(nowMs / 1000 / WINDOW_SEC) * WINDOW_SEC;
}

export function nextWindowStartSec(nowMs: number): number {
  return currentWindowStartSec(nowMs) + WINDOW_SEC;
}

export function slugForWindow(startSec: number): string {
  return `${SLUG_PREFIX}${startSec}`;
}

export interface ResolveOptions {
  gamma?: GammaClient;
  now?: () => number;
}

export async function resolveCurrentMarket(
  gammaHost: string,
  options: ResolveOptions = {},
): Promise<Btc15mMarketView | null> {
  const gamma = options.gamma ?? new GammaClient(gammaHost);
  const now = options.now?.() ?? Date.now();
  const slug = slugForWindow(currentWindowStartSec(now));
  try {
    const raw = await gamma.getMarketBySlug(slug);
    return parseMarketView(raw, slug);
  } catch {
    return null;
  }
}

function parseMarketView(raw: Record<string, unknown>, slug: string): Btc15mMarketView | null {
  const startTimeIso = typeof raw.startDate === "string" ? raw.startDate : null;
  const endTimeIso = typeof raw.endDate === "string" ? raw.endDate : null;
  const question = typeof raw.question === "string" ? raw.question : slug;
  const startTimeMs = startTimeIso ? Date.parse(startTimeIso) : Number.NaN;
  const endTimeMs = endTimeIso ? Date.parse(endTimeIso) : Number.NaN;
  if (!Number.isFinite(startTimeMs) || !Number.isFinite(endTimeMs)) {
    return null;
  }

  const tokens = parseOutcomeTokens(raw);
  if (!tokens) {
    return null;
  }

  return {
    slug,
    question,
    startTimeMs,
    endTimeMs,
    upTokenId: tokens.up,
    downTokenId: tokens.down,
  };
}

function parseOutcomeTokens(raw: Record<string, unknown>): { up: string; down: string } | null {
  const clobTokenIds = parseStringArray(raw.clobTokenIds);
  const outcomes = parseStringArray(raw.outcomes);
  if (clobTokenIds.length !== 2 || outcomes.length !== 2) {
    return null;
  }
  const upIndex = outcomes.findIndex((o) => /up|yes/i.test(o));
  const downIndex = outcomes.findIndex((o) => /down|no/i.test(o));
  if (upIndex < 0 || downIndex < 0 || upIndex === downIndex) {
    return null;
  }
  return { up: clobTokenIds[upIndex], down: clobTokenIds[downIndex] };
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `cd backend && npx tsx src/btc15m/__tests__/market-resolver.isolated.test.ts`
Expected: `market-resolver: OK`.

- [ ] **Step 5: Type-check.**

Run: `cd backend && pnpm run check`
Expected: PASS. If Gamma `getMarketBySlug` returns a typed shape that breaks `parseStringArray`, narrow with `Record<string, unknown>` cast at the call site.

- [ ] **Step 6: Commit checkpoint.**

Stage both files. Ask user before commit. Suggested message:
`feat(btc15m): add 15m market resolver with deterministic boundary slug`

---

## Task 5: `btc15m/strategy.ts` — `Btc15mBot` scaffold (start/stop/getStatus/tick loop)

**Files:**
- Create: `backend/src/btc15m/strategy.ts`
- Create: `backend/src/btc15m/__tests__/strategy.isolated.test.ts`

This task ONLY wires up the class skeleton with dependency injection (so it's testable without network) plus start/stop/getStatus and an idle tick loop. Cycle logic comes in Tasks 6–9.

- [ ] **Step 1: Write the failing test.**

```ts
// backend/src/btc15m/__tests__/strategy.isolated.test.ts
import assert from "node:assert/strict";

import { Btc15mBot } from "../strategy.js";
import type { Btc15mBotConfig, Btc15mMarketView } from "../types.js";

const config: Btc15mBotConfig = {
  workingBudgetUsd: 5,
  shares: 5,
  buyPrice: 0.25,
  sellPrice: 0.4,
  repeatThresholdMin: 6,
  forceSellThresholdMin: 2,
  neutralZoneUsd: 5,
  tickIntervalSec: 2,
};

async function startStopTest() {
  let ticked = 0;
  const market: Btc15mMarketView = {
    slug: "btc-updown-15m-1779220800",
    question: "BTC up/down 15m",
    startTimeMs: 1_779_220_800_000,
    endTimeMs: 1_779_221_700_000,
    upTokenId: "tok-up",
    downTokenId: "tok-down",
  };

  const bot = new Btc15mBot({
    config,
    dryRun: true,
    runtime: {
      now: () => 1_779_220_800_000,
      resolveMarket: async () => market,
      fetchBtcPrice: async () => 100_000,
      placeLimitOrder: async () => ({ orderID: "stub" }),
      cancelOrder: async () => undefined,
      onMarketBookSubscribe: () => undefined,
      onMarketBookUnsubscribe: () => undefined,
      startUserWs: async () => undefined,
      stopUserWs: () => undefined,
      budget: {
        async reserve() { return; },
        async release() { return; },
        async consume() { return; },
        async addFunds() { return; },
        async snapshot() {
          return {
            initialBudget: 5,
            availableBudget: 5,
            lockedBudget: 0,
            equity: 5,
            updatedAt: 0,
            balanceCheck: null,
          };
        },
      },
      persistTrade: async () => undefined,
      persistConfig: async () => undefined,
      tick: () => {
        ticked++;
      },
    },
  });

  const initial = bot.getStatus();
  assert.equal(initial.enginePhase, "stopped");

  await bot.start();
  assert.equal(bot.getStatus().enginePhase, "running");

  bot.stop();
  assert.equal(bot.getStatus().enginePhase, "stopped");
  assert.ok(ticked >= 1, "tick should have been called at least once after start");

  console.log("strategy scaffold: OK");
}

void startStopTest().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `cd backend && npx tsx src/btc15m/__tests__/strategy.isolated.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the minimal implementation.**

```ts
// backend/src/btc15m/strategy.ts
import type { BudgetSnapshot } from "../scalper/types.js";

import type {
  Btc15mAnalyticsSummary,
  Btc15mBotConfig,
  Btc15mBotStatus,
  Btc15mCompletedTrade,
  Btc15mCycleState,
  Btc15mLogEntry,
  Btc15mMarketView,
} from "./types.js";

export interface Btc15mBudgetPort {
  reserve(amount: number, reason?: string): Promise<void>;
  release(amount: number, reason?: string): Promise<void>;
  consume(amount: number, reason?: string): Promise<void>;
  addFunds(amount: number, reason?: string): Promise<void>;
  snapshot(): Promise<BudgetSnapshot>;
}

export interface PlaceOrderArgs {
  tokenId: string;
  side: "buy" | "sell";
  price: number;
  size: number;
}

export interface Btc15mRuntime {
  now: () => number;
  resolveMarket: () => Promise<Btc15mMarketView | null>;
  fetchBtcPrice: (atMs: number) => Promise<number | null>;
  placeLimitOrder: (args: PlaceOrderArgs) => Promise<unknown>;
  cancelOrder: (orderId: string) => Promise<unknown>;
  onMarketBookSubscribe: (tokenId: string, listener: (bestBid: number | null, bestAsk: number | null) => void) => void;
  onMarketBookUnsubscribe: (tokenId: string) => void;
  startUserWs: (handler: (msg: import("../scalper-user-ws.js").ScalperUserWsMessage) => void) => Promise<void>;
  stopUserWs: () => void;
  budget: Btc15mBudgetPort;
  persistTrade: (trade: Btc15mCompletedTrade) => Promise<void>;
  persistConfig: (config: Btc15mBotConfig) => Promise<void>;
  // Test seam — replaces setInterval when present
  tick?: () => void;
}

export interface Btc15mBotOptions {
  config: Btc15mBotConfig;
  dryRun: boolean;
  runtime: Btc15mRuntime;
  initialTrades?: Btc15mCompletedTrade[];
}

const MAX_LOG_ENTRIES = 60;

export class Btc15mBot {
  private readonly runtime: Btc15mRuntime;
  private readonly config: Btc15mBotConfig;
  private readonly dryRun: boolean;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickInProgress = false;
  private state: Btc15mBotStatus;

  constructor(options: Btc15mBotOptions) {
    this.runtime = options.runtime;
    this.config = options.config;
    this.dryRun = options.dryRun;
    this.state = this.buildIdleStatus(options.initialTrades ?? []);
  }

  getStatus(): Btc15mBotStatus {
    return cloneStatus(this.state);
  }

  async start(): Promise<void> {
    if (this.state.enginePhase === "running") {
      return;
    }
    this.state.enginePhase = "running";
    this.state.lastError = null;
    this.pushLog("BTC 15m bot started.", "success");
    if (!this.dryRun) {
      await this.runtime.startUserWs((msg) => this.handleUserWsMessage(msg));
    }
    await this.runtime.persistConfig(this.config);
    await this.runOneTick();
    if (this.runtime.tick) {
      // test seam — synchronously poke it once more
      this.runtime.tick();
    } else {
      this.tickTimer = setInterval(() => {
        void this.runOneTick();
      }, Math.max(500, this.config.tickIntervalSec * 1000));
    }
    this.touch();
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (!this.dryRun) {
      this.runtime.stopUserWs();
    }
    this.state.enginePhase = "stopped";
    this.pushLog("BTC 15m bot stopped.", "info");
    this.touch();
  }

  async runOneTick(): Promise<void> {
    if (this.tickInProgress) {
      return;
    }
    this.tickInProgress = true;
    try {
      // Cycle logic implemented in subsequent tasks.
      const snapshot = await this.runtime.budget.snapshot();
      this.state.budget = snapshot;
      this.state.analytics = computeAnalytics(this.state.completedTrades, snapshot);
      this.touch();
    } catch (error) {
      this.fail(error, "tick failed");
    } finally {
      this.tickInProgress = false;
    }
  }

  // --- helpers ---

  private buildIdleStatus(trades: Btc15mCompletedTrade[]): Btc15mBotStatus {
    return {
      enginePhase: "stopped",
      dryRun: this.dryRun,
      config: this.config,
      market: null,
      marketStartBtcPrice: null,
      currentBtcPrice: null,
      cycle: emptyCycle(),
      completedTrades: trades,
      analytics: computeAnalytics(trades, null),
      budget: null,
      logs: [],
      updatedAt: this.runtime.now(),
      lastError: null,
    };
  }

  private pushLog(message: string, type: Btc15mLogEntry["type"]): void {
    const entry: Btc15mLogEntry = {
      timestamp: this.runtime.now(),
      message,
      type,
    };
    this.state.logs = [entry, ...this.state.logs].slice(0, MAX_LOG_ENTRIES);
  }

  private fail(error: unknown, prefix: string): void {
    const message = error instanceof Error ? error.message : String(error);
    this.state.lastError = `${prefix}: ${message}`;
    this.pushLog(this.state.lastError, "error");
  }

  private touch(): void {
    this.state.updatedAt = this.runtime.now();
  }

  // Stubbed in Task 7+ — placeholder lives here so the field exists.
  private handleUserWsMessage(_msg: import("../scalper-user-ws.js").ScalperUserWsMessage): void {
    // intentionally empty until Task 7
  }
}

function emptyCycle(): Btc15mCycleState {
  return {
    cyclePhase: "waiting_market",
    cycleStartedAt: null,
    buyOrder: null,
    sellOrder: null,
    position: null,
  };
}

function computeAnalytics(
  trades: Btc15mCompletedTrade[],
  budget: BudgetSnapshot | null,
): Btc15mAnalyticsSummary {
  const wins = trades.filter((t) => t.result === "win").length;
  const losses = trades.length - wins;
  const totalPnlUsd = trades.reduce((sum, t) => sum + t.pnlUsd, 0);
  return {
    totalTrades: trades.length,
    wins,
    losses,
    winRate: trades.length > 0 ? wins / trades.length : 0,
    totalPnlUsd,
    remainingBudgetUsd: budget?.availableBudget ?? 0,
  };
}

function cloneStatus(status: Btc15mBotStatus): Btc15mBotStatus {
  return JSON.parse(JSON.stringify(status)) as Btc15mBotStatus;
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `cd backend && npx tsx src/btc15m/__tests__/strategy.isolated.test.ts`
Expected: `strategy scaffold: OK`.

- [ ] **Step 5: Type-check.**

Run: `cd backend && pnpm run check`
Expected: PASS.

- [ ] **Step 6: Commit checkpoint.**

Stage strategy.ts and the test. Ask user before commit. Suggested message:
`feat(btc15m): scaffold Btc15mBot with DI runtime and tick loop`

---

## Task 6: Cycle — `WAITING_DIRECTION` → `BUY_PENDING`

Determine the cheap side from BTC vs start, respect the neutral zone, reserve budget, and place the limit buy.

**Files:**
- Modify: `backend/src/btc15m/strategy.ts`
- Modify: `backend/src/btc15m/__tests__/strategy.isolated.test.ts` (append)

- [ ] **Step 1: Extend the test to drive the transition.**

Append to `strategy.isolated.test.ts` (after the existing test, before the final catch):

```ts
async function placesBuyOnDownWhenBtcAboveStart() {
  const market: Btc15mMarketView = {
    slug: "btc-updown-15m-1779220800",
    question: "BTC up/down 15m",
    startTimeMs: 1_779_220_800_000,
    endTimeMs: 1_779_221_700_000,
    upTokenId: "tok-up",
    downTokenId: "tok-down",
  };
  let currentBtc = 100_000;
  const orders: PlaceOrderArgs[] = [];
  let reserved = 0;

  const bot = new Btc15mBot({
    config,
    dryRun: true,
    runtime: {
      now: () => 1_779_220_860_000, // 60s into the window
      resolveMarket: async () => market,
      fetchBtcPrice: async () => currentBtc,
      placeLimitOrder: async (args) => {
        orders.push(args);
        return { orderID: "stub-" + orders.length };
      },
      cancelOrder: async () => undefined,
      onMarketBookSubscribe: () => undefined,
      onMarketBookUnsubscribe: () => undefined,
      startUserWs: async () => undefined,
      stopUserWs: () => undefined,
      budget: {
        async reserve(amount) { reserved += amount; },
        async release() { return; },
        async consume() { return; },
        async addFunds() { return; },
        async snapshot() {
          return {
            initialBudget: 5,
            availableBudget: 5 - reserved,
            lockedBudget: reserved,
            equity: 5,
            updatedAt: 0,
            balanceCheck: null,
          };
        },
      },
      persistTrade: async () => undefined,
      persistConfig: async () => undefined,
    },
  });

  // Freeze the start price for the bot by calling start at currentBtc=100000
  await bot.start();

  // Move BTC clearly above start + neutral zone
  currentBtc = 100_100;
  await bot.runOneTick();

  assert.equal(orders.length, 1);
  assert.equal(orders[0].tokenId, "tok-down");
  assert.equal(orders[0].side, "buy");
  assert.equal(orders[0].price, 0.25);
  assert.equal(orders[0].size, 5);
  assert.equal(reserved, 5 * 0.25);

  bot.stop();
  console.log("placeBuy on DOWN: OK");
}

// In a Test 3 below, verify neutral-zone keeps order off:
async function noOrderInsideNeutralZone() {
  const market: Btc15mMarketView = {
    slug: "btc-updown-15m-1779220800",
    question: "BTC up/down 15m",
    startTimeMs: 1_779_220_800_000,
    endTimeMs: 1_779_221_700_000,
    upTokenId: "tok-up",
    downTokenId: "tok-down",
  };
  const orders: PlaceOrderArgs[] = [];
  const bot = new Btc15mBot({
    config,
    dryRun: true,
    runtime: {
      now: () => 1_779_220_860_000,
      resolveMarket: async () => market,
      fetchBtcPrice: async () => 100_002, // inside +/- 5 USD neutral zone
      placeLimitOrder: async (args) => { orders.push(args); return { orderID: "x" }; },
      cancelOrder: async () => undefined,
      onMarketBookSubscribe: () => undefined,
      onMarketBookUnsubscribe: () => undefined,
      startUserWs: async () => undefined,
      stopUserWs: () => undefined,
      budget: {
        async reserve() { return; },
        async release() { return; },
        async consume() { return; },
        async addFunds() { return; },
        async snapshot() {
          return { initialBudget: 5, availableBudget: 5, lockedBudget: 0, equity: 5, updatedAt: 0, balanceCheck: null };
        },
      },
      persistTrade: async () => undefined,
      persistConfig: async () => undefined,
    },
  });
  await bot.start();
  assert.equal(orders.length, 0);
  bot.stop();
  console.log("neutral zone: OK");
}
```

Then add `await placesBuyOnDownWhenBtcAboveStart();` and `await noOrderInsideNeutralZone();` calls into a top-level driver. Update the existing `main`-style block to invoke all tests in sequence and import `PlaceOrderArgs` from `../strategy.js`.

- [ ] **Step 2: Run the test to verify it fails.**

Run: `cd backend && npx tsx src/btc15m/__tests__/strategy.isolated.test.ts`
Expected: FAIL — no buy order placed yet.

- [ ] **Step 3: Implement the transition.**

In `strategy.ts`, freeze the start price during `start()` (after `resolveMarket`) and implement direction selection inside `runOneTick`. Key behavior:

- After resolving the market on first tick (and after `start()` once), call `fetchMarketStartPrice(market)` and store the Polymarket `priceToBeat` / `openPrice` as `state.marketStartBtcPrice`.
- Each tick: refresh `currentBtcPrice = await fetchBtcPrice(now)`.
- If `cycle.cyclePhase === "waiting_market"` and `market` exists → set `cycle.cyclePhase = "waiting_direction"`.
- If `cycle.cyclePhase === "waiting_direction"` and `marketStartBtcPrice != null` and `currentBtcPrice != null`:
  - delta = `currentBtcPrice - marketStartBtcPrice`
  - if `Math.abs(delta) <= neutralZoneUsd` → skip placing
  - else: side = `delta > 0 ? "down" : "up"`
  - tokenId = side === "down" ? market.downTokenId : market.upTokenId
  - stake = `config.shares * config.buyPrice`
  - call `await runtime.budget.reserve(stake, "cycle-buy")`; if it throws → log "budget exhausted", `state.enginePhase = "auto_stopped"`, stop loop, return
  - call `runtime.placeLimitOrder({ tokenId, side: "buy", price: config.buyPrice, size: config.shares })`
  - extract orderId via helper (port the `extractOrderId` helper from `btc5m-bot.ts`)
  - populate `cycle.buyOrder = { id, orderId, side: "buy", tokenId, bettingSide: side, price, size, filledSize: 0, status: orderId ? "open" : "submitting", reservedBudget: stake, createdAt: now, updatedAt: now }`
  - set `cycle.cyclePhase = "buy_pending"` and `cycle.cycleStartedAt = now`
  - push log

- [ ] **Step 4: Run the test to verify it passes.**

Run: `cd backend && npx tsx src/btc15m/__tests__/strategy.isolated.test.ts`
Expected: `placeBuy on DOWN: OK` and `neutral zone: OK`.

- [ ] **Step 5: Type-check.**

Run: `cd backend && pnpm run check`
Expected: PASS.

- [ ] **Step 6: Commit checkpoint.**

Ask user before commit. Suggested message:
`feat(btc15m): place limit buy on cheap side with neutral-zone gate and budget reservation`

---

## Task 7: Cycle — `BUY_PENDING` fill detection and cancellation rules

Add: (a) SIM fill via book subscription, (b) LIVE fill via user-WS, (c) cancel buy when BTC re-enters neutral zone or side flips, (d) cancel buy when `<forceSellMin` and nothing held.

**Files:**
- Modify: `backend/src/btc15m/strategy.ts`
- Modify: `backend/src/btc15m/__tests__/strategy.isolated.test.ts` (append)

- [ ] **Step 1: Append the failing tests.**

Three tests:
1. `simFillsBuyWhenAskCrossesPrice` — in `dryRun=true`, set up `onMarketBookSubscribe` to immediately invoke its listener with `bestAsk = 0.24`; assert that `cycle.cyclePhase` transitions to `holding` and a sell order is placed.
2. `cancelsBuyOnReturnToNeutralZone` — after placing buy with BTC=100100, on next tick set `currentBtc=100002` and assert `runtime.cancelOrder` was called once and `cycle.cyclePhase === "waiting_direction"` and budget was released.
3. `cancelsBuyAtLateMarketWithNothingHeld` — set `now` to `endTime - 60_000` (60s before end, less than `forceSellMin*60_000=120_000`); assert cancel and `cycle.cyclePhase === "market_idle"`.

Wire each test with the same DI scaffolding pattern as Task 6.

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `cd backend && npx tsx src/btc15m/__tests__/strategy.isolated.test.ts`
Expected: FAIL on the three new assertions.

- [ ] **Step 3: Implement.**

In `runOneTick` while `cycle.cyclePhase === "buy_pending"`:

1. **Time-to-end check.** Compute `timeToEndMs = market.endTimeMs - now`. If `timeToEndMs < forceSellMin * 60_000` and `cycle.position === null` → cancel the buy and `cycle.cyclePhase = "market_idle"`. Helper `cancelBuy(reason)` calls `runtime.cancelOrder(buyOrder.orderId)` if `orderId`, then `await runtime.budget.release(buyOrder.reservedBudget, reason)` and clears `cycle.buyOrder`. Wrap cancel in try/catch (ignore failures).
2. **Neutral-zone / flip check.** Recompute delta = `currentBtc - marketStartBtcPrice`. If `Math.abs(delta) <= neutralZoneUsd` OR `sign(delta) !== bettingSide` (where `bettingSide` maps `"down" → +1`, `"up" → -1` for comparison purposes) → cancel buy, set `cycle.cyclePhase = "waiting_direction"`.
3. **SIM book-aware fill.** On first entry to `buy_pending` while `dryRun=true`, subscribe to the buy's token book: `runtime.onMarketBookSubscribe(tokenId, listener)` where listener fires when bestAsk changes; in the listener, if `bestAsk != null && bestAsk <= buyOrder.price` and order still pending → mark filled, place sell (Task 8 implements `transitionBuyFilledToHolding`). Implementation note: keep a Map `bookListenerByToken` so unsubscribing in stop/cancel works.
4. **LIVE fill** via `handleUserWsMessage`: implement the body (mirrors `btc5m-bot.ts:197-249`) — if `msg.orderId === buyOrder.orderId` (or `assetIds` includes buy token) and `isFilledStatus(msg.status)` → call `transitionBuyFilledToHolding(actualSize)` where actualSize comes from `msg.raw` if present else `cycle.buyOrder.size`.

Port the helpers `isFilledStatus`, `isFailureStatus`, `extractOrderId` from `btc5m-bot.ts`.

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `cd backend && npx tsx src/btc15m/__tests__/strategy.isolated.test.ts`
Expected: all named test prints with `OK`.

- [ ] **Step 5: Type-check.**

Run: `cd backend && pnpm run check`
Expected: PASS.

- [ ] **Step 6: Commit checkpoint.**

Ask user. Suggested message:
`feat(btc15m): detect buy fills (sim+live) and cancel stale buy orders`

---

## Task 8: Cycle — `HOLDING`, `FORCE_SELLING`, completed trade row

**Files:**
- Modify: `backend/src/btc15m/strategy.ts`
- Modify: `backend/src/btc15m/__tests__/strategy.isolated.test.ts` (append)

- [ ] **Step 1: Append the failing tests.**

Three tests:
1. `placesSellAtTargetAfterBuyFill` — drive a buy fill, then verify a sell order was placed at `sellPrice=0.4` for `5` shares on the same token.
2. `targetSellFillCompletesTradeAsWin` — drive a sell fill (set `bestBid=0.41`), then assert a `Btc15mCompletedTrade` is appended via `runtime.persistTrade` with `result="win"`, `pnlUsd ≈ (0.4 - 0.25) * 5 = 0.75`, `exitReason="target_sell"`, and `cycle.cyclePhase === "cycle_done"`. Also assert `runtime.budget.addFunds` was called with `0.4 * 5 = 2.0`.
3. `forceSellsAtBestBidWhenLate` — with held position and `now` such that `timeToEnd < forceSellMin*60_000`, simulate `bestBid = 0.30`; assert the previous sell is cancelled, a new sell at `0.30` is placed; on its fill, trade row has `exitReason="force_sell"` and `result="loss"` (because 0.30 < 0.25 cost-only-no — actually 0.30 > 0.25 so still a win; pick a `bestBid` that makes the result deterministic for the assertion, e.g. `0.20` for loss).

- [ ] **Step 2: Run tests to verify they fail.**

Run: `cd backend && npx tsx src/btc15m/__tests__/strategy.isolated.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

Add `transitionBuyFilledToHolding(filledSize)`:
- Compute actual `filledSize` (clamp ≤ `buyOrder.size`).
- `cycle.position = { bettingSide, tokenId, shares: filledSize, avgEntryPrice: buyOrder.price, costBasisUsd: filledSize * buyOrder.price }`.
- `await runtime.budget.consume(filledSize * buyOrder.price, "buy-filled")`. If filledSize < buyOrder.size also `release(remaining*price, "partial-unfilled")`.
- `cycle.buyOrder = null`. Unsubscribe book listener for the buy token.
- Call `placeTargetSell()`.

Add `placeTargetSell()`:
- `runtime.placeLimitOrder({ tokenId: position.tokenId, side: "sell", price: config.sellPrice, size: position.shares })`.
- Populate `cycle.sellOrder` similarly to buyOrder (no budget reservation needed for sells).
- `cycle.cyclePhase = "holding"`. Subscribe to that token's book for SIM sell-fill detection (sell fills when `bestBid >= sellPrice`).
- Wire `handleUserWsMessage` to detect sell fill (mirrors btc5m-bot: `msg.orderId === sellOrder.orderId`).

Add `handleSellFill(actualSellPrice, exitReason)`:
- Compute `pnlUsd = (actualSellPrice - position.avgEntryPrice) * position.shares`.
- `result = pnlUsd > 0 ? "win" : "loss"` (treat `0` as `loss` to match user wording).
- Build a `Btc15mCompletedTrade`, push into `state.completedTrades`, call `runtime.persistTrade(trade)`.
- `await runtime.budget.addFunds(actualSellPrice * position.shares, "sell-filled")`.
- `cycle.sellOrder = null`, `cycle.position = null`, `cycle.cyclePhase = "cycle_done"`. Unsubscribe sell-token book listener.

Add late-market force-sell check inside `runOneTick` while `cycle.cyclePhase === "holding"`:
- If `timeToEndMs < forceSellMin * 60_000` and sell is unfilled → try-cancel `sellOrder.orderId`, then place a new sell at the current `bestBid` for position size; set `cycle.cyclePhase = "force_selling"`. Track this order in `cycle.sellOrder`. Need a way to read current bestBid: store latest book snapshot per token in a Map populated by the book listener.

Force-sell fill path: in `handleSellFill`, pass `exitReason = cycle.cyclePhase === "force_selling" ? "force_sell" : "target_sell"`.

- [ ] **Step 4: Run tests to verify they pass.**

Run: `cd backend && npx tsx src/btc15m/__tests__/strategy.isolated.test.ts`
Expected: all OK.

- [ ] **Step 5: Type-check.**

Run: `cd backend && pnpm run check`
Expected: PASS.

- [ ] **Step 6: Commit checkpoint.**

Ask user. Suggested message:
`feat(btc15m): hold/sell/force-sell with completed-trade accounting and budget settlement`

---

## Task 9: Repeat decision, market switching, budget-exhaustion auto-stop

**Files:**
- Modify: `backend/src/btc15m/strategy.ts`
- Modify: `backend/src/btc15m/__tests__/strategy.isolated.test.ts` (append)

- [ ] **Step 1: Append the failing tests.**

1. `repeatsCycleWhenEnoughTimeLeft` — after `cycle_done` with `timeToEndMs > repeatMin*60_000`, next tick transitions back to `waiting_direction`.
2. `idlesAfterCycleDoneWhenLittleTimeLeft` — after `cycle_done` with `timeToEndMs ≤ repeatMin*60_000`, next tick sets `cycle.cyclePhase = "market_idle"`.
3. `switchesToNextMarketAtBoundary` — set `now > market.endTimeMs`; `resolveMarket` returns a NEW market view with different `startTimeMs`; assert state freezes new `marketStartBtcPrice`, resets cycle, and old completed trades remain.
4. `autoStopsWhenBudgetReserveThrows` — `runtime.budget.reserve` throws `Insufficient available budget`; assert `enginePhase === "auto_stopped"` and tick loop stops.

- [ ] **Step 2: Run tests to verify they fail.**

Run: `cd backend && npx tsx src/btc15m/__tests__/strategy.isolated.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

In `runOneTick`:

- After a fresh `await runtime.resolveMarket()`, if returned market's `slug !== state.market?.slug`:
  - Cancel any pending buy or sell from the previous market (best-effort).
  - Release any reservations.
  - Reset `cycle = emptyCycle()`, `state.market = newMarket`, `state.marketStartBtcPrice = await runtime.fetchMarketStartPrice(newMarket)`.
  - Log "Switched to market <slug>".

- After every cycle transition, if `cycle.cyclePhase === "cycle_done"`:
  - `timeToEndMs = market.endTimeMs - now`
  - If `timeToEndMs > config.repeatThresholdMin * 60_000` → `cycle = emptyCycle()`, then re-enter `waiting_direction` (set `cycle.cyclePhase = "waiting_direction"`).
  - Else → `cycle.cyclePhase = "market_idle"`.

- Wrap the `await runtime.budget.reserve(stake, ...)` call in Task 6 with try/catch. On error message containing "Insufficient" → set `state.enginePhase = "auto_stopped"`, push log `"Budget exhausted. Stopping."`, call `stop()`.

- [ ] **Step 4: Run tests to verify they pass.**

Run: `cd backend && npx tsx src/btc15m/__tests__/strategy.isolated.test.ts`
Expected: all OK.

- [ ] **Step 5: Type-check.**

Run: `cd backend && pnpm run check`
Expected: PASS.

- [ ] **Step 6: Commit checkpoint.**

Ask user. Suggested message:
`feat(btc15m): repeat cycles, switch markets at boundary, auto-stop on budget exhaustion`

---

## Task 10: `btc15m/index.ts` — factory + singleton wrappers

**Files:**
- Create: `backend/src/btc15m/index.ts`

Mirrors `backend/src/btc5m-bot.ts` lines 27–62 and `scalper/index.ts` factory pattern.

- [ ] **Step 1: Write the file.**

```ts
// backend/src/btc15m/index.ts
import { GammaClient } from "../gamma.js";
import { PolymarketService } from "../polymarket-service.js";
import { ScalperUserWs } from "../scalper-user-ws.js";
import { createBudgetManager } from "../scalper/budget-manager.js";
import { loadSettings, type Settings } from "../config.js";

import { Btc15mBot, type Btc15mRuntime } from "./strategy.js";
import { resolveCurrentMarket } from "./market-resolver.js";
import { createBtc15mStateStore } from "./state-store.js";
import type {
  Btc15mBotConfig,
  Btc15mBotStatus,
  Btc15mCompletedTrade,
} from "./types.js";

export type {
  Btc15mBotConfig,
  Btc15mBotStatus,
  Btc15mCompletedTrade,
} from "./types.js";

let activeBot: Btc15mBot | null = null;

export interface StartBtc15mBotOptions {
  configOverrides?: Partial<Btc15mBotConfig>;
}

export async function startBtc15mBot(
  settings: Settings,
  options: StartBtc15mBotOptions = {},
): Promise<Btc15mBotStatus> {
  if (activeBot) {
    return activeBot.getStatus();
  }

  const baseConfig = configFromSettings(settings);
  const config: Btc15mBotConfig = { ...baseConfig, ...options.configOverrides };

  const store = createBtc15mStateStore({
    filePath: settings.btc15m.stateFile,
    defaultConfig: baseConfig,
  });
  await store.updateConfig(config);
  const persisted = await store.readState();

  const service = PolymarketService.getInstance(settings);
  await service.initialize();
  const budgetStore = adaptBudgetStore(store, settings.btc15m.workingBudgetUsd);
  const budgetManager = createBudgetManager({
    store: budgetStore,
    maxBotBudget: config.workingBudgetUsd,
    balanceProvider: service,
  });
  await budgetManager.initialize();

  let userWsInstance: ScalperUserWs | null = null;
  const runtime: Btc15mRuntime = {
    now: () => Date.now(),
    resolveMarket: () => resolveCurrentMarket(settings.gammaHost),
    fetchBtcPrice: (atMs) => priceSource.getPrice(atMs),
    fetchMarketStartPrice: (market) => cryptoPriceClient.getBtc15mPriceToBeat(market),
    placeLimitOrder: (args) => service.placeLimitOrder({ ...args, tickSize: "0.01" }),
    cancelOrder: (orderId) => service.cancelOrder(orderId),
    onMarketBookSubscribe: makeBookSubscriber(),
    onMarketBookUnsubscribe: makeBookUnsubscriber(),
    startUserWs: async (handler) => {
      userWsInstance = new ScalperUserWs(handler);
      await userWsInstance.start();
    },
    stopUserWs: () => {
      userWsInstance?.stop();
      userWsInstance = null;
    },
    budget: {
      reserve: (amount, reason) => budgetManager.reserve(amount, reason).then(() => undefined),
      release: (amount, reason) => budgetManager.release(amount, reason).then(() => undefined),
      consume: (amount, reason) => budgetManager.consume(amount, reason).then(() => undefined),
      addFunds: (amount, reason) => budgetManager.addFunds(amount, reason).then(() => undefined),
      snapshot: () => budgetManager.getSnapshot(),
    },
    persistTrade: (trade) => store.appendCompletedTrade(trade),
    persistConfig: (cfg) => store.updateConfig(cfg),
  };

  const bot = new Btc15mBot({
    config,
    dryRun: settings.dryRun,
    runtime,
    initialTrades: persisted.completedTrades,
  });
  await bot.start();
  activeBot = bot;
  return bot.getStatus();
}

export function stopBtc15mBot(): Btc15mBotStatus | null {
  if (!activeBot) return null;
  activeBot.stop();
  const status = activeBot.getStatus();
  activeBot = null;
  return status;
}

export async function getBtc15mBotStatus(settings: Settings): Promise<Btc15mBotStatus> {
  if (activeBot) {
    return activeBot.getStatus();
  }
  const store = createBtc15mStateStore({
    filePath: settings.btc15m.stateFile,
    defaultConfig: configFromSettings(settings),
  });
  const persisted = await store.readState();
  return idleStatus(settings, persisted.config, persisted.completedTrades, persisted.budget);
}

function configFromSettings(settings: Settings): Btc15mBotConfig {
  return {
    workingBudgetUsd: settings.btc15m.workingBudgetUsd,
    shares: settings.btc15m.orderSize,
    buyPrice: settings.btc15m.buyPriceLimit,
    sellPrice: settings.btc15m.sellPriceLimit,
    repeatThresholdMin: settings.btc15m.repeatThresholdMin,
    forceSellThresholdMin: settings.btc15m.forceSellThresholdMin,
    neutralZoneUsd: settings.btc15m.neutralZoneUsd,
    tickIntervalSec: settings.btc15m.tickIntervalSec,
  };
}

function idleStatus(
  settings: Settings,
  config: Btc15mBotConfig,
  trades: Btc15mCompletedTrade[],
  budget: { initialBudget: number; availableBudget: number; lockedBudget: number; updatedAt: number },
): Btc15mBotStatus {
  const wins = trades.filter((t) => t.result === "win").length;
  return {
    enginePhase: "stopped",
    dryRun: settings.dryRun,
    config,
    market: null,
    marketStartBtcPrice: null,
    currentBtcPrice: null,
    cycle: {
      cyclePhase: "waiting_market",
      cycleStartedAt: null,
      buyOrder: null,
      sellOrder: null,
      position: null,
    },
    completedTrades: trades,
    analytics: {
      totalTrades: trades.length,
      wins,
      losses: trades.length - wins,
      winRate: trades.length > 0 ? wins / trades.length : 0,
      totalPnlUsd: trades.reduce((s, t) => s + t.pnlUsd, 0),
      remainingBudgetUsd: budget.availableBudget,
    },
    budget: {
      initialBudget: budget.initialBudget,
      availableBudget: budget.availableBudget,
      lockedBudget: budget.lockedBudget,
      equity: budget.availableBudget + budget.lockedBudget,
      updatedAt: budget.updatedAt,
      balanceCheck: null,
    },
    logs: [],
    updatedAt: Date.now(),
    lastError: null,
  };
}

function adaptBudgetStore(store: ReturnType<typeof createBtc15mStateStore>, _max: number) {
  // BudgetManager expects a store with getBudgetSnapshot / initializeBudget /
  // updateBudget / setBalanceCheck. We adapt our Btc15mStateStore.
  return {
    async getBudgetSnapshot() {
      const s = await store.readState();
      return {
        initialBudget: s.budget.initialBudget,
        availableBudget: s.budget.availableBudget,
        lockedBudget: s.budget.lockedBudget,
        equity: s.budget.availableBudget + s.budget.lockedBudget,
        updatedAt: s.budget.updatedAt,
        balanceCheck: null,
      };
    },
    async initializeBudget(initial: number) {
      await store.updateBudget((b) => {
        if (b.initialBudget <= 0) {
          b.initialBudget = initial;
          b.availableBudget = initial;
          b.lockedBudget = 0;
        }
      });
      return this.getBudgetSnapshot();
    },
    async updateBudget(updater: (b: { availableBudget: number; lockedBudget: number; initialBudget: number; updatedAt: number }) => void | Promise<void>) {
      await store.updateBudget(updater as any);
      return this.getBudgetSnapshot();
    },
    async setBalanceCheck() {
      return this.getBudgetSnapshot();
    },
  };
}

// Market-book subscription is wired against the existing PolymarketMarketWs.
// Real wiring lives in app.ts (it manages a shared instance). For now the
// runtime exposes registration; app.ts implements the actual subscribe.
function makeBookSubscriber(): Btc15mRuntime["onMarketBookSubscribe"] {
  return (tokenId, listener) => {
    void tokenId;
    void listener;
    // Implemented in Task 11 if needed via a shared registry in app.ts.
  };
}

function makeBookUnsubscriber(): Btc15mRuntime["onMarketBookUnsubscribe"] {
  return (tokenId) => {
    void tokenId;
  };
}
```

- [ ] **Step 2: Type-check.**

Run: `cd backend && pnpm run check`
Expected: PASS. If `PolymarketService.placeLimitOrder` signature differs, adjust the runtime adapter to match.

- [ ] **Step 3: Commit checkpoint.**

Ask user. Suggested message:
`feat(btc15m): wire factory, persistent store, budget manager, and user-WS`

---

## Task 11: Backend routes — `/api/btc15m/{status,start,stop}`

**Files:**
- Modify: `backend/src/server.ts`

Pattern reference: the existing `/api/btc5m/{status,start,stop}` block (search `server.ts` for `requestUrl.pathname === "/api/btc5m/start"`).

- [ ] **Step 1: Add the import.**

At the top of `server.ts`, alongside the existing btc5m-bot import:

```ts
import {
  getBtc15mBotStatus,
  startBtc15mBot,
  stopBtc15mBot,
} from "./btc15m/index.js";
```

- [ ] **Step 2: Add the routes.**

In the request handler, immediately after the `/api/btc5m/stop` route, add:

```ts
if (requestUrl.pathname === "/api/btc15m/status" && req.method === "GET") {
  const settings = loadSettings();
  const status = await getBtc15mBotStatus(settings);
  return sendJson(res, 200, status);
}
if (requestUrl.pathname === "/api/btc15m/start" && req.method === "POST") {
  const settings = loadSettings();
  const body = await readJsonBody<{ config?: Partial<import("./btc15m/index.js").Btc15mBotConfig> }>(req);
  const status = await startBtc15mBot(settings, { configOverrides: body?.config });
  return sendJson(res, 200, status);
}
if (requestUrl.pathname === "/api/btc15m/stop" && req.method === "POST") {
  const status = stopBtc15mBot();
  return sendJson(res, 200, status ?? { enginePhase: "stopped" });
}
```

(`sendJson` and `readJsonBody` helpers: reuse whatever utility the existing routes use — locate them at the top of `server.ts`. If `readJsonBody` doesn't exist, copy the pattern from `/api/btc5m/start`.)

- [ ] **Step 3: Build and run the server locally.**

Run: `docker-compose up --build -d` (or `cd backend && pnpm run dev`).
Then in a second terminal:

```bash
curl -sS http://localhost:8080/api/btc15m/status | head
curl -sS -X POST http://localhost:8080/api/btc15m/start -H 'content-type: application/json' -d '{"config":{"workingBudgetUsd":5}}' | head
curl -sS -X POST http://localhost:8080/api/btc15m/stop | head
```

Expected: each returns valid JSON; status reflects the engine phase.

(If `docker-compose` is unavailable in the current environment, record that as a verification blocker per `CLAUDE.md`.)

- [ ] **Step 4: Commit checkpoint.**

Ask user. Suggested message:
`feat(btc15m): expose /api/btc15m status/start/stop routes`

---

## Task 12: Frontend — `AppTab` + nav button + polling

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Extend the `AppTab` union.**

Find the line:

```ts
type AppTab = "weather" | "positions" | "btc5m";
```

Replace with:

```ts
type AppTab = "weather" | "positions" | "btc5m" | "btc15m";
```

- [ ] **Step 2: Add status types and state hooks.**

Near the other `Btc5m*` types (search for `Btc5mBotStatus`), add type re-declarations matching the backend `Btc15mBotStatus` payload (or use a lighter `unknown` cast — but a typed local interface is clearer). Add:

```ts
type Btc15mStatusPayload = {
  enginePhase: "stopped" | "running" | "auto_stopped";
  dryRun: boolean;
  config: {
    workingBudgetUsd: number;
    shares: number;
    buyPrice: number;
    sellPrice: number;
    repeatThresholdMin: number;
    forceSellThresholdMin: number;
    neutralZoneUsd: number;
    tickIntervalSec: number;
  };
  market: { slug: string; question: string; startTimeMs: number; endTimeMs: number } | null;
  marketStartBtcPrice: number | null;
  currentBtcPrice: number | null;
  cycle: {
    cyclePhase: string;
    buyOrder: { price: number; size: number; status: string; bettingSide: "up" | "down" } | null;
    sellOrder: { price: number; size: number; status: string } | null;
    position: { bettingSide: "up" | "down"; shares: number; avgEntryPrice: number } | null;
  };
  completedTrades: Array<{
    id: string;
    marketSlug: string;
    bettingSide: "up" | "down";
    buyPrice: number;
    sellPrice: number;
    shares: number;
    pnlUsd: number;
    result: "win" | "loss";
    exitReason: string;
    closedAt: number;
  }>;
  analytics: {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnlUsd: number;
    remainingBudgetUsd: number;
  };
  budget: { availableBudget: number; lockedBudget: number; initialBudget: number } | null;
  logs: Array<{ timestamp: number; message: string; type: "info" | "warn" | "error" | "success" }>;
  lastError: string | null;
};
```

Add hooks near the other btc5m hooks:

```ts
const [btc15mStatus, setBtc15mStatus] = useState<Btc15mStatusPayload | null>(null);
const [btc15mLoading, setBtc15mLoading] = useState(false);
```

- [ ] **Step 3: Add the polling effect.**

After the existing btc5m polling effect (search for `loadBtc5mStatus`), add:

```ts
useEffect(() => {
  if (activeTab !== "btc15m") return;
  let cancelled = false;
  const load = async () => {
    try {
      const res = await fetch("/api/btc15m/status");
      if (!res.ok) return;
      const data = (await res.json()) as Btc15mStatusPayload;
      if (!cancelled) setBtc15mStatus(data);
    } catch {
      // swallow; next poll retries
    }
  };
  void load();
  const id = setInterval(() => void load(), 3000);
  return () => {
    cancelled = true;
    clearInterval(id);
  };
}, [activeTab]);
```

- [ ] **Step 4: Add the nav button.**

Locate the `BTC 5M Bot` nav button and add adjacent:

```tsx
<button
  className={`button tab-button ${activeTab === "btc15m" ? "tab-button-active" : ""}`}
  onClick={() => handleTabSwitch("btc15m")}
>BTC 15m</button>
```

- [ ] **Step 5: Add a placeholder render section.**

Below the existing `{activeTab === "btc5m" && (...)}` block:

```tsx
{activeTab === "btc15m" && (
  <main className="content">
    <section className="card">
      <h2>BTC 15m</h2>
      <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(btc15mStatus, null, 2)}</pre>
    </section>
  </main>
)}
```

(Real UI lands in Tasks 13–15.)

- [ ] **Step 6: Build the frontend.**

Run: `cd frontend && pnpm run build` (or `pnpm run dev`).
Expected: build succeeds.

- [ ] **Step 7: Commit checkpoint.**

Ask user. Suggested message:
`feat(btc15m): add BTC 15m tab scaffold with status polling`

---

## Task 13: Frontend — settings panel + Start/Stop + SIM/LIVE badge

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Add settings state.**

Add near the other btc15m state hooks:

```ts
const [btc15mFormConfig, setBtc15mFormConfig] = useState({
  workingBudgetUsd: 5,
  shares: 5,
  buyPrice: 0.25,
  sellPrice: 0.4,
  repeatThresholdMin: 6,
  forceSellThresholdMin: 2,
  neutralZoneUsd: 5,
});

useEffect(() => {
  if (btc15mStatus?.config) {
    setBtc15mFormConfig({
      workingBudgetUsd: btc15mStatus.config.workingBudgetUsd,
      shares: btc15mStatus.config.shares,
      buyPrice: btc15mStatus.config.buyPrice,
      sellPrice: btc15mStatus.config.sellPrice,
      repeatThresholdMin: btc15mStatus.config.repeatThresholdMin,
      forceSellThresholdMin: btc15mStatus.config.forceSellThresholdMin,
      neutralZoneUsd: btc15mStatus.config.neutralZoneUsd,
    });
  }
}, [btc15mStatus?.config]);
```

- [ ] **Step 2: Add Start/Stop handler.**

```ts
async function toggleBtc15mBot() {
  if (btc15mLoading) return;
  setBtc15mLoading(true);
  try {
    const active = btc15mStatus?.enginePhase === "running";
    const url = active ? "/api/btc15m/stop" : "/api/btc15m/start";
    const body = active ? undefined : JSON.stringify({ config: btc15mFormConfig });
    const res = await fetch(url, {
      method: "POST",
      headers: body ? { "content-type": "application/json" } : undefined,
      body,
    });
    if (res.ok) {
      const data = (await res.json()) as Btc15mStatusPayload;
      setBtc15mStatus(data);
    }
  } finally {
    setBtc15mLoading(false);
  }
}
```

- [ ] **Step 3: Replace the placeholder section with the settings panel.**

Replace the `<pre>` placeholder with:

```tsx
{activeTab === "btc15m" && (
  <main className="content btc15m-tab">
    <section className="card btc15m-settings">
      <header className="card-header">
        <h2>BTC 15m</h2>
        <span className={`status-badge ${btc15mStatus?.dryRun === false ? "on" : "off"}`}>
          {btc15mStatus?.dryRun === false ? "LIVE" : "SIM"}
        </span>
      </header>
      <div className="settings-grid">
        {([
          ["Working budget ($)", "workingBudgetUsd", 0.5],
          ["Shares per cycle", "shares", 1],
          ["Buy price ($)", "buyPrice", 0.01],
          ["Sell price ($)", "sellPrice", 0.01],
          ["Repeat threshold (min)", "repeatThresholdMin", 1],
          ["Force-sell threshold (min)", "forceSellThresholdMin", 1],
          ["Neutral zone ($)", "neutralZoneUsd", 1],
        ] as const).map(([label, key, step]) => (
          <label key={key} className="settings-field">
            <span>{label}</span>
            <input
              type="number"
              step={step}
              value={btc15mFormConfig[key]}
              disabled={btc15mStatus?.enginePhase === "running"}
              onChange={(e) => setBtc15mFormConfig((prev) => ({
                ...prev,
                [key]: Number(e.target.value),
              }))}
            />
          </label>
        ))}
      </div>
      <button
        className={`button ${btc15mStatus?.enginePhase === "running" ? "button-secondary" : "button-primary"}`}
        onClick={() => void toggleBtc15mBot()}
        disabled={btc15mLoading}
      >
        {btc15mLoading ? "..." : btc15mStatus?.enginePhase === "running" ? "Stop" : "Start"}
      </button>
      {btc15mStatus?.enginePhase === "auto_stopped" && (
        <p className="warning">Auto-stopped: budget exhausted.</p>
      )}
      {btc15mStatus?.lastError && (
        <p className="error">{btc15mStatus.lastError}</p>
      )}
    </section>
  </main>
)}
```

- [ ] **Step 4: Verify build.**

Run: `cd frontend && pnpm run build`
Expected: PASS.

- [ ] **Step 5: Commit checkpoint.**

Ask user. Suggested message:
`feat(btc15m): settings panel with Start/Stop and SIM/LIVE badge`

---

## Task 14: Frontend — live monitor panel

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Add a sibling section after the settings card.**

Inside the `{activeTab === "btc15m" && (...)}` block, right after `<section className="card btc15m-settings">...</section>`:

```tsx
<section className="card btc15m-monitor">
  <h3>Live monitor</h3>
  {btc15mStatus?.market ? (
    <div className="monitor-grid">
      <div><span className="label">Market</span><span>{btc15mStatus.market.slug}</span></div>
      <div><span className="label">Question</span><span>{btc15mStatus.market.question}</span></div>
      <div><span className="label">Time remaining</span><span>{formatTimeRemaining(btc15mStatus.market.endTimeMs)}</span></div>
      <div><span className="label">Start BTC</span><span>{btc15mStatus.marketStartBtcPrice?.toFixed(2) ?? "—"}</span></div>
      <div><span className="label">Current BTC</span><span>{btc15mStatus.currentBtcPrice?.toFixed(2) ?? "—"}</span></div>
      <div>
        <span className="label">Delta</span>
        <span>{
          btc15mStatus.currentBtcPrice != null && btc15mStatus.marketStartBtcPrice != null
            ? (btc15mStatus.currentBtcPrice - btc15mStatus.marketStartBtcPrice).toFixed(2)
            : "—"
        }</span>
      </div>
      <div><span className="label">Engine</span><span>{btc15mStatus.enginePhase}</span></div>
      <div><span className="label">Cycle</span><span>{btc15mStatus.cycle.cyclePhase}</span></div>
    </div>
  ) : (
    <p className="muted">Waiting for live 15m market.</p>
  )}

  <div className="cycle-row">
    <div className="cycle-col">
      <h4>Buy order</h4>
      {btc15mStatus?.cycle.buyOrder ? (
        <pre>{JSON.stringify(btc15mStatus.cycle.buyOrder, null, 2)}</pre>
      ) : <p className="muted">none</p>}
    </div>
    <div className="cycle-col">
      <h4>Position</h4>
      {btc15mStatus?.cycle.position ? (
        <pre>{JSON.stringify(btc15mStatus.cycle.position, null, 2)}</pre>
      ) : <p className="muted">none</p>}
    </div>
    <div className="cycle-col">
      <h4>Sell order</h4>
      {btc15mStatus?.cycle.sellOrder ? (
        <pre>{JSON.stringify(btc15mStatus.cycle.sellOrder, null, 2)}</pre>
      ) : <p className="muted">none</p>}
    </div>
  </div>
</section>
```

Add helper near other formatters:

```ts
function formatTimeRemaining(endTimeMs: number): string {
  const remaining = Math.max(0, endTimeMs - Date.now());
  const m = Math.floor(remaining / 60000);
  const s = Math.floor((remaining % 60000) / 1000);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
```

- [ ] **Step 2: Verify build.**

Run: `cd frontend && pnpm run build`
Expected: PASS.

- [ ] **Step 3: Commit checkpoint.**

Ask user. Suggested message:
`feat(btc15m): live monitor panel`

---

## Task 15: Frontend — analytics table

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Add the analytics section after the monitor.**

```tsx
<section className="card btc15m-analytics">
  <header className="card-header">
    <h3>Trade history</h3>
    <div className="analytics-summary">
      <span>Trades: {btc15mStatus?.analytics.totalTrades ?? 0}</span>
      <span>Wins: {btc15mStatus?.analytics.wins ?? 0}</span>
      <span>Losses: {btc15mStatus?.analytics.losses ?? 0}</span>
      <span>Win rate: {((btc15mStatus?.analytics.winRate ?? 0) * 100).toFixed(1)}%</span>
      <span>PnL: ${btc15mStatus?.analytics.totalPnlUsd.toFixed(2) ?? "0.00"}</span>
      <span>Budget left: ${btc15mStatus?.analytics.remainingBudgetUsd.toFixed(2) ?? "0.00"}</span>
    </div>
  </header>
  <table className="trade-table">
    <thead>
      <tr>
        <th>Time</th>
        <th>Market</th>
        <th>Side</th>
        <th>Buy</th>
        <th>Sell</th>
        <th>Qty</th>
        <th>PnL</th>
        <th>Result</th>
        <th>Exit</th>
      </tr>
    </thead>
    <tbody>
      {(btc15mStatus?.completedTrades ?? []).slice().reverse().map((trade) => (
        <tr key={trade.id} className={trade.result === "win" ? "row-win" : "row-loss"}>
          <td>{new Date(trade.closedAt).toLocaleString()}</td>
          <td>{trade.marketSlug.replace("btc-updown-15m-", "")}</td>
          <td>{trade.bettingSide.toUpperCase()}</td>
          <td>${trade.buyPrice.toFixed(2)}</td>
          <td>${trade.sellPrice.toFixed(2)}</td>
          <td>{trade.shares}</td>
          <td>${trade.pnlUsd.toFixed(2)}</td>
          <td>{trade.result}</td>
          <td>{trade.exitReason}</td>
        </tr>
      ))}
      {(btc15mStatus?.completedTrades ?? []).length === 0 && (
        <tr><td colSpan={9} className="muted">No trades yet.</td></tr>
      )}
    </tbody>
  </table>
</section>
```

- [ ] **Step 2: Verify build.**

Run: `cd frontend && pnpm run build`
Expected: PASS.

- [ ] **Step 3: Commit checkpoint.**

Ask user. Suggested message:
`feat(btc15m): analytics table with wins/losses summary`

---

## Task 16: Styles — premium dark theme additions

**Files:**
- Modify: `frontend/src/styles.css`

- [ ] **Step 1: Append the styles.**

Append to `styles.css` (after existing styles):

```css
/* BTC 15m */
.btc15m-tab .card { margin-bottom: 16px; }

.btc15m-settings .settings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
  margin: 12px 0;
}
.settings-field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.settings-field input {
  background: #0f1414;
  border: 1px solid #2a3434;
  color: #e6efe6;
  padding: 6px 8px;
  border-radius: 6px;
}

.btc15m-monitor .monitor-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px 16px;
  margin: 8px 0 16px;
}
.btc15m-monitor .monitor-grid > div { display: flex; flex-direction: column; }
.btc15m-monitor .label {
  font-size: 11px;
  color: #d4af37; /* gold */
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.btc15m-monitor .cycle-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.btc15m-monitor .cycle-col h4 { color: #d4af37; margin: 8px 0 4px; }
.btc15m-monitor .cycle-col pre {
  background: #0f1414;
  border: 1px solid #2a3434;
  padding: 8px;
  border-radius: 6px;
  font-size: 12px;
  max-height: 180px;
  overflow: auto;
}

.btc15m-analytics .analytics-summary {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  font-size: 13px;
}
.trade-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 12px;
}
.trade-table th, .trade-table td {
  padding: 6px 8px;
  border-bottom: 1px solid #1a2222;
  font-size: 12px;
  text-align: left;
}
.trade-table th { color: #d4af37; font-weight: 600; }
.trade-table .row-win td { color: #7fe5b3; } /* mint */
.trade-table .row-loss td { color: #ff8aa3; } /* rose */
.muted { color: #6f8080; }
.warning { color: #d4af37; }
.error { color: #ff8aa3; }
```

- [ ] **Step 2: Verify build.**

Run: `cd frontend && pnpm run build`
Expected: PASS.

- [ ] **Step 3: Commit checkpoint.**

Ask user. Suggested message:
`style(btc15m): premium dark theme for new tab`

---

## Task 17: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Rebuild the stack.**

Run: `docker-compose up --build -d`
Expected: containers up. If `docker-compose` is unavailable, log the blocker and skip Steps 2–4.

- [ ] **Step 2: Status endpoint smoke test.**

Run:
```
curl -sS http://localhost:8080/api/btc15m/status | jq .enginePhase
```
Expected: `"stopped"`.

- [ ] **Step 3: Start the bot in SIM mode.**

Confirm `.env` has `BOT_DRY_RUN=true` (default). Then:

```
curl -sS -X POST http://localhost:8080/api/btc15m/start \
  -H 'content-type: application/json' \
  -d '{"config":{"workingBudgetUsd":5}}' | jq .enginePhase
```
Expected: `"running"`.

- [ ] **Step 4: Open the UI.**

Open `http://localhost:8080`. Click the `BTC 15m` tab. Verify:
- Settings show defaults.
- `SIM` badge visible.
- Live monitor displays current 15m market within a few seconds.
- Status badge stays `running`.
- After enough simulated cycles, completed trades appear in the analytics table.

- [ ] **Step 5: Stop the bot.**

```
curl -sS -X POST http://localhost:8080/api/btc15m/stop | jq .enginePhase
```
Expected: `"stopped"`.

- [ ] **Step 6: Confirm Scalper and BTC 5M Bot are unaffected.**

Switch between tabs. Start/Stop on Scalper and BTC 5M Bot should behave as before; their state files are untouched.

- [ ] **Step 7: Record verification outcome.**

If all steps pass: append a one-line note to `SESSION_NOTES.md` under "Current State" — "BTC 15m trading module shipped (SIM verified)". If anything failed or was blocked, document the blocker explicitly (per `CLAUDE.md` verification rules) and do NOT mark this task done.

- [ ] **Step 8: Final commit checkpoint.**

Ask user. Suggested message: `chore(btc15m): record end-to-end verification`.

---

## Self-Review

Spec coverage check (each spec section → task):
- Strategy logic (direction, buy, sell, repeat, force-sell, cancel-irrelevant) → Tasks 6–9.
- Backend engine `backend/src/btc15m/` → Tasks 2–5, 10.
- Reused `TradingClient.cancelOrder`, `PolymarketService`, `ScalperUserWs`, `BudgetManager` → Tasks 7–10.
- Market resolver (15-min boundary slug, Gamma lookup, time-to-end, market switching) → Tasks 4, 9.
- Budget guardrail (reserve/consume/addFunds/release, auto-stop on exhaustion) → Tasks 6, 8, 9.
- Configuration (`Btc15mSettings`, env vars, defaults, UI overrides) → Tasks 1, 10, 13.
- Backend API (`/api/btc15m/{status,start,stop}`) → Task 11.
- Frontend tab (settings, monitor, analytics, polling, off-by-default) → Tasks 12–15.
- Persistence (`Btc15mStateStore`, trade history, budget survive restart) → Tasks 3, 10.
- Safety (`dryRun`, `maxOrderUsdc`, one market/cycle at a time, graceful stop) → Tasks 6 (reserve), 8 (handle errors), 10 (singleton).
- Premium dark theme styling → Task 16.

No placeholders or "TBD" steps. Each task includes either complete code or a precise edit anchor.
