# Weather Sessions API Documentation

Real-time multi-city Polymarket weather bot with WebSocket price updates and position tracking.

## REST Endpoints

### Create Weather Session
**POST** `/api/weather/session`

Opens a new tab for a Polymarket weather event.

**Request:**
```json
{
  "event_url": "https://polymarket.com/event/highest-temperature-in-toronto-on-may-25"
}
```

**Response (200):**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "slug": "highest-temperature-in-toronto-on-may-25",
  "city": "CYYZ",
  "date": "2026-05-26",
  "event_url": "https://polymarket.com/event/highest-temperature-in-toronto-on-may-25",
  "icao": "CYYZ",
  "created_at": "2026-05-26T01:15:32.123Z"
}
```

**Errors:**
- 400: `event_url is required` — missing or invalid event URL
- 400: `Invalid Polymarket event URL` — URL doesn't match pattern `/event/<slug>`
- 400: `Event not found on Polymarket` — slug doesn't exist on Polymarket

---

### List Weather Sessions
**GET** `/api/weather/sessions`

Retrieve all open tabs.

**Response (200):**
```json
{
  "sessions": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "slug": "highest-temperature-in-toronto-on-may-25",
      "city": "CYYZ",
      "date": "2026-05-26",
      "event_url": "https://polymarket.com/event/highest-temperature-in-toronto-on-may-25",
      "icao": "CYYZ",
      "created_at": "2026-05-26T01:15:32.123Z"
    }
  ]
}
```

---

### Close Weather Session
**DELETE** `/api/weather/session/{sessionId}`

Closes a tab and removes it from the list.

**Response (200):**
```json
{
  "success": true
}
```

**Errors:**
- 404: Session not found

---

## WebSocket Connection

### Connect
**URL:** `ws://localhost:3000/weather/ws?sessionId={sessionId}&slug={slug}`

Establishes a real-time connection to receive market price updates.

**Example:**
```
ws://localhost:3000/weather/ws?sessionId=550e8400-e29b-41d4-a716-446655440000&slug=highest-temperature-in-toronto-on-may-25
```

**Query Parameters:**
- `sessionId` (required): Session ID from `/api/weather/session`
- `slug` (required): Event slug from Polymarket

### Server → Client Messages

#### Market Price Update
Sent whenever a market price changes (and the market has active triggers).

```json
{
  "type": "market_update",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "market": {
    "market_slug": "highest-temperature-in-toronto-on-may-25",
    "question": "Will the highest temperature in Toronto be 21°C on May 25?",
    "yes_price": 0.42,
    "no_price": 0.58,
    "yes_token_id": "0x123...abc",
    "volume": 68116.74,
    "liquidity": 858.40,
    "position": {
      "size": 100,
      "avg_price": 0.40,
      "current_value": 42.00,
      "cash_pnl": 2.00,
      "percent_pnl": 5.0
    }
  }
}
```

**Fields:**
- `market_slug` (string): Unique market identifier (from Polymarket event slug)
- `question` (string): Market question text
- `yes_price` (number): Current YES outcome price (0.0 - 1.0)
- `no_price` (number): Current NO outcome price (0.0 - 1.0)
- `yes_token_id` (string): Token ID for YES token on Polymarket
- `volume` (number): 24h trading volume in USDC
- `liquidity` (number): Available liquidity in USDC
- `position` (object|null): User's position (if owned, otherwise null)
  - `size` (number): Amount held
  - `avg_price` (number): Average purchase price
  - `current_value` (number): Current position value in USDC
  - `cash_pnl` (number): Profit/loss in USDC
  - `percent_pnl` (number): Profit/loss percentage

#### Error Message
Sent if the WebSocket encounters an error.

```json
{
  "type": "error",
  "message": "Failed to fetch positions"
}
```

### Connection Lifecycle

1. **Connect:** `ws://localhost:3000/weather/ws?sessionId=...&slug=...`
2. **Listen for updates:** Market price updates arrive automatically
3. **Disconnect:** Close the connection (automatic reconnect with exponential backoff up to 5 attempts)

**Auto-Reconnect:** If disconnected, the client automatically attempts to reconnect with delays of 2s, 4s, 8s, 16s, 32s.

---

## Database Schema

### weather_sessions
Stores active weather market tabs.

```sql
CREATE TABLE weather_sessions (
  id UUID PRIMARY KEY,
  slug VARCHAR(255) NOT NULL,              -- Polymarket event slug
  city VARCHAR(100) NOT NULL,              -- City name / ICAO code
  date VARCHAR(10) NOT NULL,               -- YYYY-MM-DD
  event_url TEXT NOT NULL,                 -- Full Polymarket event URL
  icao VARCHAR(10),                        -- Airport code
  event_data JSONB,                        -- Cached event metadata
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### weather_triggers
Stores temperature thresholds and orders for each session.

```sql
CREATE TABLE weather_triggers (
  id UUID PRIMARY KEY,
  session_id UUID REFERENCES weather_sessions(id) ON DELETE CASCADE,
  token_id VARCHAR(255) NOT NULL,         -- CLOB token ID for outcome
  temp NUMERIC NOT NULL,                  -- Temperature threshold (°C)
  amount NUMERIC NOT NULL,                -- USDC amount
  executed BOOLEAN DEFAULT FALSE,         -- Has order been placed?
  order_id VARCHAR(255),                  -- Polymarket order ID
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

---

## Implementation Notes

### Position Cache
- **TTL:** 3 seconds
- **Update:** Fetched on-demand when market prices update
- **Fallback:** Returns stale cache if API fails temporarily

### WebSocket Filtering
- Market prices are **only sent** if a temperature trigger exists for that market
- This reduces bandwidth and server load

### Reconnection Strategy
- Exponential backoff: 2s → 4s → 8s → 16s → 32s (max 5 attempts)
- After max attempts, connection fails and requires manual reconnect

### Limit Orders (FOK Fix)
- Weather triggers use **limit orders** (not FOK market orders)
- Placed at current market price to handle small amounts (1 USDC)
- May partially fill or hang in orderbook if liquidity is insufficient

---

## Frontend Integration

### Hook: `useWeatherWebSocket`
Manages WebSocket connection for a session.

```typescript
const { markets, isConnected, error } = useWeatherWebSocket(sessionId, slug);
```

**Returns:**
- `markets` (EnrichedMarket[]): Array of market prices + positions
- `isConnected` (boolean): Connection status
- `error` (string|null): Error message if any

### Context: `WeatherTabContext`
Manages open sessions and tab state.

```typescript
const { sessions, activeSessionId, openSession, closeSession } = useWeatherTabs();
```

---

## Testing

### Manual Smoke Test
1. Load app, navigate to Weather tab
2. Click [+ New], paste Polymarket event URL
3. Verify tab appears with city + date
4. Verify tab is clickable
5. Close tab with [X], verify removal
6. Open multiple tabs, switch between them
7. Watch prices update in real-time (may take 3-5 seconds due to position cache TTL)

### Monitor Logs
```bash
docker logs pm-backend-1 | grep "\[WS\]"
```

Expected output:
- `[WS] Connected to Polymarket for session <id>`
- `[WS] Price updates flowing...`
- `[WS] Disconnected from session <id>`
- `[WS] Reconnecting...` (if connection drops)

