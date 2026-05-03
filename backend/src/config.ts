import { config as loadDotenv } from "dotenv";

loadDotenv();

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid numeric environment value: ${value}`);
  }
  return parsed;
}

export interface Settings {
  polymarketHost: string;
  gammaHost: string;
  chainId: number;
  privateKey?: string;
  funderAddress?: string;
  signatureType: 0 | 1 | 2 | 3;
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
  maxSpreadBps: number;
  maxOrderUsdc: number;
  minEdgeBps: number;
  dryRun: boolean;
  groqApiKey?: string;
}

export function loadSettings(): Settings {
  return {
    polymarketHost: process.env.POLYMARKET_HOST ?? "https://clob.polymarket.com",
    gammaHost: process.env.POLYMARKET_GAMMA_HOST ?? "https://gamma-api.polymarket.com",
    chainId: parseNumber(process.env.POLYMARKET_CHAIN_ID, 137),
    privateKey: process.env.POLYMARKET_PRIVATE_KEY,
    funderAddress: process.env.POLYMARKET_FUNDER_ADDRESS,
    signatureType: parseSignatureType(process.env.POLYMARKET_SIGNATURE_TYPE, process.env.POLYMARKET_FUNDER_ADDRESS),
    apiKey: process.env.POLYMARKET_API_KEY,
    apiSecret: process.env.POLYMARKET_API_SECRET,
    apiPassphrase: process.env.POLYMARKET_API_PASSPHRASE,
    maxSpreadBps: parseNumber(process.env.BOT_MAX_SPREAD_BPS, 300),
    maxOrderUsdc: parseNumber(process.env.BOT_MAX_ORDER_USDC, 25),
    minEdgeBps: parseNumber(process.env.BOT_MIN_EDGE_BPS, 500),
    dryRun: parseBoolean(process.env.BOT_DRY_RUN, true),
    groqApiKey: process.env.GROQ_API_KEY,
  };
}

export function hasL2Creds(settings: Settings): boolean {
  return Boolean(settings.apiKey && settings.apiSecret && settings.apiPassphrase);
}

function parseSignatureType(value: string | undefined, funderAddress: string | undefined): 0 | 1 | 2 | 3 {
  if (value === undefined || value.trim() === "") {
    return funderAddress ? 2 : 0;
  }

  const parsed = Number(value);
  if (parsed === 0 || parsed === 1 || parsed === 2 || parsed === 3) {
    return parsed;
  }

  throw new Error(`Invalid POLYMARKET_SIGNATURE_TYPE: ${value}`);
}
