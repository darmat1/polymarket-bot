import { MarketSummary, OutcomeToken, SearchEventSummary } from "./models.js";

function parseOptionalNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export class GammaClient {
  constructor(
    private readonly host: string,
    private readonly timeoutMs = 20_000,
  ) {}

  async listMarkets(
    limit = 25,
    active?: boolean,
    closed?: boolean,
    offset = 0,
    tagId?: number,
  ): Promise<Record<string, unknown>[]> {
    const url = new URL("/markets", this.host);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    if (active !== undefined) {
      url.searchParams.set("active", String(active));
    }
    if (closed !== undefined) {
      url.searchParams.set("closed", String(closed));
    }
    if (tagId !== undefined) {
      url.searchParams.set("tag_id", String(tagId));
    }

    return this.fetchJson<Record<string, unknown>[]>(url);
  }

  async getMarketBySlug(slug: string): Promise<Record<string, unknown>> {
    const url = new URL(`/markets/slug/${slug}`, this.host);
    return this.fetchJson<Record<string, unknown>>(url);
  }

  async searchEvents(query: string, limit = 25): Promise<SearchEventSummary[]> {
    const url = new URL("/public-search", this.host);
    url.searchParams.set("q", query);
    url.searchParams.set("limit_per_type", String(limit));
    url.searchParams.set("search_tags", "false");
    url.searchParams.set("search_profiles", "false");
    url.searchParams.set("optimized", "true");

    const payload = await this.fetchJson<Record<string, unknown>>(url);
    const events = Array.isArray(payload.events) ? payload.events : [];

    return events
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map(parseSearchEvent)
      .filter((event): event is SearchEventSummary => event !== null)
      .slice(0, limit);
  }

  async listWeatherMarkets(limit = 25): Promise<MarketSummary[]> {
    const scanLimit = Math.max(limit * 20, 200);
    const results = await this.listMarkets(scanLimit, true, false, 0, 84);
    return results
      .map(parseMarket)
      .filter((market): market is MarketSummary => market !== null)
      .slice(0, limit);
  }

  async searchBitcoinUpDownMarkets(limit = 50): Promise<MarketSummary[]> {
    const events = await this.searchEvents("Bitcoin Up or Down", limit);
    return events
      .flatMap((event) => event.markets)
      .filter((market) => {
        const text = `${eventTitleLike(market)} ${market.slug} ${market.question}`.toLowerCase();
        return text.includes("bitcoin up or down") || market.slug.startsWith("btc-updown-");
      });
  }

  private async fetchJson<T>(url: URL): Promise<T> {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Gamma API request failed: ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
  }
}

export function parseMarket(item: Record<string, unknown>): MarketSummary | null {
  const tokenIds = item.clobTokenIds ?? item.tokenIds ?? [];
  const outcomes = item.outcomes ?? [];
  const slug = String(item.slug ?? "");

  const normalizedTokenIds = normalizeValueList(tokenIds);
  const normalizedOutcomes = normalizeValueList(outcomes);

  const paired: OutcomeToken[] = normalizedOutcomes
    .map((label, index) => {
      const tokenId = normalizedTokenIds[index] ?? `${slug || "market"}:${label}`;
      return { label, tokenId };
    })
    .filter((value): value is OutcomeToken => value !== null);

  if (paired.length === 0) {
    return null;
  }

  return {
    marketId: String(item.id ?? slug),
    slug,
    question: String(item.question ?? ""),
    description: String(item.description ?? ""),
    category: String(item.category ?? ""),
    startDateIso: item.startDate ? String(item.startDate) : item.start_date_iso ? String(item.start_date_iso) : null,
    endDateIso: item.endDate ? String(item.endDate) : item.end_date_iso ? String(item.end_date_iso) : null,
    conditionId:
      typeof item.conditionId === "string"
        ? item.conditionId
        : typeof item.condition_id === "string"
          ? item.condition_id
          : null,
    active: Boolean(item.active),
    closed: Boolean(item.closed),
    liquidity: parseOptionalNumber(item.liquidity ?? item.liquidityNum),
    volume: parseOptionalNumber(item.volume ?? item.volumeNum),
    outcomes: paired,
    raw: item,
  };
}

export function parseSearchEvent(item: Record<string, unknown>): SearchEventSummary | null {
  const slug = String(item.slug ?? "");
  const title = String(item.title ?? item.question ?? "");
  if (!slug || !title) {
    return null;
  }

  const nestedMarkets = Array.isArray(item.markets) ? item.markets : [];
  const markets = nestedMarkets
    .filter((market): market is Record<string, unknown> => typeof market === "object" && market !== null)
    .map((market) => parseSearchMarket(market, item))
    .filter((market): market is MarketSummary => market !== null);

  const tags = Array.isArray(item.tags)
    ? item.tags
        .map((tag) => (typeof tag === "object" && tag !== null ? String((tag as { label?: unknown }).label ?? "") : ""))
        .filter(Boolean)
    : [];

  return {
    eventId: String(item.id ?? ""),
    slug,
    title,
    description: String(item.description ?? ""),
    active: Boolean(item.active),
    closed: Boolean(item.closed),
    image: String(item.image ?? ""),
    icon: String(item.icon ?? ""),
    tags,
    markets,
    raw: item,
  };
}

function parseSearchMarket(
  market: Record<string, unknown>,
  parentEvent: Record<string, unknown>,
): MarketSummary | null {
  const parsed = parseMarket({
    ...parentEvent,
    ...market,
    startDate: market.startDate ?? parentEvent.startDate,
    endDate: market.endDate ?? parentEvent.endDate,
    start_date_iso: market.start_date_iso ?? parentEvent.start_date_iso,
    end_date_iso: market.end_date_iso ?? parentEvent.end_date_iso,
  });

  return parsed;
}

export function marketMatchesQuery(market: MarketSummary, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  const haystack = [
    market.slug,
    market.question,
    market.category,
    String(market.raw.description ?? ""),
    ...market.outcomes.map((outcome) => outcome.label),
  ]
    .join(" ")
    .toLowerCase();

  return haystack.includes(normalizedQuery);
}

function normalizeValueList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }

  if (typeof value === "string") {
    return value
      .trim()
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .split(",")
      .map((part) => part.trim().replace(/^"+|"+$/g, ""))
      .filter(Boolean);
  }

  return [];
}

function eventTitleLike(market: MarketSummary): string {
  return String(market.raw.title ?? market.raw.groupItemTitle ?? "");
}
