# Project Analysis Minimal Plan

**Goal:** Capture a small, implementation-free plan for the next round of work in this Polymarket bot repository.

## Key Findings
- The repo is a pnpm workspace with separate `backend` and `frontend` packages.
- Backend HTTP routing is centralized in `backend/src/server.ts`, while shared market/account/weather helpers live in `backend/src/app.ts`.
- The project already contains multiple active domains: weather bot flows, BTC 5m automation, scalper modules, runtime auth, and a large React dashboard.
- Backend verification relies on `cd backend && pnpm run check`, `cd backend && pnpm run build`, and `docker-compose up --build -d` before HTTP-level checks.
- Project rules require preserving the 65s polling interval, 60s weather cache TTL, lower-bound temperature parsing, and `dryRun` trading safety.

## Minimal Future Todo
- [ ] Review `backend/src/server.ts` and `backend/src/app.ts` to choose the next smallest backend change without affecting existing bot flows.
- [ ] Review `frontend/src/App.tsx` and `frontend/src/styles.css` to isolate the next UI change into the smallest safe area.
- [ ] Audit `backend/src/bot-manager.ts`, `backend/src/btc5m-bot.ts`, and `backend/src/scalper/` for shared runtime assumptions before changing automation behavior.
- [ ] Re-run `cd backend && pnpm run check`, `cd backend && pnpm run build`, and `cd frontend && pnpm run build` after any future code change.
- [ ] Restart with `docker-compose up --build -d` before any future HTTP verification involving backend routes or background services.
