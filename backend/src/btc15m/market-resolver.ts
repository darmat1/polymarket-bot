import { GammaClient } from "../gamma.js";
import type { Btc15mMarketView } from "./types.js";

export const BTC15M_WINDOW_SEC = 900;
export const BTC15M_SLUG_PREFIX = "btc-updown-15m-";

export function currentWindowStartSec(nowMs: number): number {
  return Math.floor(nowMs / 1000 / BTC15M_WINDOW_SEC) * BTC15M_WINDOW_SEC;
}

export function nextWindowStartSec(nowMs: number): number {
  return currentWindowStartSec(nowMs) + BTC15M_WINDOW_SEC;
}

export function slugForWindow(startSec: number): string {
  return `${BTC15M_SLUG_PREFIX}${startSec}`;
}

export interface ResolveCurrentMarketOptions {
  gamma?: Pick<GammaClient, "getMarketBySlug">;
  now?: () => number;
}

export async function resolveCurrentMarket(
  gammaHost: string,
  options: ResolveCurrentMarketOptions = {},
): Promise<Btc15mMarketView | null> {
  const gamma = options.gamma ?? new GammaClient(gammaHost);
  const slug = slugForWindow(currentWindowStartSec(options.now?.() ?? Date.now()));
  try {
    const raw = await gamma.getMarketBySlug(slug);
    return parseMarketView(raw, slug);
  } catch {
    return null;
  }
}

export function parseMarketView(
  raw: Record<string, unknown>,
  fallbackSlug: string,
): Btc15mMarketView | null {
  const slug = typeof raw.slug === "string" && raw.slug.trim() ? raw.slug : fallbackSlug;
  const question = typeof raw.question === "string" && raw.question.trim() ? raw.question : slug;
  const startTimeMs = parseDateMs(raw.startDate ?? raw.startDateIso ?? raw.start_time);
  const endTimeMs = parseDateMs(raw.endDate ?? raw.endDateIso ?? raw.end_time);
  if (!Number.isFinite(startTimeMs) || !Number.isFinite(endTimeMs)) {
    return null;
  }

  const tokens = parseOutcomeTokens(raw);
  if (!tokens) {
    return null;
  }

  return {
    slug,
    question,
    startTimeMs,
    endTimeMs,
    upTokenId: tokens.up,
    downTokenId: tokens.down,
  };
}

function parseOutcomeTokens(raw: Record<string, unknown>): { up: string; down: string } | null {
  const clobTokenIds = parseStringArray(raw.clobTokenIds ?? raw.tokenIds);
  const outcomes = parseStringArray(raw.outcomes);
  if (clobTokenIds.length !== 2 || outcomes.length !== 2) {
    return null;
  }

  const upIndex = outcomes.findIndex((outcome) => /^(up|yes)$/i.test(outcome.trim()));
  const downIndex = outcomes.findIndex((outcome) => /^(down|no)$/i.test(outcome.trim()));
  if (upIndex < 0 || downIndex < 0 || upIndex === downIndex) {
    return null;
  }

  return {
    up: clobTokenIds[upIndex],
    down: clobTokenIds[downIndex],
  };
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  if (typeof value !== "string") {
    return [];
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    // fall through to CSV-ish parsing
  }

  return trimmed
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((part) => part.trim().replace(/^"+|"+$/g, ""))
    .filter(Boolean);
}

function parseDateMs(value: unknown): number {
  if (typeof value === "number") {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}
