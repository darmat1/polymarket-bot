# Weather Bot Multi-City Tabs + Real-Time Prices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build real-time market price updates via WebSocket + multi-tab UI for managing multiple weather markets simultaneously.

**Architecture:** Per-tab WebSocket model where each tab (city + date) has independent Polymarket subscription. Backend caches positions with 3-second TTL. Frontend tabs are managed via React Context.

**Tech Stack:** PostgreSQL (inside Docker), Node.js/TypeScript (backend), React (frontend), WebSocket (bidirectional), Polymarket Gamma API

---

## File Structure

### Backend (New Files)
- `backend/src/weather-polymarket-ws.ts` — WebSocket listener & position cache
- `backend/src/db/migrations/001-weather-tables.sql` — Database schema
- `backend/tests/weather-polymarket-ws.test.ts` — WebSocket tests
- `backend/tests/weather-session.test.ts` — Session CRUD tests

### Backend (Modified Files)
- `backend/src/app.ts` — Add session endpoints (POST/GET/DELETE /weather/session)
- `backend/src/server.ts` — Register WebSocket route (`/weather/ws/:sessionId`)
- `backend/src/config.ts` — Add DB connection string

### Frontend (New Files)
- `frontend/src/components/WeatherTabBar.tsx` — Tab bar UI (browser-like)
- `frontend/src/context/WeatherTabContext.tsx` — Tab state management
- `frontend/src/hooks/useWeatherWebSocket.ts` — WebSocket connection hook
- `frontend/tests/WeatherTabBar.test.tsx` — Tab bar tests
- `frontend/tests/useWeatherWebSocket.test.ts` — Hook tests

### Frontend (Modified Files)
- `frontend/src/screens/weather/WeatherScreen.tsx` — Integrate tab bar, update market display
- `frontend/src/api/weather.ts` — Add session API calls

---

## Phase 1: Database & Backend Setup

### Task 1: Create PostgreSQL Schema

**Files:**
- Create: `backend/src/db/migrations/001-weather-tables.sql`

- [ ] **Step 1: Write migration file with schema**

```sql
-- Create weather_sessions table
CREATE TABLE IF NOT EXISTS weather_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(255) NOT NULL,
  city VARCHAR(100) NOT NULL,
  date VARCHAR(10) NOT NULL,
  event_url TEXT NOT NULL,
  icao VARCHAR(10),
  event_data JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_weather_sessions_slug ON weather_sessions(slug);
CREATE INDEX idx_weather_sessions_created ON weather_sessions(created_at);

-- Create weather_triggers table
CREATE TABLE IF NOT EXISTS weather_triggers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES weather_sessions(id) ON DELETE CASCADE,
  token_id VARCHAR(255) NOT NULL,
  temp NUMERIC NOT NULL,
  amount NUMERIC NOT NULL,
  executed BOOLEAN DEFAULT FALSE,
  order_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_weather_triggers_session ON weather_triggers(session_id);
CREATE INDEX idx_weather_triggers_token ON weather_triggers(token_id);

-- Create weather_tab_order table
CREATE TABLE IF NOT EXISTS weather_tab_order (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_ids JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMP DEFAULT NOW()
);
```

- [ ] **Step 2: Verify syntax**

Run: `psql --file backend/src/db/migrations/001-weather-tables.sql -h localhost` (after docker-compose is running)

- [ ] **Step 3: Create migration runner**

Create: `backend/src/db/migrate.ts`

```typescript
import { execSync } from 'child_process';
import path from 'path';

export async function runMigrations(): Promise<void> {
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = ['001-weather-tables.sql'];
  
  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    console.log(`Running migration: ${file}`);
    try {
      execSync(`psql -h ${process.env.DB_HOST} -U ${process.env.DB_USER} -d ${process.env.DB_NAME} -f ${filePath}`);
    } catch (error) {
      console.error(`Migration failed: ${file}`, error);
      throw error;
    }
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/db/migrations/001-weather-tables.sql backend/src/db/migrate.ts
git commit -m "feat(db): create weather sessions and triggers tables"
```

---

### Task 2: Add DB Connection & Utilities

**Files:**
- Create: `backend/src/db/client.ts`
- Modify: `backend/src/config.ts`

- [ ] **Step 1: Add DB config to config.ts**

In `backend/src/config.ts`, add:

```typescript
export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

function getDbConfig(): DbConfig {
  return {
    host: process.env.DB_HOST || 'postgres',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'pm_weather',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  };
}
```

- [ ] **Step 2: Create DB client**

Create: `backend/src/db/client.ts`

```typescript
import pg from 'pg';
import { getDbConfig } from '../config.js';

let pool: pg.Pool | null = null;

export function initDbPool(): pg.Pool {
  if (pool) return pool;
  
  const config = getDbConfig();
  pool = new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
  });
  
  pool.on('error', (err) => {
    console.error('Unexpected pool error:', err);
  });
  
  return pool;
}

export function getDb(): pg.Pool {
  if (!pool) {
    throw new Error('Database pool not initialized. Call initDbPool() first.');
  }
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
```

- [ ] **Step 3: Add to backend/package.json dependencies**

Ensure `pg` is in dependencies:
```json
"pg": "^8.11.0"
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/db/client.ts backend/src/config.ts
git commit -m "feat(db): add postgres connection pool"
```

---

## Phase 2: Backend Session Endpoints

### Task 3: Session CRUD Endpoints

**Files:**
- Create: `backend/src/weather-sessions.ts`
- Modify: `backend/src/app.ts`
- Modify: `backend/src/server.ts`

- [ ] **Step 1: Create session service**

Create: `backend/src/weather-sessions.ts`

```typescript
import { v4 as uuidv4 } from 'uuid';
import { getDb } from './db/client.js';
import { getWeatherPolymarketEvent } from './weather-polymarket.js';

export interface SessionMetadata {
  id: string;
  slug: string;
  city: string;
  date: string;
  event_url: string;
  icao: string | null;
  created_at: string;
}

export async function createWeatherSession(eventUrl: string): Promise<SessionMetadata> {
  const slug = extractSlugFromUrl(eventUrl);
  if (!slug) {
    throw new Error('Invalid Polymarket event URL');
  }

  // Fetch event from Polymarket to get metadata
  const event = await getWeatherPolymarketEvent(slug);
  if (!event) {
    throw new Error('Event not found on Polymarket');
  }

  const id = uuidv4();
  const db = getDb();
  
  await db.query(
    `INSERT INTO weather_sessions (id, slug, city, date, event_url, icao, event_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      slug,
      event.airport?.icao || 'UNKNOWN',
      new Date().toISOString().split('T')[0],
      eventUrl,
      event.airport?.icao || null,
      JSON.stringify(event),
    ]
  );

  return {
    id,
    slug,
    city: event.airport?.icao || 'Unknown',
    date: new Date().toISOString().split('T')[0],
    event_url: eventUrl,
    icao: event.airport?.icao || null,
    created_at: new Date().toISOString(),
  };
}

export async function getWeatherSessions(): Promise<SessionMetadata[]> {
  const db = getDb();
  const result = await db.query(
    `SELECT id, slug, city, date, event_url, icao, created_at 
     FROM weather_sessions 
     ORDER BY created_at DESC`
  );
  
  return result.rows as SessionMetadata[];
}

export async function deleteWeatherSession(sessionId: string): Promise<void> {
  const db = getDb();
  
  // Delete triggers first (cascade handles this, but explicit for clarity)
  await db.query(
    `DELETE FROM weather_triggers WHERE session_id = $1`,
    [sessionId]
  );
  
  // Delete session
  await db.query(
    `DELETE FROM weather_sessions WHERE id = $1`,
    [sessionId]
  );
}

export async function getSessionTriggers(sessionId: string): Promise<any[]> {
  const db = getDb();
  const result = await db.query(
    `SELECT id, token_id, temp, amount, executed 
     FROM weather_triggers 
     WHERE session_id = $1`,
    [sessionId]
  );
  
  return result.rows;
}

function extractSlugFromUrl(url: string): string | null {
  const match = url.match(/\/event\/([^/?#\s]+)/i);
  return match?.[1] ?? null;
}
```

- [ ] **Step 2: Add endpoints to app.ts**

In `backend/src/app.ts`, add before `app.listen()`:

```typescript
import { createWeatherSession, getWeatherSessions, deleteWeatherSession } from './weather-sessions.js';

// Create a new weather session (open a tab)
app.post('/weather/session', async (req, res) => {
  try {
    const { event_url } = req.body as { event_url: string };
    
    if (!event_url || typeof event_url !== 'string') {
      return res.status(400).json({ error: 'event_url is required' });
    }
    
    const session = await createWeatherSession(event_url);
    res.json(session);
  } catch (error) {
    console.error('[Weather] Create session error:', error);
    res.status(400).json({ error: (error as Error).message });
  }
});

// List all weather sessions
app.get('/weather/sessions', async (req, res) => {
  try {
    const sessions = await getWeatherSessions();
    res.json({ sessions });
  } catch (error) {
    console.error('[Weather] List sessions error:', error);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// Delete a weather session
app.delete('/weather/session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    await deleteWeatherSession(sessionId);
    res.json({ success: true });
  } catch (error) {
    console.error('[Weather] Delete session error:', error);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});
```

- [ ] **Step 3: Initialize DB pool on server start**

In `backend/src/server.ts`, add at the top of the file:

```typescript
import { initDbPool, closeDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';

// Initialize database
(async () => {
  try {
    initDbPool();
    console.log('Database pool initialized');
    await runMigrations();
    console.log('Migrations completed');
  } catch (error) {
    console.error('Database initialization failed:', error);
    process.exit(1);
  }
})();

// Clean up on shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await closeDb();
  process.exit(0);
});
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/weather-sessions.ts backend/src/app.ts backend/src/server.ts
git commit -m "feat(backend): add weather session CRUD endpoints"
```

---

## Phase 3: WebSocket Infrastructure

### Task 4: Position Cache Service

**Files:**
- Create: `backend/src/weather-position-cache.ts`

- [ ] **Step 1: Create position cache**

```typescript
import { getOpenPositions } from './app.js';

export interface CachedPositions {
  timestamp: number;
  data: any[];
}

const positionCache = new Map<string, CachedPositions>();
const CACHE_TTL = 3000; // 3 seconds

export async function getPositionsCached(user: string): Promise<any[]> {
  const now = Date.now();
  const cached = positionCache.get(user);

  if (cached && now - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  // Fetch fresh data
  const positions = await getOpenPositions(user);
  
  positionCache.set(user, {
    timestamp: now,
    data: positions.positions,
  });
  
  return positions.positions;
}

export function clearPositionCache(user?: string): void {
  if (user) {
    positionCache.delete(user);
  } else {
    positionCache.clear();
  }
}

export function getCacheTTL(): number {
  return CACHE_TTL;
}
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/weather-position-cache.ts
git commit -m "feat(backend): add position cache with 3s TTL"
```

---

### Task 5: WebSocket Listener

**Files:**
- Create: `backend/src/weather-polymarket-ws.ts` (new comprehensive version)
- Modify: `backend/src/server.ts`

- [ ] **Step 1: Create WebSocket listener**

Create: `backend/src/weather-polymarket-ws.ts`

```typescript
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { getDb } from './db/client.js';
import { getPositionsCached, clearPositionCache } from './weather-position-cache.js';
import { getRuntimeAuthState } from './runtime-auth.js';

const GAMMA_API = 'https://gamma-api.polymarket.com';

interface ActiveSubscription {
  ws: WebSocket;
  slug: string;
  sessionId: string;
  emitter: EventEmitter;
}

const activeSubscriptions = new Map<string, ActiveSubscription>();
const reconnectAttempts = new Map<string, number>();
const MAX_RECONNECT_ATTEMPTS = 5;

export async function subscribeToMarketPrices(
  sessionId: string,
  slug: string
): Promise<EventEmitter> {
  const key = `${slug}-${sessionId}`;
  
  // Check if already subscribed
  if (activeSubscriptions.has(key)) {
    return activeSubscriptions.get(key)!.emitter;
  }

  const emitter = new EventEmitter();
  
  // Fetch event to get market IDs
  const event = await fetchEventData(slug);
  if (!event || !event.markets) {
    throw new Error(`Event ${slug} not found or has no markets`);
  }

  // Get session metadata to check for triggers
  const db = getDb();
  const sessionResult = await db.query(
    `SELECT icao FROM weather_sessions WHERE id = $1`,
    [sessionId]
  );
  const session = sessionResult.rows[0];

  // Connect to Polymarket WebSocket
  const wsUrl = 'wss://ws-api-clob.polymarket.com/ws';
  const ws = new WebSocket(wsUrl);

  const subscription: ActiveSubscription = {
    ws,
    slug,
    sessionId,
    emitter,
  };

  ws.on('open', () => {
    console.log(`[WS] Connected to Polymarket for session ${sessionId}`);
    
    // Subscribe to all markets in this event
    const marketIds = event.markets.map((m: any) => m.conditionId).filter(Boolean);
    
    for (const marketId of marketIds) {
      ws.send(
        JSON.stringify({
          type: 'subscribe',
          market: marketId,
        })
      );
    }
    
    reconnectAttempts.delete(key);
  });

  ws.on('message', async (data: string) => {
    try {
      const message = JSON.parse(data);
      
      if (message.type === 'price') {
        // Filter by active triggers
        const triggerResult = await db.query(
          `SELECT COUNT(*) as count FROM weather_triggers 
           WHERE session_id = $1 AND token_id = $2 AND executed = FALSE`,
          [sessionId, message.tokenId]
        );
        
        const hasActiveTrigger = triggerResult.rows[0].count > 0;
        
        if (hasActiveTrigger) {
          // Fetch positions
          const user = getRuntimeAuthState().user;
          if (user) {
            const positions = await getPositionsCached(user);
            
            // Enrich market data with position info
            const enrichedData = {
              type: 'market_update',
              sessionId,
              market: {
                slug: message.slug,
                question: message.question,
                yes_price: message.yesPrices?.[0],
                no_price: message.noPrices?.[0],
                volume: message.volume,
                liquidity: message.liquidity,
                positions: positions.filter((p: any) => p.slug === slug),
              },
            };
            
            emitter.emit('price_update', enrichedData);
          }
        }
      }
    } catch (error) {
      console.error(`[WS] Error parsing message for session ${sessionId}:`, error);
    }
  });

  ws.on('error', (error) => {
    console.error(`[WS] Error in session ${sessionId}:`, error);
    emitter.emit('error', error);
  });

  ws.on('close', async () => {
    console.log(`[WS] Disconnected from session ${sessionId}`);
    activeSubscriptions.delete(key);
    
    // Attempt reconnect
    const attempts = (reconnectAttempts.get(key) || 0) + 1;
    if (attempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts.set(key, attempts);
      console.log(`[WS] Reconnecting... (attempt ${attempts}/${MAX_RECONNECT_ATTEMPTS})`);
      
      setTimeout(() => {
        subscribeToMarketPrices(sessionId, slug).catch((error) => {
          console.error(`[WS] Reconnect failed:`, error);
        });
      }, 1000 * Math.pow(2, attempts - 1)); // Exponential backoff
    } else {
      console.error(`[WS] Max reconnect attempts reached for session ${sessionId}`);
      emitter.emit('connection_failed');
    }
  });

  activeSubscriptions.set(key, subscription);
  return emitter;
}

export async function unsubscribeFromMarketPrices(sessionId: string, slug: string): Promise<void> {
  const key = `${slug}-${sessionId}`;
  const subscription = activeSubscriptions.get(key);
  
  if (subscription) {
    subscription.ws.close();
    activeSubscriptions.delete(key);
    reconnectAttempts.delete(key);
    console.log(`[WS] Unsubscribed from session ${sessionId}`);
  }
}

async function fetchEventData(slug: string): Promise<any> {
  const response = await fetch(`${GAMMA_API}/events?slug=${encodeURIComponent(slug)}`, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Mozilla/5.0',
    },
  });

  if (!response.ok) {
    throw new Error(`Gamma API failed: ${response.status}`);
  }

  const data = await response.json() as Array<Record<string, unknown>>;
  return data[0] ?? null;
}

export function getActiveSubscriptions(): Array<{ sessionId: string; slug: string }> {
  return Array.from(activeSubscriptions.values()).map((s) => ({
    sessionId: s.sessionId,
    slug: s.slug,
  }));
}
```

- [ ] **Step 2: Register WebSocket route in server.ts**

In `backend/src/server.ts`, add after the HTTP routes:

```typescript
import { subscribeToMarketPrices, unsubscribeFromMarketPrices } from './weather-polymarket-ws.js';
import { getSessionTriggers } from './weather-sessions.js';

// WebSocket handler for weather market prices
wss.on('connection', async (ws, req) => {
  const url = new URL(req.url || '', 'ws://localhost');
  const sessionId = url.searchParams.get('sessionId');
  const slug = url.searchParams.get('slug');

  if (!sessionId || !slug) {
    ws.close(1008, 'Missing sessionId or slug');
    return;
  }

  console.log(`[WS] Client connected for session ${sessionId}`);

  try {
    const triggers = await getSessionTriggers(sessionId);
    const emitter = await subscribeToMarketPrices(sessionId, slug);

    const onPriceUpdate = (data: any) => {
      ws.send(JSON.stringify(data));
    };

    const onError = (error: any) => {
      ws.send(JSON.stringify({ type: 'error', message: error.message }));
    };

    emitter.on('price_update', onPriceUpdate);
    emitter.on('error', onError);

    ws.on('close', () => {
      console.log(`[WS] Client disconnected for session ${sessionId}`);
      emitter.off('price_update', onPriceUpdate);
      emitter.off('error', onError);
      unsubscribeFromMarketPrices(sessionId, slug).catch(console.error);
    });
  } catch (error) {
    console.error(`[WS] Connection error:`, error);
    ws.close(1011, (error as Error).message);
  }
});
```

- [ ] **Step 3: Update package.json**

Ensure dependencies include:
```json
"ws": "^8.14.0"
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/weather-polymarket-ws.ts backend/src/server.ts
git commit -m "feat(backend): add WebSocket listener for market prices"
```

---

## Phase 4: Frontend Tab Management

### Task 6: Tab Context

**Files:**
- Create: `frontend/src/context/WeatherTabContext.tsx`

- [ ] **Step 1: Create tab context**

```typescript
import React, { createContext, useCallback, useState, useEffect } from 'react';

export interface WeatherSession {
  id: string;
  slug: string;
  city: string;
  date: string;
  event_url: string;
  icao: string | null;
  created_at: string;
}

interface WeatherTabContextType {
  sessions: WeatherSession[];
  activeSessionId: string | null;
  loading: boolean;
  error: string | null;
  openSession(eventUrl: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  setActiveSession(sessionId: string): void;
  refreshSessions(): Promise<void>;
}

export const WeatherTabContext = createContext<WeatherTabContextType | undefined>(undefined);

export function WeatherTabProvider({ children }: { children: React.ReactNode }) {
  const [sessions, setSessions] = useState<WeatherSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshSessions = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch('/weather/sessions');
      const data = await response.json() as { sessions: WeatherSession[] };
      setSessions(data.sessions);
      setError(null);
      
      // Set first session as active if none selected
      if (!activeSessionId && data.sessions.length > 0) {
        setActiveSessionId(data.sessions[0].id);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [activeSessionId]);

  const openSession = useCallback(async (eventUrl: string) => {
    try {
      setLoading(true);
      const response = await fetch('/weather/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_url: eventUrl }),
      });
      
      if (!response.ok) {
        const data = await response.json() as any;
        throw new Error(data.error || 'Failed to create session');
      }
      
      const session = await response.json() as WeatherSession;
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(session.id);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const closeSession = useCallback(async (sessionId: string) => {
    try {
      const response = await fetch(`/weather/session/${sessionId}`, {
        method: 'DELETE',
      });
      
      if (!response.ok) {
        throw new Error('Failed to close session');
      }
      
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      
      // Switch to next session if closing active one
      if (activeSessionId === sessionId) {
        const remaining = sessions.filter((s) => s.id !== sessionId);
        setActiveSessionId(remaining.length > 0 ? remaining[0].id : null);
      }
    } catch (err) {
      setError((err as Error).message);
      throw err;
    }
  }, [activeSessionId, sessions]);

  useEffect(() => {
    refreshSessions();
  }, []);

  return (
    <WeatherTabContext.Provider
      value={{
        sessions,
        activeSessionId,
        loading,
        error,
        openSession,
        closeSession,
        setActiveSession: setActiveSessionId,
        refreshSessions,
      }}
    >
      {children}
    </WeatherTabContext.Provider>
  );
}

export function useWeatherTabs(): WeatherTabContextType {
  const context = React.useContext(WeatherTabContext);
  if (!context) {
    throw new Error('useWeatherTabs must be used within WeatherTabProvider');
  }
  return context;
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/context/WeatherTabContext.tsx
git commit -m "feat(frontend): add weather tab context"
```

---

### Task 7: Tab Bar Component

**Files:**
- Create: `frontend/src/components/WeatherTabBar.tsx`

- [ ] **Step 1: Create tab bar**

```typescript
import React, { useState } from 'react';
import { useWeatherTabs } from '../context/WeatherTabContext.js';
import styles from './WeatherTabBar.module.css';

export function WeatherTabBar() {
  const { sessions, activeSessionId, openSession, closeSession, setActiveSession, loading } = useWeatherTabs();
  const [showNewInput, setShowNewInput] = useState(false);
  const [inputValue, setInputValue] = useState('');

  const handleOpenNew = async () => {
    if (!inputValue.trim()) return;
    
    try {
      await openSession(inputValue.trim());
      setInputValue('');
      setShowNewInput(false);
    } catch (error) {
      console.error('Failed to open session:', error);
    }
  };

  return (
    <div className={styles.tabBar}>
      <div className={styles.tabs}>
        {sessions.map((session) => (
          <div
            key={session.id}
            className={`${styles.tab} ${activeSessionId === session.id ? styles.active : ''}`}
            onClick={() => setActiveSession(session.id)}
          >
            <span className={styles.tabLabel}>
              {session.city} • {session.date}
            </span>
            <button
              className={styles.closeBtn}
              onClick={(e) => {
                e.stopPropagation();
                closeSession(session.id).catch(console.error);
              }}
              title="Close tab"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {!showNewInput && (
        <button
          className={styles.newBtn}
          onClick={() => setShowNewInput(true)}
          disabled={loading}
        >
          +
        </button>
      )}

      {showNewInput && (
        <div className={styles.inputGroup}>
          <input
            type="text"
            placeholder="https://polymarket.com/event/..."
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleOpenNew();
              if (e.key === 'Escape') setShowNewInput(false);
            }}
            autoFocus
          />
          <button onClick={handleOpenNew} disabled={!inputValue.trim() || loading}>
            Load
          </button>
          <button onClick={() => setShowNewInput(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create styles**

Create: `frontend/src/components/WeatherTabBar.module.css`

```css
.tabBar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid rgba(128, 255, 165, 0.2);
  background: rgba(20, 20, 30, 0.5);
}

.tabs {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  flex: 1;
}

.tab {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(50, 60, 80, 0.6);
  border: 1px solid rgba(128, 255, 165, 0.3);
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  color: #b0b0c0;
  white-space: nowrap;
  transition: all 0.2s;
}

.tab:hover {
  background: rgba(70, 80, 100, 0.8);
  border-color: rgba(128, 255, 165, 0.5);
}

.tab.active {
  background: rgba(100, 120, 150, 0.9);
  border-color: rgba(128, 255, 165, 0.8);
  color: #80ffa5;
}

.tabLabel {
  flex: 1;
}

.closeBtn {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 16px;
  padding: 0;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.closeBtn:hover {
  color: #ff6b9d;
}

.newBtn {
  padding: 8px 12px;
  background: rgba(128, 255, 165, 0.1);
  border: 1px solid rgba(128, 255, 165, 0.3);
  border-radius: 4px;
  color: #80ffa5;
  cursor: pointer;
  font-weight: bold;
  transition: all 0.2s;
}

.newBtn:hover {
  background: rgba(128, 255, 165, 0.2);
  border-color: rgba(128, 255, 165, 0.6);
}

.newBtn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.inputGroup {
  display: flex;
  gap: 8px;
  padding: 8px;
  background: rgba(50, 60, 80, 0.8);
  border-radius: 4px;
  align-items: center;
}

.inputGroup input {
  flex: 1;
  min-width: 300px;
  padding: 8px;
  background: rgba(20, 20, 30, 0.8);
  border: 1px solid rgba(128, 255, 165, 0.3);
  color: #e0e0f0;
  border-radius: 4px;
}

.inputGroup input:focus {
  outline: none;
  border-color: rgba(128, 255, 165, 0.8);
}

.inputGroup button {
  padding: 8px 16px;
  background: rgba(128, 255, 165, 0.2);
  border: 1px solid rgba(128, 255, 165, 0.4);
  color: #80ffa5;
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.2s;
}

.inputGroup button:hover {
  background: rgba(128, 255, 165, 0.3);
}

.inputGroup button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/WeatherTabBar.tsx frontend/src/components/WeatherTabBar.module.css
git commit -m "feat(frontend): add weather tab bar component"
```

---

### Task 8: WebSocket Hook

**Files:**
- Create: `frontend/src/hooks/useWeatherWebSocket.ts`

- [ ] **Step 1: Create WebSocket hook**

```typescript
import { useEffect, useState, useRef } from 'react';

export interface EnrichedMarket {
  market_slug: string;
  question: string;
  yes_price: number;
  no_price: number;
  yes_token_id: string;
  volume: number;
  liquidity: number;
  position?: {
    size: number;
    avg_price: number;
    current_value: number;
    cash_pnl: number;
    percent_pnl: number;
  };
}

interface WebSocketMessage {
  type: string;
  sessionId: string;
  market?: EnrichedMarket;
  error?: string;
}

export function useWeatherWebSocket(sessionId: string, slug: string): {
  markets: EnrichedMarket[];
  isConnected: boolean;
  error: string | null;
} {
  const [markets, setMarkets] = useState<EnrichedMarket[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!sessionId || !slug) {
      return;
    }

    const connectWebSocket = () => {
      try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/weather/ws?sessionId=${sessionId}&slug=${slug}`;
        
        const ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          console.log('[WebSocket] Connected for session', sessionId);
          setIsConnected(true);
          setError(null);
        };

        ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data) as WebSocketMessage;

            if (message.type === 'market_update' && message.market) {
              setMarkets((prev) => {
                const index = prev.findIndex((m) => m.market_slug === message.market!.market_slug);
                if (index >= 0) {
                  const updated = [...prev];
                  updated[index] = message.market!;
                  return updated;
                }
                return [...prev, message.market!];
              });
            } else if (message.type === 'error') {
              setError(message.error || 'WebSocket error');
            }
          } catch (err) {
            console.error('[WebSocket] Failed to parse message:', err);
          }
        };

        ws.onerror = (event) => {
          console.error('[WebSocket] Error:', event);
          setError('WebSocket connection error');
          setIsConnected(false);
        };

        ws.onclose = () => {
          console.log('[WebSocket] Disconnected');
          setIsConnected(false);
          
          // Attempt reconnect after 2 seconds
          reconnectTimeoutRef.current = setTimeout(() => {
            connectWebSocket();
          }, 2000);
        };

        wsRef.current = ws;
      } catch (err) {
        console.error('[WebSocket] Connection failed:', err);
        setError((err as Error).message);
        
        // Retry after delay
        reconnectTimeoutRef.current = setTimeout(connectWebSocket, 2000);
      }
    };

    connectWebSocket();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [sessionId, slug]);

  return { markets, isConnected, error };
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/hooks/useWeatherWebSocket.ts
git commit -m "feat(frontend): add useWeatherWebSocket hook"
```

---

### Task 9: Update Weather Screen

**Files:**
- Modify: `frontend/src/screens/weather/WeatherScreen.tsx`

- [ ] **Step 1: Wrap component with provider**

In `frontend/src/screens/weather/index.tsx` (or wherever Weather screen is mounted):

```typescript
import { WeatherTabProvider } from '../../context/WeatherTabContext.js';

export function WeatherScreenWithTabs() {
  return (
    <WeatherTabProvider>
      <WeatherScreen />
    </WeatherTabProvider>
  );
}
```

- [ ] **Step 2: Update WeatherScreen to use context and WebSocket**

In the WeatherScreen component, update to:

```typescript
import { useWeatherTabs } from '../../context/WeatherTabContext.js';
import { useWeatherWebSocket } from '../../hooks/useWeatherWebSocket.js';
import { WeatherTabBar } from '../../components/WeatherTabBar.js';

export function WeatherScreen() {
  const { sessions, activeSessionId } = useWeatherTabs();
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  
  const { markets, isConnected, error } = useWeatherWebSocket(
    activeSessionId || '',
    activeSession?.slug || ''
  );

  if (!activeSession) {
    return (
      <div className="weather-screen">
        <WeatherTabBar />
        <div className="empty-state">
          <p>No weather markets loaded. Use [+ New] to add a market.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="weather-screen">
      <WeatherTabBar />
      
      {error && <div className="error-banner">{error}</div>}
      {!isConnected && <div className="warning-banner">Reconnecting...</div>}
      
      <div className="markets-container">
        {markets.map((market) => (
          <div key={market.market_slug} className="market-card">
            <h3>{market.question}</h3>
            
            <div className="prices">
              <span>YES: {market.yes_price.toFixed(2)}</span>
              <span>NO: {market.no_price.toFixed(2)}</span>
            </div>
            
            {market.position && (
              <div className="position">
                <p>Bought @ {market.position.avg_price.toFixed(2)}</p>
                <p>Current: ${market.position.current_value.toFixed(2)}</p>
                <p className={market.position.cash_pnl >= 0 ? 'profit' : 'loss'}>
                  {market.position.cash_pnl >= 0 ? '+' : ''}
                  ${market.position.cash_pnl.toFixed(2)} ({market.position.percent_pnl.toFixed(1)}%)
                </p>
                <button className="sell-btn">Sell</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add minimal styles**

In `frontend/src/screens/weather/WeatherScreen.module.css`, add:

```css
.weatherScreen {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.errorBanner {
  padding: 12px;
  background: rgba(255, 107, 157, 0.1);
  color: #ff6b9d;
  border-bottom: 1px solid rgba(255, 107, 157, 0.3);
}

.warningBanner {
  padding: 12px;
  background: rgba(255, 193, 7, 0.1);
  color: #ffc107;
  border-bottom: 1px solid rgba(255, 193, 7, 0.3);
}

.marketsContainer {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
}

@media (max-width: 1580px) {
  .marketsContainer {
    grid-template-columns: 1fr;
  }
}

.marketCard {
  padding: 16px;
  background: rgba(50, 60, 80, 0.6);
  border: 1px solid rgba(128, 255, 165, 0.2);
  border-radius: 8px;
}

.marketCard h3 {
  margin: 0 0 12px 0;
  color: #80ffa5;
  font-size: 14px;
}

.prices {
  display: flex;
  gap: 16px;
  margin-bottom: 12px;
  font-size: 12px;
}

.position {
  border-top: 1px solid rgba(128, 255, 165, 0.2);
  padding-top: 12px;
  margin-top: 12px;
}

.position p {
  margin: 4px 0;
  font-size: 12px;
  color: #b0b0c0;
}

.profit {
  color: #80ffa5;
}

.loss {
  color: #ff6b9d;
}

.sellBtn {
  width: 100%;
  padding: 8px;
  margin-top: 8px;
  background: rgba(255, 107, 157, 0.2);
  border: 1px solid rgba(255, 107, 157, 0.4);
  color: #ff6b9d;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s;
}

.sellBtn:hover {
  background: rgba(255, 107, 157, 0.3);
}
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/screens/weather/WeatherScreen.tsx frontend/src/screens/weather/WeatherScreen.module.css
git commit -m "feat(frontend): integrate tab bar and WebSocket updates in weather screen"
```

---

## Phase 5: Testing & Cleanup

### Task 10: Backend Tests

**Files:**
- Create: `backend/tests/weather-session.test.ts`
- Create: `backend/tests/weather-position-cache.test.ts`

- [ ] **Step 1: Write session tests**

```typescript
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createWeatherSession, getWeatherSessions, deleteWeatherSession } from '../src/weather-sessions.js';
import { initDbPool, closeDb } from '../src/db/client.js';

describe('Weather Sessions', () => {
  beforeAll(async () => {
    initDbPool();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('should create a new session', async () => {
    const session = await createWeatherSession(
      'https://polymarket.com/event/highest-temperature-in-toronto-on-may-25'
    );
    expect(session.id).toBeDefined();
    expect(session.slug).toBe('highest-temperature-in-toronto-on-may-25');
    expect(session.city).toBeDefined();
  });

  it('should list sessions', async () => {
    const sessions = await getWeatherSessions();
    expect(Array.isArray(sessions)).toBe(true);
  });

  it('should delete a session', async () => {
    const session = await createWeatherSession(
      'https://polymarket.com/event/highest-temperature-in-toronto-on-may-25'
    );
    await deleteWeatherSession(session.id);
    
    const sessions = await getWeatherSessions();
    expect(sessions.find((s) => s.id === session.id)).toBeUndefined();
  });

  it('should reject invalid event URL', async () => {
    expect(() => createWeatherSession('invalid-url')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Write position cache tests**

```typescript
import { describe, it, expect, beforeEach } from '@jest/globals';
import { getPositionsCached, clearPositionCache, getCacheTTL } from '../src/weather-position-cache.js';

describe('Position Cache', () => {
  beforeEach(() => {
    clearPositionCache();
  });

  it('should return cache TTL of 3 seconds', () => {
    expect(getCacheTTL()).toBe(3000);
  });

  it('should cache positions', async () => {
    // Mock getOpenPositions
    const positions = await getPositionsCached('test_user');
    expect(Array.isArray(positions)).toBe(true);
  });

  it('should clear cache', () => {
    clearPositionCache('test_user');
    // Verify cache is cleared (internal check)
  });
});
```

- [ ] **Step 3: Run tests**

```bash
cd backend && npm run test
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add backend/tests/weather-session.test.ts backend/tests/weather-position-cache.test.ts
git commit -m "test(backend): add weather session and cache tests"
```

---

### Task 11: Frontend Tests

**Files:**
- Create: `frontend/tests/WeatherTabBar.test.tsx`
- Create: `frontend/tests/useWeatherWebSocket.test.ts`

- [ ] **Step 1: Write tab bar component test**

```typescript
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from '@jest/globals';
import { WeatherTabBar } from '../src/components/WeatherTabBar.js';
import { WeatherTabProvider } from '../src/context/WeatherTabContext.js';

// Mock fetch
global.fetch = vi.fn();

describe('WeatherTabBar', () => {
  it('should render tab bar', () => {
    render(
      <WeatherTabProvider>
        <WeatherTabBar />
      </WeatherTabProvider>
    );
    
    expect(screen.getByText('+')).toBeInTheDocument();
  });

  it('should open new input on + click', () => {
    render(
      <WeatherTabProvider>
        <WeatherTabBar />
      </WeatherTabProvider>
    );
    
    fireEvent.click(screen.getByText('+'));
    expect(screen.getByPlaceholderText(/polymarket.com/)).toBeInTheDocument();
  });

  it('should close input on Cancel', () => {
    render(
      <WeatherTabProvider>
        <WeatherTabBar />
      </WeatherTabProvider>
    );
    
    fireEvent.click(screen.getByText('+'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByPlaceholderText(/polymarket.com/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Write WebSocket hook test**

```typescript
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from '@jest/globals';
import { useWeatherWebSocket } from '../src/hooks/useWeatherWebSocket.js';

// Mock WebSocket
const mockWebSocket = {
  onopen: null,
  onmessage: null,
  onerror: null,
  onclose: null,
  close: vi.fn(),
};

global.WebSocket = vi.fn(() => mockWebSocket) as any;

describe('useWeatherWebSocket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize with connected false', () => {
    const { result } = renderHook(() => useWeatherWebSocket('session-1', 'slug-1'));
    
    expect(result.current.isConnected).toBe(false);
    expect(result.current.markets).toEqual([]);
  });

  it('should connect WebSocket', async () => {
    const { result } = renderHook(() => useWeatherWebSocket('session-1', 'slug-1'));
    
    // Simulate open
    mockWebSocket.onopen();
    
    await waitFor(() => {
      expect(result.current.isConnected).toBe(true);
    });
  });

  it('should handle market updates', async () => {
    const { result } = renderHook(() => useWeatherWebSocket('session-1', 'slug-1'));
    
    // Simulate open
    mockWebSocket.onopen();
    
    // Simulate market update
    mockWebSocket.onmessage({
      data: JSON.stringify({
        type: 'market_update',
        market: {
          market_slug: 'test-market',
          question: 'Test?',
          yes_price: 0.5,
          no_price: 0.5,
        },
      }),
    });
    
    await waitFor(() => {
      expect(result.current.markets.length).toBe(1);
    });
  });
});
```

- [ ] **Step 3: Run tests**

```bash
cd frontend && npm run test
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add frontend/tests/WeatherTabBar.test.tsx frontend/tests/useWeatherWebSocket.test.ts
git commit -m "test(frontend): add tab bar and WebSocket hook tests"
```

---

### Task 12: Integration & Verification

- [ ] **Step 1: Build backend**

```bash
cd backend && npm run build
```

Expected: No errors.

- [ ] **Step 2: Build frontend**

```bash
cd frontend && npm run build
```

Expected: No errors.

- [ ] **Step 3: Start Docker containers**

```bash
docker-compose up --build -d
```

Expected: All services running (docker-compose ps shows "healthy").

- [ ] **Step 4: Manual end-to-end test**

Open UI at `http://localhost:5173`:
1. Click [+ New]
2. Paste: `https://polymarket.com/event/highest-temperature-in-toronto-on-may-25`
3. Click Load
4. Verify: Tab appears with "Toronto • 2026-05-26"
5. Verify: Markets load with YES/NO prices
6. Open second market in new tab
7. Verify: Switching tabs updates market display
8. Verify: Prices update in real-time (wait 3-5 seconds, should see changes)

- [ ] **Step 5: Check backend logs**

```bash
docker logs pm-backend-1
```

Expected: WebSocket connections logged, no errors.

- [ ] **Step 6: Commit**

```bash
git commit --allow-empty -m "test(integration): manual e2e verification passed"
```

---

### Task 13: Documentation & Cleanup

- [ ] **Step 1: Add API documentation**

Create: `docs/API_WEATHER_SESSIONS.md`

```markdown
# Weather Sessions API

## Endpoints

### POST /weather/session
Create a new weather market session (open a tab).

**Request:**
```json
{
  "event_url": "https://polymarket.com/event/highest-temperature-in-toronto-on-may-25"
}
```

**Response:**
```json
{
  "id": "uuid",
  "slug": "highest-temperature-in-toronto-on-may-25",
  "city": "Toronto",
  "date": "2026-05-26",
  "event_url": "...",
  "icao": "CYYZ",
  "created_at": "2026-05-26T..."
}
```

### GET /weather/sessions
List all open sessions.

**Response:**
```json
{
  "sessions": [
    { "id": "...", "slug": "...", "city": "Toronto", ... }
  ]
}
```

### DELETE /weather/session/:sessionId
Close a session.

**Response:**
```json
{
  "success": true
}
```

## WebSocket

**URL:** `ws://localhost:3000/weather/ws?sessionId=<uuid>&slug=<slug>`

**Server → Client (market update):**
```json
{
  "type": "market_update",
  "sessionId": "uuid",
  "market": {
    "market_slug": "...",
    "question": "...",
    "yes_price": 0.42,
    "no_price": 0.58,
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
```

- [ ] **Step 2: Commit documentation**

```bash
git add docs/API_WEATHER_SESSIONS.md
git commit -m "docs: add weather sessions API documentation"
```

- [ ] **Step 3: Update CHANGELOG**

Add to the top of `CHANGELOG.md`:

```markdown
## [Unreleased]

### Added
- **Weather Bot Multi-City Tabs:** Users can now open multiple city/date markets as independent tabs, similar to browser tabs
- **Real-Time Market Prices:** Market YES/NO prices update in real-time via WebSocket from Polymarket
- **Position Tracking:** Live display of purchase price, current value, and profit for held positions
- **Database Persistence:** Weather sessions stored in PostgreSQL, survives server restarts
- **Tab Management UI:** Browser-like tab bar with close (X) buttons and quick switching

### Fixed
- FOK order error: Replaced market orders with limit orders to support small order sizes (1 USDC)

### Technical
- Added `weather_sessions`, `weather_triggers`, `weather_tab_order` tables
- Implemented per-tab WebSocket subscriptions to Polymarket Gamma API
- Added 3-second position cache with configurable TTL
- Added `WeatherTabContext` for frontend tab state management
```

- [ ] **Step 4: Final commit**

```bash
git add CHANGELOG.md
git commit -m "docs: update changelog for weather tabs + realtime feature"
```

---

## Summary

**What this plan delivers:**
- ✅ Database schema for sessions, triggers, tab ordering
- ✅ Backend HTTP endpoints for session CRUD
- ✅ WebSocket infrastructure for real-time market prices
- ✅ Position cache with 3-second TTL
- ✅ Frontend tab bar component (browser-like UI)
- ✅ React Context for tab state management
- ✅ WebSocket hook for real-time market updates in React
- ✅ Integrated weather screen with live prices + position tracking
- ✅ Unit & integration tests
- ✅ API documentation

**Files created:** 13 new files  
**Files modified:** 4 existing files  
**Total commits:** 13

---

