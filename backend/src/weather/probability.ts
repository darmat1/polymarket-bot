import { type ForecastPoint, type ParsedWeatherMarket, type WeatherProbabilityResult } from "../models.js";

export function estimateWeatherProbability(
  parsed: ParsedWeatherMarket,
  forecasts: ForecastPoint[],
): WeatherProbabilityResult | null {
  if (forecasts.length === 0) {
    return null;
  }

  const blendedForecastHigh = forecasts.reduce((sum, point) => sum + point.forecastHigh, 0) / forecasts.length;
  const sigma = parsed.unit === "F" ? 2 : 1.2;
  const probability = clamp01(probabilityForBucket(blendedForecastHigh, sigma, parsed));

  return {
    probability,
    blendedForecastHigh,
    sigma,
    source: forecasts.map((point) => point.source).join("+"),
    components: forecasts,
  };
}

function probabilityForBucket(mean: number, sigma: number, parsed: ParsedWeatherMarket): number {
  const { bucket } = parsed;

  if (bucket.kind === "exact" && bucket.lowerInclusive !== null) {
    return normalCdf(bucket.lowerInclusive + 0.5, mean, sigma) - normalCdf(bucket.lowerInclusive - 0.5, mean, sigma);
  }

  if (bucket.kind === "at_or_below" && bucket.upperInclusive !== null) {
    return normalCdf(bucket.upperInclusive + 0.5, mean, sigma);
  }

  if (bucket.kind === "at_or_above" && bucket.lowerInclusive !== null) {
    return 1 - normalCdf(bucket.lowerInclusive - 0.5, mean, sigma);
  }

  return 0;
}

function normalCdf(value: number, mean: number, sigma: number): number {
  return 0.5 * (1 + erf((value - mean) / (sigma * Math.SQRT2)));
}

function erf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x));
  return sign * y;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
