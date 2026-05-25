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
  const icao = event.airport?.icao || 'UNKNOWN';
  const today = new Date().toISOString().split('T')[0];

  await db.query(
    `INSERT INTO weather_sessions (id, slug, city, date, event_url, icao, event_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      slug,
      icao,
      today,
      eventUrl,
      icao === 'UNKNOWN' ? null : icao,
      JSON.stringify(event),
    ]
  );

  return {
    id,
    slug,
    city: icao,
    date: today,
    event_url: eventUrl,
    icao: icao === 'UNKNOWN' ? null : icao,
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
  await db.query(`DELETE FROM weather_triggers WHERE session_id = $1`, [sessionId]);

  // Delete session
  await db.query(`DELETE FROM weather_sessions WHERE id = $1`, [sessionId]);
}

export async function getSessionTriggers(sessionId: string): Promise<Array<{
  id: string;
  token_id: string;
  temp: number;
  amount: number;
  executed: boolean;
}>> {
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
