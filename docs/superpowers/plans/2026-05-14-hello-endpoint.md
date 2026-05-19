# Hello Endpoint Implementation Plan

**Goal:** Add a minimal backend `GET /api/hello` endpoint that returns a small JSON payload and verify it through the existing backend build/check flow plus HTTP verification.

## Smallest integration point
- Existing HTTP routing lives in `backend/src/server.ts` inside the main `createServer(async (req, res) => { ... })` handler.
- Shared business helpers live in `backend/src/app.ts`; a hello endpoint does **not** need a new helper unless you want to centralize the payload generator later.
- The smallest safe change is therefore to add a new early route branch in `backend/src/server.ts` near the other `GET /api/*` handlers.

## Files
- Modify: `backend/src/server.ts`
- Optional future refactor only if desired: `backend/src/app.ts`

## Implementation steps
1. In `backend/src/server.ts`, add:
   - path: `/api/hello`
   - method: `GET`
   - response: `200` with JSON such as `{ ok: true, message: "hello" }`
2. Keep the implementation local to `server.ts` for the smallest possible change.
3. Do not change trading, weather polling, auth, or bot startup logic.

## Verification
1. Type-check backend:
   ```bash
   cd backend && pnpm run check
   ```
2. Build backend:
   ```bash
   cd backend && pnpm run build
   ```
3. Because this changes an HTTP route, restart backend per project rules:
   ```bash
   docker-compose up --build -d
   ```
4. Verify endpoint over HTTP:
   ```bash
   curl http://localhost:3001/api/hello
   ```
   Expected result: JSON hello payload with HTTP 200.

## Notes
- If `docker-compose` is unavailable, record that as the HTTP-verification blocker instead of claiming full verification.
- This plan intentionally avoids touching `backend/src/app.ts` because the route can be added without changing shared domain logic.
