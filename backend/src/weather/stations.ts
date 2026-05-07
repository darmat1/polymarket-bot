import { type WeatherStation } from "../models.js";

const STATIONS: WeatherStation[] = [
  {
    key: "moscow",
    label: "Moscow",
    station: "UUWW",
    latitude: 55.5915,
    longitude: 37.2615,
    unit: "C",
    timezone: "Europe/Moscow",
    aliases: ["moscow", "vnukovo"],
  },
  {
    key: "new-york-city",
    label: "New York City",
    station: "KNYC",
    latitude: 40.7128,
    longitude: -74.006,
    unit: "F",
    timezone: "America/New_York",
    aliases: ["new york", "nyc", "central park"],
  },
  {
    key: "laguardia",
    label: "LaGuardia Airport",
    station: "KLGA",
    latitude: 40.7769,
    longitude: -73.874,
    unit: "F",
    timezone: "America/New_York",
    aliases: ["laguardia", "lga"],
  },
  {
    key: "singapore",
    label: "Singapore",
    station: "WSSS",
    latitude: 1.3644,
    longitude: 103.9915,
    unit: "C",
    timezone: "Asia/Singapore",
    aliases: ["singapore", "changi"],
  },
  {
    key: "kuala-lumpur",
    label: "Kuala Lumpur",
    station: "WMKK",
    latitude: 2.7456,
    longitude: 101.71,
    unit: "C",
    timezone: "Asia/Kuala_Lumpur",
    aliases: ["kuala lumpur", "klia"],
  },
  {
    key: "buenos-aires",
    label: "Buenos Aires",
    station: "SAEZ",
    latitude: -34.8222,
    longitude: -58.5358,
    unit: "C",
    timezone: "America/Argentina/Buenos_Aires",
    aliases: ["buenos aires", "ezeiza"],
  },
  {
    key: "lucknow",
    label: "Lucknow",
    station: "VILK",
    latitude: 26.7606,
    longitude: 80.8893,
    unit: "C",
    timezone: "Asia/Kolkata",
    aliases: ["lucknow", "amausi"],
  },
  {
    key: "delhi",
    label: "Delhi",
    station: "VIDP",
    latitude: 28.5562,
    longitude: 77.1,
    unit: "C",
    timezone: "Asia/Kolkata",
    aliases: ["delhi", "new delhi", "indira gandhi"],
  },
  {
    key: "tokyo",
    label: "Tokyo",
    station: "RJTT",
    latitude: 35.5523,
    longitude: 139.7798,
    unit: "C",
    timezone: "Asia/Tokyo",
    aliases: ["tokyo", "haneda"],
  },
  {
    key: "london",
    label: "London",
    station: "EGLL",
    latitude: 51.47,
    longitude: -0.4543,
    unit: "C",
    timezone: "Europe/London",
    aliases: ["london", "heathrow"],
  },
  {
    key: "miami",
    label: "Miami",
    station: "KMIA",
    latitude: 25.7959,
    longitude: -80.287,
    unit: "F",
    timezone: "America/New_York",
    aliases: ["miami"],
  },
  {
    key: "los-angeles",
    label: "Los Angeles",
    station: "KLAX",
    latitude: 33.9425,
    longitude: -118.408,
    unit: "F",
    timezone: "America/Los_Angeles",
    aliases: ["los angeles", "la", "lax"],
  },
  {
    key: "chicago",
    label: "Chicago",
    station: "KORD",
    latitude: 41.9742,
    longitude: -87.9073,
    unit: "F",
    timezone: "America/Chicago",
    aliases: ["chicago", "o'hare"],
  },
  {
    key: "hong-kong",
    label: "Hong Kong",
    station: "VHHH",
    latitude: 22.3089,
    longitude: 113.9146,
    unit: "C",
    timezone: "Asia/Hong_Kong",
    aliases: ["hong kong"],
  },
  {
    key: "paris",
    label: "Paris",
    station: "LFPG",
    latitude: 49.0097,
    longitude: 2.5478,
    unit: "C",
    timezone: "Europe/Paris",
    aliases: ["paris", "charles de gaulle"],
  },
  {
    key: "seoul",
    label: "Seoul",
    station: "RKSI",
    latitude: 37.4691,
    longitude: 126.4505,
    unit: "C",
    timezone: "Asia/Seoul",
    aliases: ["seoul", "incheon"],
  },
  {
    key: "sydney",
    label: "Sydney",
    station: "YSSY",
    latitude: -33.9461,
    longitude: 151.1772,
    unit: "C",
    timezone: "Australia/Sydney",
    aliases: ["sydney"],
  },
  {
    key: "dubai",
    label: "Dubai",
    station: "OMDB",
    latitude: 25.2532,
    longitude: 55.3657,
    unit: "C",
    timezone: "Asia/Dubai",
    aliases: ["dubai"],
  },
  {
    key: "beijing",
    label: "Beijing",
    station: "ZBAA",
    latitude: 40.0799,
    longitude: 116.6031,
    unit: "C",
    timezone: "Asia/Shanghai",
    aliases: ["beijing"],
  },
  {
    key: "sao-paulo",
    label: "São Paulo",
    station: "SBGR",
    latitude: -23.4356,
    longitude: -46.4731,
    unit: "C",
    timezone: "America/Sao_Paulo",
    aliases: ["sao paulo", "são paulo", "guarulhos"],
  },
];

export function matchWeatherStation(text: string): WeatherStation | null {
  const normalized = text.toLowerCase();
  
  // 1. Try to find a 4-letter station code in parentheses or as a word, e.g. (RJTT)
  const stationMatch = text.match(/\b([A-Z]{4})\b/);
  if (stationMatch) {
    const code = stationMatch[1].toUpperCase();
    const found = STATIONS.find(s => s.station === code);
    if (found) return found;
  }

  let bestMatch: WeatherStation | null = null;
  let bestAliasLength = -1;

  for (const station of STATIONS) {
    // Check station code itself
    if (normalized.includes(station.station.toLowerCase())) {
       return station;
    }

    for (const alias of station.aliases) {
      if (!normalized.includes(alias)) {
        continue;
      }

      if (alias.length > bestAliasLength) {
        bestAliasLength = alias.length;
        bestMatch = station;
      }
    }
  }

  return bestMatch;
}

export function getWeatherStations(): WeatherStation[] {
  return STATIONS;
}
