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
  try {
    const positions = await getOpenPositions(user);

    positionCache.set(user, {
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

export function getCacheStats(): { size: number; entries: string[] } {
  return {
    size: positionCache.size,
    entries: Array.from(positionCache.keys()),
  };
}
