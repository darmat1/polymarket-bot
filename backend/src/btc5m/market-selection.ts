import type { Settings } from "../config.js";
import { GammaClient, parseMarket } from "../gamma.js";
import type { MarketSummary, OutcomeToken, SearchEventSummary } from "../models.js";

import {
  BTC5M_SLUG_PREFIX,
  MARKET_PAGE_SIZE,
} from "./constants.js";
import type { Btc5mMarketSelection, Btc5mMarketView } from "./types.js";

export async function peekCurrentBtc5mMarket(
  settings: Settings,
  gamma = new GammaClient(settings.gammaHost),
  now = Date.now(),
): Promise<Btc5mMarketView | null> {
  const selection = await peekBtc5mMarketSelection(settings, gamma, now);
  return selection.current;
}

export async function peekBtc5mMarketSelection(
  settings: Settings,
  gamma = new GammaClient(settings.gammaHost),
  now = Date.now(),
): Promise<Btc5mMarketSelection> {
  const events = await gamma.searchEvents("Bitcoin Up or Down", MARKET_PAGE_SIZE);
  const candidates = collectBtc5mMarkets(events);

  const sorted = candidates
    .filter((market) => {
      if (!market.endDateIso) {
        return true;
      }

      const endMs = Date.parse(market.endDateIso);
      return !Number.isFinite(endMs) || endMs > now - 60_000;
    })
    .sort((left, right) => {
      const leftMs = left.startDateIso
        ? Date.parse(left.startDateIso)
        : left.endDateIso
          ? Date.parse(left.endDateIso)
          : Number.MAX_SAFE_INTEGER;
      const rightMs = right.startDateIso
        ? Date.parse(right.startDateIso)
        : right.endDateIso
          ? Date.parse(right.endDateIso)
          : Number.MAX_SAFE_INTEGER;
      return leftMs - rightMs;
    });

  const currentCandidate =
    sorted.find((market) => isMarketActiveNow(market, now)) ?? null;
  const nextCandidate =
    sorted.find((market) => isNextMarketCandidate(market, now)) ?? null;

  const [currentMarket, nextMarket] = await Promise.all([
    enrichBtc5mMarket(currentCandidate, gamma),
    enrichBtc5mMarket(nextCandidate, gamma),
  ]);

  return {
    current: currentMarket ? toMarketView(currentMarket) : null,
    next: nextMarket ? toMarketView(nextMarket) : null,
  };
}

async function enrichBtc5mMarket(
  market: MarketSummary | null,
  gamma: GammaClient,
): Promise<MarketSummary | null> {
  if (!market) {
    return null;
  }

  try {
    const detail = await gamma.getMarketBySlug(market.slug);
    return parseMarket(detail) ?? market;
  } catch {
    return market;
  }
}

function collectBtc5mMarkets(events: SearchEventSummary[]): MarketSummary[] {
  return events
    .flatMap((event) => event.markets)
    .filter(isBtc5mMarket)
    .sort((left, right) => {
      const leftMs = getBtc5mStartMs(left);
      const rightMs = getBtc5mStartMs(right);
      return leftMs - rightMs;
    });
}

function isBtc5mMarket(market: MarketSummary): boolean {
  return market.slug.startsWith(BTC5M_SLUG_PREFIX)
    && /bitcoin up or down/i.test(market.question)
    && market.outcomes.some((outcome) => /^up$/i.test(outcome.label));
}

function toMarketView(market: MarketSummary): Btc5mMarketView | null {
  const upOutcome = selectOutcome(market.outcomes, "up");
  if (!upOutcome) {
    return null;
  }

  const downOutcome = selectOutcome(market.outcomes, "down");
  return {
    marketId: market.marketId,
    slug: market.slug,
    question: market.question,
    startDateIso: getBtc5mStartIso(market),
    endDateIso: market.endDateIso,
    upTokenId: upOutcome.tokenId,
    downTokenId: downOutcome?.tokenId ?? null,
  };
}

function isMarketActiveNow(market: MarketSummary, now: number): boolean {
  const startMs = getBtc5mStartMs(market);
  const endMs = market.endDateIso ? Date.parse(market.endDateIso) : Number.NaN;
  const started = !Number.isFinite(startMs) || startMs <= now;
  const notEnded = !Number.isFinite(endMs) || endMs > now;
  return started && notEnded;
}

function isNextMarketCandidate(market: MarketSummary, now: number): boolean {
  const startMs = getBtc5mStartMs(market);
  if (!Number.isFinite(startMs)) {
    return false;
  }

  return startMs > now;
}

function getBtc5mStartIso(market: MarketSummary): string | null {
  const startMs = getBtc5mStartMs(market);
  if (!Number.isFinite(startMs)) {
    return market.startDateIso;
  }
  return new Date(startMs).toISOString();
}

function getBtc5mStartMs(market: MarketSummary): number {
  const slugMatch = market.slug.match(/^btc-updown-5m-(\d{9,})$/);
  if (slugMatch) {
    const parsed = Number(slugMatch[1]) * 1000;
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  if (market.startDateIso) {
    const parsed = Date.parse(market.startDateIso);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return Number.NaN;
}

function selectOutcome(outcomes: OutcomeToken[], label: string): OutcomeToken | null {
  return outcomes.find((outcome) => outcome.label.toLowerCase() === label) ?? null;
}
