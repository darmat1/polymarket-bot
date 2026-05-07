# Polymarket Weather Bot Rules

## Bot Logic Rules
- **Polling Interval**: The active bot task polling interval MUST be exactly **65 seconds** (65000ms). Do not change this without explicit user permission.
- **Weather Cache**: Weather station history cache TTL MUST be **60 seconds** (60000ms) to ensure fresh data for the 65s polling cycle.
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
