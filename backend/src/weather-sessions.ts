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

  const id = uuidv4();
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const canonicalUrl = `https://polymarket.com/event/${slug}`;

  // Save session immediately — event data will be loaded by the frontend
  await db.query(
    `INSERT INTO weather_sessions (id, slug, city, date, event_url, icao, event_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, slug, slug, today, canonicalUrl, null, null]
  );

  // Try to enrich with event metadata in the background (non-blocking)
  getWeatherPolymarketEvent(slug)
    .then(async (event) => {
      if (!event) return;
      const icao = event.airport?.icao ?? null;
      const city = extractCityName(event.title, event.airport?.name, icao, slug);
      await db.query(
        `UPDATE weather_sessions SET city = $1, icao = $2, event_data = $3, updated_at = NOW() WHERE id = $4`,
        [city, icao, JSON.stringify(event), id]
      );
    })
    .catch((err) => {
      console.warn(`[Session] Background event fetch failed for ${slug}:`, (err as Error).message);
    });

  return {
    id,
    slug,
    city: slug,
    date: today,
    event_url: canonicalUrl,
    icao: null,
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

export function extractCityName(
  title: string,
  airportName: string | null | undefined,
  icao: string | null,
  slug: string
): string {
  // "Highest temperature in London on May 26?" → "London"
  const titleMatch = title.match(/\bin\s+(.+?)\s+on\s/i);
  if (titleMatch?.[1]) return titleMatch[1].trim();

  // "London City Airport" → "London City"
  if (airportName) {
    const stripped = airportName
      .replace(/\s+(?:Intl|International)\s+Airport.*$/i, '')
      .replace(/\s+Airport.*$/i, '')
      .trim();
    if (stripped) return stripped;
  }

  return icao ?? slug;
}
