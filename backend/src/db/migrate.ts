import { getDb } from './client.js';

const WEATHER_SCHEMA = `
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

CREATE INDEX IF NOT EXISTS idx_weather_sessions_slug ON weather_sessions(slug);
CREATE INDEX IF NOT EXISTS idx_weather_sessions_created ON weather_sessions(created_at);

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

CREATE INDEX IF NOT EXISTS idx_weather_triggers_session ON weather_triggers(session_id);
CREATE INDEX IF NOT EXISTS idx_weather_triggers_token ON weather_triggers(token_id);

-- Add exit tracking columns (idempotent)
ALTER TABLE weather_triggers ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ;
ALTER TABLE weather_triggers ADD COLUMN IF NOT EXISTS closed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE weather_triggers ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE weather_triggers ADD COLUMN IF NOT EXISTS exit_price NUMERIC NOT NULL DEFAULT 0.99;
ALTER TABLE weather_triggers ADD COLUMN IF NOT EXISTS exit_minutes INTEGER NOT NULL DEFAULT 10;

-- Create weather_tab_order table
CREATE TABLE IF NOT EXISTS weather_tab_order (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_ids JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMP DEFAULT NOW()
);
`;

export async function runMigrations(): Promise<void> {
  const db = getDb();

  console.log(`[DB] Running migration: weather_schema`);
  try {
    await db.query(WEATHER_SCHEMA);
    console.log(`[DB] Migration completed: weather_schema`);
  } catch (error) {
    console.error(`[DB] Migration failed: weather_schema`, error);
    throw error;
  }
}
