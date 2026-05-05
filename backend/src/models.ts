export interface OutcomeToken {
  label: string;
  tokenId: string;
}

export interface MarketSummary {
  marketId: string;
  slug: string;
  question: string;
  description: string;
  category: string;
  endDateIso: string | null;
  active: boolean;
  closed: boolean;
  outcomes: OutcomeToken[];
  raw: Record<string, unknown>;
}

export interface WeatherStation {
  key: string;
  label: string;
  station: string;
  latitude: number;
  longitude: number;
  unit: "F" | "C";
  timezone: string;
  aliases: string[];
}

export interface TemperatureBucket {
  kind: "at_or_below" | "exact" | "at_or_above";
  lowerInclusive: number | null;
  upperInclusive: number | null;
  label: string;
}

export interface ParsedWeatherMarket {
  cityKey: string;
  cityLabel: string;
  station: string;
  targetDate: string;
  unit: "F" | "C";
  bucket: TemperatureBucket;
}

export interface ForecastPoint {
  source: "ecmwf" | "gfs";
  targetDate: string;
  forecastHigh: number;
  unit: "F" | "C";
}

export interface HourlyForecastPoint {
  time: string; // ISO string
  temp: number;
  unit: "F" | "C";
}

export interface WeatherProbabilityResult {
  probability: number;
  blendedForecastHigh: number;
  sigma: number;
  source: string;
  components: ForecastPoint[];
}

export interface SearchEventSummary {
  eventId: string;
  slug: string;
  title: string;
  description: string;
  active: boolean;
  closed: boolean;
  image: string;
  icon: string;
  tags: string[];
  markets: MarketSummary[];
  raw: Record<string, unknown>;
}

export class TopOfBook {
  constructor(
    public readonly bestBid: number | null,
    public readonly bestAsk: number | null,
  ) {}

  get midpoint(): number | null {
    if (this.bestBid === null || this.bestAsk === null) {
      return null;
    }
    return (this.bestBid + this.bestAsk) / 2;
  }

  get spreadBps(): number | null {
    const midpoint = this.midpoint;
    if (midpoint === null || midpoint === 0) {
      return null;
    }
    return ((this.bestAsk! - this.bestBid!) / midpoint) * 10_000;
  }
}

export interface TradeDecision {
  shouldTrade: boolean;
  side: "buy" | "sell";
  targetPrice: number;
  edgeBps: number;
  reason: string;
}
