import { getOpenPositions } from './app.js';

export interface CachedPositions {
  timestamp: number;
  data: any[];
}

const positionCache = new Map<string, CachedPositions>();
const CACHE_TTL = 3000; // 3 seconds
const CACHE_KEY = 'default';

export async function getPositionsCached(): Promise<any[]> {
  const now = Date.now();
  const cached = positionCache.get(CACHE_KEY);

  if (cached && now - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  // Fetch fresh data
  try {
    const positions = await getOpenPositions();

    positionCache.set(CACHE_KEY, {
      timestamp: now,
      data: positions.positions,
    });

    return positions.positions;
  } catch (error) {
    console.error('[PositionCache] Failed to fetch positions:', error);
    // Return stale cache if available, otherwise empty array
    return cached?.data ?? [];
  }
}

export function clearPositionCache(): void {
  positionCache.clear();
}

export function getCacheTTL(): number {
  return CACHE_TTL;
}

export function getCacheStats(): { size: number; entries: string[] } {
  return {
    size: positionCache.size,
    entries: Array.from(positionCache.keys()),
  };
}
