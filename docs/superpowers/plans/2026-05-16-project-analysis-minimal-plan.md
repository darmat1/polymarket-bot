# Project Analysis Minimal Plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Identify the next smallest safe area to change in this repository without disturbing weather polling, trading safety, or current bot/runtime behavior.

**Architecture:** This is a planning-only handoff. Future work should stay close to existing boundaries: backend route orchestration in `backend/src/server.ts`, shared market/account helpers in `backend/src/app.ts`, runtime automation in `backend/src/bot-manager.ts` plus BTC 5m/scalper modules, and the monolithic dashboard in `frontend/src/App.tsx`. Prefer a single-surface change over cross-cutting edits.

**Tech Stack:** TypeScript, Node.js ESM, pnpm workspace, React 19, Vite, Docker Compose

---

## File structure to keep in mind

- `backend/src/server.ts` — central HTTP route switchboard and frontend static serving
- `backend/src/app.ts` — market/account/order/weather helper layer consumed by server and CLI
- `backend/src/bot-manager.ts` — weather bot polling/cache/runtime loop; must preserve 65s polling and 60s station cache behavior
- `backend/src/btc5m-bot.ts` and `backend/src/btc5m/` — BTC 5m automation feature area
- `backend/src/scalper/` — scalper runtime/state feature area
- `frontend/src/App.tsx` — large dashboard component containing tabs, positions, and automation controls
- `frontend/src/styles.css` — shared dashboard styling

## Hard constraints

- Do not change the 65 second active bot polling interval.
- Do not change the 60 second weather station history cache TTL.
- Always use the lower bound of a temperature range as target `t`.
- Always respect `dryRun` before any real trade placement.
- After future backend route/server/background-service changes, restart with `docker-compose up --build -d` before HTTP verification.

### Task 1: Choose the smallest backend-safe change surface

**Files:**
- Review: `backend/src/server.ts`
- Review: `backend/src/app.ts`
- Review: `backend/src/bot-manager.ts`

- [ ] **Step 1: Map backend boundaries**

Read the `/api/*` branches in `backend/src/server.ts` and note which ones simply forward to helpers in `backend/src/app.ts` versus which ones also touch runtime managers directly.

- [ ] **Step 2: Reject risky backend candidates**

Exclude any candidate change that would alter weather polling cadence, weather cache timing, auth bootstrapping, or shared trading execution paths on the first pass.

- [ ] **Step 3: Pick one smallest backend target**

Prefer a single-route or single-helper change that can be verified with `cd backend && pnpm run check`, `cd backend && pnpm run build`, and, if routes/runtime are affected, `docker-compose up --build -d` plus one HTTP request.

### Task 2: Choose the smallest frontend-safe change surface

**Files:**
- Review: `frontend/src/App.tsx`
- Review: `frontend/src/styles.css`

- [ ] **Step 1: Locate one isolated UI slice**

Find a single tab section, panel, or action area in `frontend/src/App.tsx` that can be changed without restructuring the entire dashboard.

- [ ] **Step 2: Preserve existing UI rules**

Keep the positions grouping, responsive breakpoint behavior, stacked action buttons, split end-date/time display, and dark premium styling rules intact when choosing the next UI scope.

- [ ] **Step 3: Limit the future verification surface**

Choose a UI change that can be verified with `cd frontend && pnpm run build` and, only if it depends on backend data shape changes, the matching backend verification flow.

### Task 3: Review runtime coupling before any automation changes

**Files:**
- Review: `backend/src/bot-manager.ts`
- Review: `backend/src/btc5m-bot.ts`
- Review: `backend/src/btc5m/`
- Review: `backend/src/scalper/`

- [ ] **Step 1: Note shared assumptions**

Record where these modules share config loading, order placement, logging, status payloads, or server wiring so future work does not accidentally break another automation mode.

- [ ] **Step 2: Avoid multi-domain edits**

Do not combine weather bot, BTC 5m, and scalper behavior changes in one pass unless the work is purely mechanical and verified independently.

- [ ] **Step 3: Use the smallest verification frontier**

For future automation work, run the narrowest proof first (isolated test or module-specific check), then run `cd backend && pnpm run check`, `cd backend && pnpm run build`, and finally `docker-compose up --build -d` if runtime or HTTP behavior changed.
