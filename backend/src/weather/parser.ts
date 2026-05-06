import { type MarketSummary, type ParsedWeatherMarket, type TemperatureBucket } from "../models.js";
import { matchWeatherStation } from "./stations.js";

const MONTHS = new Map<string, number>([
  ["january", 1],
  ["february", 2],
  ["march", 3],
  ["april", 4],
  ["may", 5],
  ["june", 6],
  ["july", 7],
  ["august", 8],
  ["september", 9],
  ["october", 10],
  ["november", 11],
  ["december", 12],
]);

export function parseWeatherMarket(market: MarketSummary, extractedData?: any): ParsedWeatherMarket | null {
  const station = matchWeatherStation(`${market.question} ${market.slug}`);
  
  const bucket = parseTemperatureBucket(market.question);
  if (!bucket && !extractedData) {
    return null;
  }

  const targetDate = parseTargetDate(market.question, market.endDateIso) || (extractedData?.day);
  if (!targetDate) {
    return null;
  }

  // Extract station code (e.g. RJTT)
  const stationMatch = market.question.match(/\(([A-Z]{4})\)/) || market.question.match(/\b([A-Z]{4})\b/);
  const stationCode = extractedData?.station_code || stationMatch?.[1] || (station?.station || null);

  const finalUnit = extractedData?.t_sys === "F" ? "F" : extractedData?.t_sys === "C" ? "C" : bucket?.unit || "C";
  const finalBucket = bucket?.bucket || {
    kind: "exact",
    lowerInclusive: extractedData?.t,
    upperInclusive: extractedData?.t,
    label: `${extractedData?.t}°${finalUnit}`
  };

  return {
    cityKey: station?.key || stationCode?.toLowerCase() || "unknown",
    cityLabel: station?.label || stationCode || "Unknown Station",
    station: stationCode || "Unknown",
    targetDate,
    unit: finalUnit as "F" | "C",
    bucket: finalBucket as TemperatureBucket,
  };
}

function parseTemperatureBucket(question: string): { unit: "F" | "C"; bucket: TemperatureBucket } | null {
  const low = question.match(/be\s+(-?\d+(?:\.\d+)?)°\s*([CF])\s+or\s+below/i);
  if (low) {
    const value = Number(low[1]);
    const unit = low[2].toUpperCase() as "F" | "C";
    return {
      unit,
      bucket: {
        kind: "at_or_below",
        lowerInclusive: null,
        upperInclusive: value,
        label: `${value}°${unit} or below`,
      },
    };
  }

  const high = question.match(/be\s+(-?\d+(?:\.\d+)?)°\s*([CF])\s+or\s+higher/i);
  if (high) {
    const value = Number(high[1]);
    const unit = high[2].toUpperCase() as "F" | "C";
    return {
      unit,
      bucket: {
        kind: "at_or_above",
        lowerInclusive: value,
        upperInclusive: null,
        label: `${value}°${unit} or higher`,
      },
    };
  }

  const exact = question.match(/be\s+(-?\d+(?:\.\d+)?)°\s*([CF])(?:\s+on|\?|$)/i);
  if (exact) {
    const value = Number(exact[1]);
    const unit = exact[2].toUpperCase() as "F" | "C";
    return {
      unit,
      bucket: {
        kind: "exact",
        lowerInclusive: value,
        upperInclusive: value,
        label: `${value}°${unit}`,
      },
    };
  }

  return null;
}

function parseTargetDate(question: string, endDateIso: string | null): string | null {
  const inline = question.match(/on\s+([A-Za-z]+)\s+(\d{1,2})/i);
  if (inline) {
    const monthIndex = MONTHS.get(inline[1].toLowerCase());
    if (monthIndex && endDateIso) {
      const reference = new Date(endDateIso);
      const year = Number.isNaN(reference.getTime()) ? new Date().getUTCFullYear() : reference.getUTCFullYear();
      return `${year}-${String(monthIndex).padStart(2, "0")}-${String(Number(inline[2])).padStart(2, "0")}`;
    }
  }

  if (!endDateIso) {
    return null;
  }

  const parsed = new Date(endDateIso);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
}
