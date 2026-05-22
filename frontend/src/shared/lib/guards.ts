import type { SearchEventSummary } from "../types/api";

export function includesAnyKeyword(event: SearchEventSummary, keywords: string[]) {
  const haystack = [
    event.title,
    event.slug,
    event.description,
    event.tags.join(" "),
    ...event.markets.map(
      (market) => `${market.question} ${market.slug} ${market.category}`,
    ),
  ]
    .join(" ")
    .toLowerCase();

  return keywords.some((keyword) => haystack.includes(keyword));
}

export function isWeatherEvent(event: SearchEventSummary) {
  const weatherKeywords = [
    "weather",
    "temperature",
    "temp",
    "rain",
    "snow",
    "storm",
    "hurricane",
    "climate",
    "forecast",
    "nyc high temp",
    "high temp",
  ];

  return includesAnyKeyword(event, weatherKeywords);
}
