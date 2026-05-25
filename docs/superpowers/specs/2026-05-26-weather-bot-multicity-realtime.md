# Weather Bot Multi-City Tabs + Real-Time Price Updates

**Date:** 2026-05-26  
**Status:** Design  
**Scope:** Backend WebSocket architecture for real-time market prices + Frontend multi-tab UI for managing multiple city/date combinations

---

## Problem Statement

Currently:
- Market prices load once via `POST /weather/polymarket/event` and don't update until manual refresh
- Only one event can be actively viewed at a time
- No way to quickly switch between multiple cities/dates or work with them in parallel
- When orders are placed, frontend has no real-time visibility into position changes (profit, current value)

**Goals:**
1. Display real-time market prices (YES/NO %) as they update from Polymarket
2. Show live position data: purchase price, current value, profit (USDC and %)
3. Ability to open/manage multiple cities (city + date combinations) as independent tabs
4. Quick switching between cities without losing context
5. Persist open tabs in database for session continuity

---

## Architecture Overview

### Per-Tab WebSocket Model

Each tab (city + date combination) is **completely independent**:
- When a tab is opened, backend establishes a **single WebSocket connection** to Polymarket for that event's markets
- Each tab has its own position cache (3-second TTL) and market subscription
- Closing a tab cleanly terminates its WebSocket and cleans up resources
- No state synchronization between tabs needed (they're different events)

**Why this approach:**
- Simplicity: each tab is self-contained, no complex sync logic
- Scalability: N tabs = N independent subscriptions (acceptable because each event is different)
- User mental model: tabs work like browser tabs—independent views

---

## Database Schema

### Table: `weather_sessions`

Represents an open tab. Stores the event metadata.

```sql
CREATE TABLE weather_sessions (
  id UUID PRIMARY KEY,
  slug VARCHAR(255) NOT NULL,           -- from Polymarket event URL
  city VARCHAR(100) NOT NULL,            -- extracted/human-readable city name
  date VARCHAR(10) NOT NULL,             -- YYYY-MM-DD format
  event_url TEXT NOT NULL,               -- full Polymarket event URL
  icao VARCHAR(10),                      -- airport code (e.g., CYYZ)
  event_data JSONB,                      -- cached event metadata (title, description, etc.)
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  user_id VARCHAR(255)                   -- for multi-user support (future)
);
```

### Table: `weather_triggers`

Stores temperature thresholds and associated orders for each session.

```sql
CREATE TABLE weather_triggers (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES weather_sessions(id) ON DELETE CASCADE,
  token_id VARCHAR(255) NOT NULL,        -- CLOB token ID for market outcome
  temp NUMBER NOT NULL,                  -- temperature threshold (Celsius)
  amount NUMBER NOT NULL,                -- USDC amount to buy
  executed BOOLEAN DEFAULT FALSE,        -- has order been placed?
  order_id VARCHAR(255),                 -- Polymarket order ID if placed
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### Table: `weather_tab_order`

Stores the visual order of tabs as user arranges them.

```sql
CREATE TABLE weather_tab_order (
  id UUID PRIMARY KEY,
  session_ids JSONB NOT NULL,            -- ["uuid-1", "uuid-2", ...] ordered list
  updated_at TIMESTAMP DEFAULT NOW()
);
```

---

## Backend Implementation

### 1. WebSocket Architecture

**File:** `backend/src/weather-polymarket-ws.ts` (new)

**Responsibilities:**
- Manage WebSocket connection to Polymarket Gamma API per session
- Listen for market price updates for the session's event
- Filter updates: only send prices for markets with active triggers
- Maintain position cache with 3-second TTL
- Broadcast enriched price data to connected frontend clients

**Key Functions:**

```typescript
// Initialize WebSocket for a session
async function initializeSessionWebSocket(sessionId: string): Promise<void>
  - Fetch session metadata from DB
  - Extract Polymarket event slug
  - Subscribe to Polymarket WS for that event
  - Set up price listeners
  - Start position cache interval (3s)

// Handle market price update
function onMarketPriceUpdate(sessionId: string, marketUpdate: MarketUpdate): void
  - Get active triggers for this session
  - Filter: does this market have a trigger?
  - If yes: fetch positions (from cache or API), enrich data
  - Broadcast to all connected clients for this session

// Position cache (3-second TTL)
const positionCache = new Map<string, { data: Position[]; timestamp: number }>()
  - Lazy load: fetch only if expired or missing
  - Fetch from Polymarket data API: GET /positions
```

### 2. HTTP Endpoints

**File:** `backend/src/app.ts` (extend)

```typescript
// Create a new session (open a tab)
POST /weather/session
Request:  { event_url: string }
Response: { session_id: string, city: string, date: string, ... }

// List all open sessions
GET /weather/sessions
Response: { sessions: SessionMetadata[] }

// Close a session (close a tab)
DELETE /weather/session/:sessionId
Response: { success: boolean }

// Reorder tabs
POST /weather/session/reorder
Request:  { order: string[] }  // array of session IDs
Response: { success: boolean }
```

### 3. WebSocket Message Format

**Client → Server:**
```json
{
  "type": "subscribe",
  "sessionId": "uuid-xxx"
}
```

**Server → Client (on market price update):**
```json
{
  "type": "market_update",
  "sessionId": "uuid-xxx",
  "markets": [
    {
      "market_slug": "will-btc-close-above-50k-on-may-26",
      "question": "Will the highest temperature in Toronto be 21°C on May 25?",
      "yes_price": 0.42,
      "no_price": 0.58,
      "yes_token_id": "0x123...",
      "volume": 68000.00,
      "liquidity": 850.00,
      "positions": [
        {
          "token_id": "0x123...",
          "size": 100,                    // amount held
          "avg_price": 0.40,              // purchase price
          "current_value": 42.00,         // current value (size * yes_price)
          "cash_pnl": 2.00,               // profit in USDC
          "percent_pnl": 5.0,             // profit %
          "cur_price": 0.42               // current market price
        }
      ]
    }
  ]
}
```

---

## Frontend Implementation

### 1. Tab Management UI

**File:** `frontend/src/components/WeatherTabBar.tsx` (new)

**Visual:**
```
┌─────────────────────────────────────────────────────────┐
│ [Toronto • May 25] [X]  [Moscow • May 26] [X]  [+ New] │
└─────────────────────────────────────────────────────────┘
```

**Features:**
- Display list of open sessions as tabs
- Show city + date for each tab
- Click tab to switch to it
- Click [X] to close tab (triggers `DELETE /weather/session/:id`)
- [+ New] button opens event URL input dialog

### 2. Weather Screen (Updated)

**File:** `frontend/src/screens/weather/WeatherScreen.tsx` (update)

**Changes:**
- Add tab bar at top
- Switch between weather screens based on active tab
- Each tab has its own WebSocket connection to `/weather/ws/:sessionId`
- Real-time market list with enriched position data

**Market Card (Updated):**
```
┌─────────────────────────────────────────────────────┐
│ Will highest temp in Toronto be 21°C on May 25?     │
│                                                     │
│ YES: 0.42  (↑ 0.01)   Volume: $68,116.74           │
│ NO:  0.58              Liquidity: $858.40           │
│                                                     │
│ Position:                                           │
│   Bought @ 0.40  |  Current: $42.00  |  +$2 (5%)  │
│                                                     │
│ ┌─────────────────────────────────────────────────┐ │
│ │ Sell                                            │ │
│ └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### 3. WebSocket Connection Hook

**File:** `frontend/src/hooks/useWeatherWebSocket.ts` (new)

```typescript
function useWeatherWebSocket(sessionId: string): {
  markets: EnrichedMarket[];
  isConnected: boolean;
  error: string | null;
} {
  // Connect to /weather/ws/:sessionId
  // Listen for market_update messages
  // Update local state on each message
  // Clean up on unmount
}
```

### 4. React Context for Tab Management

**File:** `frontend/src/context/WeatherTabContext.tsx` (new)

```typescript
interface WeatherTabContextType {
  sessions: SessionMetadata[];
  activeSessionId: string | null;
  openSession(eventUrl: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  setActiveSession(sessionId: string): void;
  reorderSessions(order: string[]): Promise<void>;
}
```

---

## Data Flow

### Opening a New Tab

```
1. User clicks [+ New] button
2. Frontend shows input dialog (event URL)
3. User pastes: "https://polymarket.com/event/highest-temperature-in-toronto-on-may-25"
4. Frontend: POST /weather/session { event_url }
5. Backend:
   - Extract slug from URL
   - Call Gamma API to fetch event details (markets, etc.)
   - Save to weather_sessions table
   - Initialize WebSocket listener for this event
   - Return sessionId, city, date
6. Frontend: Add tab to tab bar, set as active
7. Frontend: Connect WebSocket to /weather/ws/:sessionId
8. Backend: Send current market prices + positions (from cache)
```

### Real-Time Price Update

```
1. Polymarket broadcasts price update (YES price changed to 0.42)
2. Backend WebSocket listener receives it
3. Checks: does this market have active triggers? Yes.
4. Checks position cache: is it fresh? No (>3s old)
5. Fetches positions from Polymarket data API
6. Updates cache with TTL 3s
7. Enriches market data: { yes_price: 0.42, positions: [...] }
8. Broadcasts to frontend clients connected to this session
9. Frontend: updates market card in real-time
```

### Closing a Tab

```
1. User clicks [X] on a tab
2. Frontend: DELETE /weather/session/:sessionId
3. Backend:
   - Remove session from weather_sessions
   - Close WebSocket listener for this event
   - Delete triggers for this session
   - Clean up position cache
4. Frontend: Remove tab from tab bar
```

---

## Error Handling

**WebSocket Failures:**
- If Polymarket WS disconnects, backend attempts reconnect (exponential backoff)
- Frontend shows "Connection lost" status and auto-retries
- User can manually refresh

**Position Cache Failures:**
- If Polymarket data API fails, use stale cache for up to 10 seconds
- Then show error: "Unable to load position data"

**Market Not Found:**
- If market slug doesn't exist or event is invalid, show error dialog
- User can edit URL and try again

---

## Constraints & Rules

1. **Position Cache TTL:** Must be exactly **3 seconds** (per user requirement)
2. **WebSocket Filtering:** Only send market prices to frontend if the market has an active trigger
3. **dryRun Check:** Before placing any order, check `settings.dryRun` (existing rule)
4. **Limit Orders (FOK Fix):** Replace FOK market orders with limit orders placed at the current YES/NO price (from cache). This allows small amounts (1 USDC) to be partially filled instead of rejected.
   - Example: If market is at YES 0.42, place limit buy order at 0.42 for requested amount
   - Limit orders can hang in orderbook if not fully filled
5. **Database:** Use PostgreSQL inside Docker (via `docker-compose.yml`)

---

## Testing Strategy

**Backend:**
- Unit tests for position cache (TTL expiration, refresh logic)
- Integration tests for WebSocket flow (mock Polymarket API)
- Tests for session CRUD operations

**Frontend:**
- Unit tests for tab context and state management
- Component tests for tab bar (open, close, reorder)
- Integration tests for WebSocket connection and market updates

---

## Rollout Plan

1. **Phase 1:** Database + backend endpoints (sessions CRUD)
2. **Phase 2:** WebSocket infrastructure + position cache
3. **Phase 3:** Frontend tab bar + WebSocket hook
4. **Phase 4:** Integration testing + bugfixes
5. **Phase 5:** Deploy + verify in staging

---

## Future Enhancements

- Multi-user support (associate sessions with user_id)
- Persistent session history (restore previous tabs on reload)
- Market search/filtering within a tab
- Bulk operations (sell all, close all tabs)
- Position history and analytics

