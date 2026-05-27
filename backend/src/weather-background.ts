/**
 * Background service: polls temperature and checks triggers for ALL sessions
 * with unexecuted triggers, regardless of whether a browser is connected.
 * Runs every 30 seconds after server startup.
 *
 * fireTriggersForSession() is also exported so the weather API endpoint
 * can call it immediately when it fetches fresh temperature data.
 */

import { getDb } from './db/client.js';

const POLL_INTERVAL_MS = 30_000;

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startWeatherBackgroundService(): void {
  if (intervalId) return;
  console.log('[WeatherBg] Starting background trigger service');
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

/**
 * Called immediately after receiving fresh temperature data for an ICAO
 * (both from background poll and from the weather API endpoint / Refresh button).
 */
export async function fireTriggersForIcao(
  icao: string,
  weather: { rounded_native: number; unit: string }
): Promise<void> {
  const db = getDb();

  const sessionsResult = await db.query<{ session_id: string }>(
    `SELECT DISTINCT wt.session_id
     FROM weather_triggers wt
     JOIN weather_sessions ws ON ws.id = wt.session_id
     WHERE wt.executed = FALSE AND ws.icao = $1`,
    [icao]
  );

  if (sessionsResult.rows.length === 0) return;

  const { placeMarketOrder } = await import('./app.js');

  for (const { session_id: sessionId } of sessionsResult.rows) {
    const triggers = await db.query(
      `SELECT id, token_id, temp, amount, exit_price, exit_minutes, buy_prev_no, is_boundary
       FROM weather_triggers
       WHERE session_id = $1 AND executed = FALSE`,
      [sessionId]
    );

    for (const trigger of triggers.rows) {
      const triggerTemp = Number(trigger.temp);
      const shouldFire = trigger.is_boundary
        ? weather.rounded_native >= triggerTemp   // "37°C or higher" — fires at 37, 38, 39…
        : weather.rounded_native === triggerTemp; // exact market — only fires at exactly this temp
      if (shouldFire) {
        console.log(
          `[WeatherBg] Firing trigger: ${weather.rounded_native}°${weather.unit} ${trigger.is_boundary ? ">=" : "==="} ${triggerTemp}°, session=${sessionId}`
        );
        try {
          await placeMarketOrder({
            tokenId: trigger.token_id,
            side: 'buy',
            amount: Number(trigger.amount),
            tickSize: '0.01',
          });
          const executedAt = new Date();
          await db.query(
            `UPDATE weather_triggers SET executed = TRUE, executed_at = $2 WHERE id = $1`,
            [trigger.id, executedAt]
          );
          console.log(`[WeatherBg] ✓ Bought — trigger ${trigger.id}`);

          const { addPosition } = await import('./weather-position-monitor.js');
          addPosition({
            triggerId: trigger.id,
            sessionId,
            tokenId: trigger.token_id,
            executedAt,
            exitPrice: Number(trigger.exit_price),
            exitMinutes: Number(trigger.exit_minutes),
          });

          // Also buy NO on the previous (lower) temperature market (if enabled for this trigger)
          if (trigger.buy_prev_no !== false) try {
            const sessionData = await db.query(
              `SELECT event_data FROM weather_sessions WHERE id = $1`,
              [sessionId]
            );
            const markets: any[] = sessionData.rows[0]?.event_data?.markets ?? [];
            const sortedMarkets = markets
              .map((m: any) => ({
                ...m,
                parsedTemp: parseFloat(m.question?.match(/(\d+(?:\.\d+)?)\s*°/)?.[1] ?? 'NaN'),
              }))
              .filter((m: any) => !isNaN(m.parsedTemp))
              .sort((a: any, b: any) => a.parsedTemp - b.parsedTemp);

            const triggerIdx = sortedMarkets.findIndex((m: any) =>
              Array.isArray(m.clobTokenIds) && m.clobTokenIds.includes(trigger.token_id)
            );

            if (triggerIdx > 0) {
              const prevMarket = sortedMarkets[triggerIdx - 1];
              const noTokenId = prevMarket.clobTokenIds?.[1]; // index 1 = NO token
              if (noTokenId) {
                await placeMarketOrder({
                  tokenId: noTokenId,
                  side: 'buy',
                  amount: Number(trigger.amount),
                  tickSize: '0.01',
                });
                console.log(
                  `[WeatherBg] ✓ Bought NO on previous temp (${prevMarket.parsedTemp}°) token=${noTokenId}`
                );
              }
            }
          } catch (noErr) {
            console.warn(`[WeatherBg] Could not buy NO on previous temp:`, (noErr as Error).message);
          }
        } catch (err) {
          console.error(`[WeatherBg] Failed to execute trigger ${trigger.id}:`, (err as Error).message);
        }
      }
    }
  }
}

async function runCheck(): Promise<void> {
  const db = getDb();

  const sessionsResult = await db.query<{ icao: string }>(
    `SELECT DISTINCT ws.icao
     FROM weather_triggers wt
     JOIN weather_sessions ws ON ws.id = wt.session_id
     WHERE wt.executed = FALSE AND ws.icao IS NOT NULL`
  );

  if (sessionsResult.rows.length === 0) return;

  const { getCurrentTemperature } = await import('./weather-polymarket.js');

  for (const { icao } of sessionsResult.rows) {
    const unitHint = await detectUnitForIcao(icao);
    let weather: Awaited<ReturnType<typeof getCurrentTemperature>>;
    try {
      weather = await getCurrentTemperature(icao, unitHint);
    } catch {
      weather = null;
    }

    if (!weather) {
      console.warn(`[WeatherBg] No temperature for ${icao}`);
      continue;
    }

    console.log(`[WeatherBg] ${icao}: ${weather.rounded_native}°${weather.unit}`);

    // Push to any connected browser tab
    const { pushTemperatureUpdate } = await import('./weather-polymarket-ws.js');
    const sessions = await db.query<{ session_id: string }>(
      `SELECT DISTINCT wt.session_id FROM weather_triggers wt
       JOIN weather_sessions ws ON ws.id = wt.session_id
       WHERE ws.icao = $1`,
      [icao]
    );
    for (const { session_id } of sessions.rows) {
      pushTemperatureUpdate(session_id, weather);
    }

    // Fire triggers immediately with fresh temperature
    await fireTriggersForIcao(icao, weather);
  }
}

async function detectUnitForIcao(icao: string): Promise<'F' | 'C'> {
  try {
    const db = getDb();
    const result = await db.query<{ event_data: any }>(
      `SELECT event_data FROM weather_sessions WHERE icao = $1 AND event_data IS NOT NULL LIMIT 1`,
      [icao]
    );
    const markets: any[] = result.rows[0]?.event_data?.markets ?? [];
    for (const m of markets) {
      if (/°F/i.test(m.question ?? '')) return 'F';
      if (/°C/i.test(m.question ?? '')) return 'C';
    }
  } catch { /* ignore */ }
  return 'C';
}
