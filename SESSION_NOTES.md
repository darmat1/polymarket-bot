# Session Notes

## Verified Now
- `cd backend && pnpm run check` passes.
- `cd backend && pnpm run build` passes.
- `docker-compose up --build -d` succeeds.
- `GET http://localhost:3001/api/account-summary` returns 200.
- LSP diagnostics are clean.
- 2026-05-20 BTC 15m module: backend isolated tests pass; backend check/build pass; frontend build passes with pre-existing Node/Vite warning (`Node.js 20.18.0`, Vite wants 20.19+); Docker image build passes but `docker-compose up --build -d` cannot start because container name `polymarket-bot` is already in use by an existing container. Dev-server smoke on `PORT=3002` verified `/api/btc15m/status`, `/api/btc15m/start` in SIM with high neutral zone, and `/api/btc15m/stop`.

## Implemented Files
- `backend/src/config.ts`
- `backend/src/gamma.ts`
- `backend/src/models.ts`
- `backend/src/runtime-auth.ts`
- `backend/src/trading.ts`
- `backend/src/trading/base-polymarket-client.ts`
- `backend/src/polymarket-service.ts`
- `backend/src/market-scanner.ts`
- `backend/src/scalper-user-ws.ts`
- `backend/src/scalper/index.ts`
- `backend/src/scalper/types.ts`
- `backend/src/scalper/state-store.ts`
- `backend/src/scalper/budget-manager.ts`
- `backend/src/scalper/scalper-strategy.ts`
- `backend/src/budget-manager.ts`
- `backend/.env.example`

## Important Remaining Gaps
- Scalper runtime is not fully integrated into actual app startup flow in a verified way.
- `backend/src/server.ts` still needs final, intentional strategy wiring decision and verification for weather-only / scalper-only / parallel startup behavior.
- TODO verification file was not updated because Reviewer delegation repeatedly failed with tool anomalies.
- There are overlapping scalper-related type layers (`backend/src/models.ts` and `backend/src/scalper/types.ts`) that compile, but should be unified before calling the feature complete.
- `backend/src/scalper/__tests__/index.isolated.test.ts` exists, but test execution/integration was not finalized in the mission workflow.

## Suggested Next Steps
1. Finalize startup wiring for `ScalperStrategy` in `backend/src/server.ts` or another entrypoint.
2. Re-run build/check/docker restart.
3. Verify user requirements against actual runtime behavior.
4. Clean up duplicate scalper type/state models if needed.
5. Update `.opencode/todo.md` only after Reviewer-style verification is restored.
