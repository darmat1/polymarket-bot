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
];

export function matchWeatherStation(text: string): WeatherStation | null {
  const normalized = text.toLowerCase();
  let bestMatch: WeatherStation | null = null;
  let bestAliasLength = -1;

  for (const station of STATIONS) {
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
