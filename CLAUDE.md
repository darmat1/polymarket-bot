# Polymarket Weather Bot Rules

## Bot Logic Rules
- **Polling Interval**: The bot uses **adaptive polling** based on temperature diff to target: >10° → 15min, >5° → 10min, >2° → 2min, >1° → 30sec, ≤1° → METAR-window-aware (15s during :00-:05 and :30-:35 min of each hour, 60s otherwise). Do not change this without explicit user permission.
- **Weather Cache**: Weather station history cache TTL MUST be **25 seconds** (25000ms) to ensure fresh data for the fastest 30s poll interval.
- **Temperature Ranges**: If a market uses a temperature range (e.g., "62-63°F"), ALWAYS use the **LOWER** value of the range as the target `t`. This applies to both AI extraction and regex parsing.
- **Trading Safety**: Always check `dryRun` setting before placing real orders.

## UI & Design Rules
- **Position Grouping**: Markets in the "Positions" tab MUST be grouped by `endDate`.
- **Priority**: The group for the current date MUST be labeled "Actual Today" and placed at the top.
- **Layout**:
    - Action buttons (Start/Stop, Sell) MUST be stacked **vertically** in a column with `gap: 8px`.
    - The "Ends" column MUST split the date and time into two separate lines for readability.
- **Responsive Grid**:
    - Use a two-column grid for the positions list on wide screens.
    - Switch to a **single-column** layout if the screen width is **less than 1580px**.
- **Aesthetics**: Maintain a premium dark-mode aesthetic with vibrant colors (Mint for success, Rose for errors/sell, Gold for headers).

## Development Commands
- **Build & Run**: `docker-compose up --build -d`
- **Frontend Dev**: `cd frontend && pnpm run dev`
- **Backend Build**: `cd backend && pnpm run build`
- **Cleanup Docker**: `docker builder prune -f && docker system prune -f`

## Verification Rules
- After any backend code change that affects HTTP routes, server behavior, or background services, restart the backend with `docker-compose up --build -d` before doing HTTP verification.
- If `docker-compose` is unavailable in the current environment, record that blocker explicitly before claiming verification is complete.

## Session Continuity Rule
- If the conversation is at risk of ending before the work is fully wrapped due to token limits or context pressure, record the current implementation state, files changed, unresolved risks, and next steps in `SESSION_NOTES.md` before stopping.
