/**
 * Background service: polls temperature and checks triggers for ALL sessions
 * with unexecuted triggers, regardless of whether a browser is connected.
 * Runs every 30 seconds after server startup.
 */

import { getDb } from './db/client.js';

const POLL_INTERVAL_MS = 30_000;

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startWeatherBackgroundService(): void {
  if (intervalId) return;

  console.log('[WeatherBg] Starting background trigger service');

  // Run immediately, then every 30s
  void runCheck();
  intervalId = setInterval(() => void runCheck(), POLL_INTERVAL_MS);
}

export function stopWeatherBackgroundService(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[WeatherBg] Stopped background trigger service');
  }
}

async function runCheck(): Promise<void> {
  const db = getDb();

  // Find all sessions that have unexecuted triggers and have an ICAO
  const sessionsResult = await db.query<{ session_id: string; icao: string }>(
    `SELECT DISTINCT wt.session_id, ws.icao
     FROM weather_triggers wt
     JOIN weather_sessions ws ON ws.id = wt.session_id
     WHERE wt.executed = FALSE AND ws.icao IS NOT NULL`
  );

  if (sessionsResult.rows.length === 0) return;

  // Group by ICAO to avoid fetching temperature multiple times for same station
  const icaoToSessions = new Map<string, string[]>();
  for (const row of sessionsResult.rows) {
    const list = icaoToSessions.get(row.icao) ?? [];
    list.push(row.session_id);
    icaoToSessions.set(row.icao, list);
  }

  const { getCurrentTemperature } = await import('./weather-polymarket.js');
  const { placeMarketOrder } = await import('./app.js');

  for (const [icao, sessionIds] of icaoToSessions) {
    // Detect unit from first trigger's market question for this ICAO
    const unitHint = await detectUnitForIcao(icao);

    let weather: Awaited<ReturnType<typeof getCurrentTemperature>>;
    try {
      weather = await getCurrentTemperature(icao, unitHint);
    } catch {
      weather = null;
    }

    if (!weather) {
      console.warn(`[WeatherBg] No temperature data for ${icao}`);
      continue;
    }

    console.log(`[WeatherBg] ${icao}: ${weather.rounded_native}°${weather.unit}`);

    // Push to any connected browser tab
    const { pushTemperatureUpdate } = await import('./weather-polymarket-ws.js');
    for (const sessionId of sessionIds) {
      pushTemperatureUpdate(sessionId, weather);
    }

    for (const sessionId of sessionIds) {
      const triggers = await db.query(
        `SELECT id, token_id, temp, amount
         FROM weather_triggers
         WHERE session_id = $1 AND executed = FALSE`,
        [sessionId]
      );

      for (const trigger of triggers.rows) {
        const triggerTemp = Number(trigger.temp);
        if (weather.rounded_native >= triggerTemp) {
          try {
            await placeMarketOrder({
              tokenId: trigger.token_id,
              side: 'buy',
              amount: Number(trigger.amount),
              tickSize: '0.01',
            });
            await db.query(
              `UPDATE weather_triggers SET executed = TRUE WHERE id = $1`,
              [trigger.id]
            );
            console.log(
              `[WeatherBg] ✓ Trigger executed — session ${sessionId}, ${weather.rounded_native}°${weather.unit} >= ${triggerTemp}°${weather.unit}, token ${trigger.token_id}`
            );
          } catch (err) {
            console.error(`[WeatherBg] Failed to execute trigger ${trigger.id}:`, (err as Error).message);
          }
        }
      }
    }
  }
}

async function detectUnitForIcao(icao: string): Promise<'F' | 'C'> {
  try {
    const db = getDb();
    // Look at event_data markets for any session with this ICAO
    const result = await db.query<{ event_data: any }>(
      `SELECT event_data FROM weather_sessions WHERE icao = $1 AND event_data IS NOT NULL LIMIT 1`,
      [icao]
    );
    const markets: any[] = result.rows[0]?.event_data?.markets ?? [];
    for (const m of markets) {
      if (/°F/i.test(m.question ?? '')) return 'F';
      if (/°C/i.test(m.question ?? '')) return 'C';
    }
  } catch {
    // ignore
  }
  return 'C';
}
