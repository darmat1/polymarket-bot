import { config as loadDotenv } from "dotenv";

loadDotenv();

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
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

function parseOptionalNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") {
    return null;
  }

  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid numeric environment value: ${value}`);
  }

  return parsed;
}

export interface ScalperSettings {
  buyPriceLimit: number;
  sellPriceLimit: number;
  orderSize: number;
  maxBotBudget: number;
  minLiquidity: number;
  cancelBuyBeforeSec: number;
  cancelSellBeforeSec: number;
  scannerPollIntervalSec: number;
  stateFile: string;
}

export interface Btc5mSettings {
  buyPriceLimit: number;
  sellPriceLimit: number;
  orderSize: number;
  marketScanIntervalSec: number;
}

export interface Btc15mSettings {
  buyPriceLimit: number;
  maxBuyPriceLimit?: number;
  trailStep: number;
  trailDist: number;
  trailUpdateIntervalSec: number;
  orderSize: number;
  workingBudgetUsd: number;
  repeatThresholdMin: number;
  forceSellThresholdMin: number;
  neutralZoneUsd: number;
  tickIntervalSec: number;
  stateFile: string;
}

export interface Btc15mHedgeSettings {
  workingBudgetUsd: number;
  orderSize: number;
  targetCombinedPrice: number | null;
  entryCutoffMin: number;
  forceUnwindThresholdMin: number;
  tickIntervalSec: number;
  stateFile: string;
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
  enableScalper: boolean;
  buyPriceLimit: number;
  sellPriceLimit: number;
  orderSize: number;
  maxBotBudget: number;
  minLiquidity: number;
  cancelBuyBeforeSec: number;
  cancelSellBeforeSec: number;
  scalperScanIntervalSec: number;
  scalper: ScalperSettings;
  btc5m: Btc5mSettings;
  btc15m: Btc15mSettings;
  btc15mAuto: Btc15mSettings;
  btc15mHedge: Btc15mHedgeSettings;
}

export function loadSettings(): Settings {
  const scalper: ScalperSettings = {
    buyPriceLimit: parseNumber(process.env.BUY_PRICE_LIMIT, 0.2),
    sellPriceLimit: parseNumber(process.env.SELL_PRICE_LIMIT, 0.3),
    orderSize: parseNumber(process.env.ORDER_SIZE, 5),
    maxBotBudget: parseNumber(process.env.MAX_BOT_BUDGET, 3),
    minLiquidity: parseNumber(process.env.MIN_LIQUIDITY, 0),
    cancelBuyBeforeSec: parseNumber(process.env.CANCEL_BUY_BEFORE_SEC, 30),
    cancelSellBeforeSec: parseNumber(process.env.CANCEL_SELL_BEFORE_SEC, 15),
    scannerPollIntervalSec: parseNumber(process.env.SCALPER_SCANNER_POLL_INTERVAL_SEC, 5),
    stateFile: process.env.SCALPER_STATE_FILE?.trim() || "data/scalper-state.json",
  };

  const btc5m: Btc5mSettings = {
    buyPriceLimit: parseNumber(process.env.BTC5M_BUY_PRICE_LIMIT, 0.6),
    sellPriceLimit: parseNumber(process.env.BTC5M_SELL_PRICE_LIMIT, 0.7),
    orderSize: parseNumber(process.env.BTC5M_ORDER_SIZE, 5),
    marketScanIntervalSec: parseNumber(process.env.BTC5M_MARKET_SCAN_INTERVAL_SEC, 5),
  };

  const btc15m: Btc15mSettings = {
    buyPriceLimit: parseNumber(process.env.BTC15M_BUY_PRICE_LIMIT, 0.25),
    trailStep: parseNumber(process.env.BTC15M_TRAIL_STEP, 0.05),
    trailDist: parseNumber(process.env.BTC15M_TRAIL_DIST, 0.02),
    trailUpdateIntervalSec: parseNumber(process.env.BTC15M_TRAIL_UPDATE_SEC, 3),
    orderSize: parseNumber(process.env.BTC15M_ORDER_SIZE, 5),
    workingBudgetUsd: parseNumber(process.env.BTC15M_WORKING_BUDGET, 5),
    repeatThresholdMin: parseNumber(process.env.BTC15M_REPEAT_MIN, 6),
    forceSellThresholdMin: parseNumber(process.env.BTC15M_FORCE_SELL_MIN, 2),
    neutralZoneUsd: parseNumber(process.env.BTC15M_NEUTRAL_ZONE_USD, 5),
    tickIntervalSec: parseNumber(process.env.BTC15M_TICK_INTERVAL_SEC, 2),
    stateFile: process.env.BTC15M_STATE_FILE?.trim() || "data/btc15m-trader-state.json",
  };

  const btc15mAuto: Btc15mSettings = {
    buyPriceLimit: parseNumber(process.env.BTC15M_AUTO_MIN_BUY_PRICE_LIMIT, 0.2),
    maxBuyPriceLimit: parseNumber(process.env.BTC15M_AUTO_MAX_BUY_PRICE_LIMIT, 0.8),
    trailStep: parseNumber(process.env.BTC15M_AUTO_TRAIL_STEP, btc15m.trailStep),
    trailDist: parseNumber(process.env.BTC15M_AUTO_TRAIL_DIST, btc15m.trailDist),
    trailUpdateIntervalSec: parseNumber(process.env.BTC15M_AUTO_TRAIL_UPDATE_SEC, btc15m.trailUpdateIntervalSec),
    orderSize: parseNumber(process.env.BTC15M_AUTO_ORDER_SIZE, btc15m.orderSize),
    workingBudgetUsd: parseNumber(process.env.BTC15M_AUTO_WORKING_BUDGET, btc15m.workingBudgetUsd),
    repeatThresholdMin: parseNumber(process.env.BTC15M_AUTO_REPEAT_MIN, btc15m.repeatThresholdMin),
    forceSellThresholdMin: parseNumber(process.env.BTC15M_AUTO_FORCE_SELL_MIN, btc15m.forceSellThresholdMin),
    neutralZoneUsd: parseNumber(process.env.BTC15M_AUTO_NEUTRAL_ZONE_USD, btc15m.neutralZoneUsd),
    tickIntervalSec: parseNumber(process.env.BTC15M_AUTO_TICK_INTERVAL_SEC, btc15m.tickIntervalSec),
    stateFile: process.env.BTC15M_AUTO_STATE_FILE?.trim() || "data/btc15m-auto-trader-state.json",
  };

  const btc15mHedge: Btc15mHedgeSettings = {
    workingBudgetUsd: parseNumber(process.env.BTC15M_HEDGE_WORKING_BUDGET, 3),
    orderSize: parseNumber(process.env.BTC15M_HEDGE_ORDER_SIZE, 5),
    targetCombinedPrice: parseOptionalNumber(process.env.BTC15M_HEDGE_TARGET_COMBINED_PRICE),
    entryCutoffMin: parseNumber(process.env.BTC15M_HEDGE_ENTRY_CUTOFF_MIN, 6),
    forceUnwindThresholdMin: parseNumber(process.env.BTC15M_HEDGE_FORCE_UNWIND_MIN, 2),
    tickIntervalSec: parseNumber(process.env.BTC15M_HEDGE_TICK_INTERVAL_SEC, 2),
    stateFile: process.env.BTC15M_HEDGE_STATE_FILE?.trim() || "data/btc15m-hedge-state.json",
  };

  validateScalperSettings(scalper);
  validateBtc5mSettings(btc5m);
  validateBtc15mSettings(btc15m);
  validateBtc15mSettings(btc15mAuto);
  validateBtc15mHedgeSettings(btc15mHedge);

  return {
    polymarketHost: process.env.POLYMARKET_HOST ?? "https://clob.polymarket.com",
    gammaHost: process.env.POLYMARKET_GAMMA_HOST ?? "https://gamma-api.polymarket.com",
    chainId: parseNumber(process.env.POLYMARKET_CHAIN_ID, 137),
    privateKey: process.env.POLYMARKET_PRIVATE_KEY,
    funderAddress: process.env.POLYMARKET_FUNDER_ADDRESS,
    signatureType: parseSignatureType(
      process.env.POLYMARKET_SIGNATURE_TYPE,
      process.env.POLYMARKET_FUNDER_ADDRESS,
    ),
    apiKey: process.env.POLYMARKET_API_KEY,
    apiSecret: process.env.POLYMARKET_API_SECRET,
    apiPassphrase: process.env.POLYMARKET_API_PASSPHRASE,
    maxSpreadBps: parseNumber(process.env.BOT_MAX_SPREAD_BPS, 300),
    maxOrderUsdc: parseNumber(process.env.BOT_MAX_ORDER_USDC, 25),
    minEdgeBps: parseNumber(process.env.BOT_MIN_EDGE_BPS, 500),
    dryRun: parseBoolean(process.env.BOT_DRY_RUN, true),
    groqApiKey: process.env.GROQ_API_KEY,
    enableScalper: parseBoolean(process.env.BOT_ENABLE_SCALPER, false),
    buyPriceLimit: scalper.buyPriceLimit,
    sellPriceLimit: scalper.sellPriceLimit,
    orderSize: scalper.orderSize,
    maxBotBudget: scalper.maxBotBudget,
    minLiquidity: scalper.minLiquidity,
    cancelBuyBeforeSec: scalper.cancelBuyBeforeSec,
    cancelSellBeforeSec: scalper.cancelSellBeforeSec,
    scalperScanIntervalSec: scalper.scannerPollIntervalSec,
    scalper,
    btc5m,
    btc15m,
    btc15mAuto,
    btc15mHedge,
  };
}

export function hasL2Creds(settings: Settings): boolean {
  return Boolean(settings.apiKey && settings.apiSecret && settings.apiPassphrase);
}

function parseSignatureType(
  value: string | undefined,
  funderAddress: string | undefined,
): 0 | 1 | 2 | 3 {
  if (value === undefined || value.trim() === "") {
    return funderAddress ? 2 : 0;
  }

  const parsed = Number(value);
  if (parsed === 0 || parsed === 1 || parsed === 2 || parsed === 3) {
    return parsed;
  }

  throw new Error(`Invalid POLYMARKET_SIGNATURE_TYPE: ${value}`);
}

function validateScalperSettings(settings: ScalperSettings): void {
  for (const [name, value] of [
    ["BUY_PRICE_LIMIT", settings.buyPriceLimit],
    ["SELL_PRICE_LIMIT", settings.sellPriceLimit],
  ] as const) {
    if (!(value > 0 && value < 1)) {
      throw new Error(`${name} must be between 0 and 1.`);
    }
  }

  if (settings.sellPriceLimit <= settings.buyPriceLimit) {
    throw new Error("SELL_PRICE_LIMIT must be greater than BUY_PRICE_LIMIT.");
  }

  for (const [name, value] of [
    ["ORDER_SIZE", settings.orderSize],
    ["MAX_BOT_BUDGET", settings.maxBotBudget],
    ["SCALPER_SCANNER_POLL_INTERVAL_SEC", settings.scannerPollIntervalSec],
  ] as const) {
    if (value <= 0) {
      throw new Error(`${name} must be greater than zero.`);
    }
  }

  for (const [name, value] of [
    ["MIN_LIQUIDITY", settings.minLiquidity],
    ["CANCEL_BUY_BEFORE_SEC", settings.cancelBuyBeforeSec],
    ["CANCEL_SELL_BEFORE_SEC", settings.cancelSellBeforeSec],
  ] as const) {
    if (value < 0) {
      throw new Error(`${name} must be zero or greater.`);
    }
  }
}

function validateBtc5mSettings(settings: Btc5mSettings): void {
  for (const [name, value] of [
    ["BTC5M_BUY_PRICE_LIMIT", settings.buyPriceLimit],
    ["BTC5M_SELL_PRICE_LIMIT", settings.sellPriceLimit],
  ] as const) {
    if (!(value > 0 && value < 1)) {
      throw new Error(`${name} must be between 0 and 1.`);
    }
  }

  if (settings.sellPriceLimit <= settings.buyPriceLimit) {
    throw new Error("BTC5M_SELL_PRICE_LIMIT must be greater than BTC5M_BUY_PRICE_LIMIT.");
  }

  for (const [name, value] of [
    ["BTC5M_ORDER_SIZE", settings.orderSize],
    ["BTC5M_MARKET_SCAN_INTERVAL_SEC", settings.marketScanIntervalSec],
  ] as const) {
    if (value <= 0) {
      throw new Error(`${name} must be greater than zero.`);
    }
  }
}

function validateBtc15mSettings(settings: Btc15mSettings): void {
  if (!(settings.buyPriceLimit > 0 && settings.buyPriceLimit < 1)) {
    throw new Error("BTC15M_BUY_PRICE_LIMIT must be between 0 and 1.");
  }
  if (
    settings.maxBuyPriceLimit !== undefined &&
    !(settings.maxBuyPriceLimit > 0 && settings.maxBuyPriceLimit < 1)
  ) {
    throw new Error("BTC15M_MAX_BUY_PRICE_LIMIT must be between 0 and 1.");
  }
  if (
    settings.maxBuyPriceLimit !== undefined &&
    settings.maxBuyPriceLimit <= settings.buyPriceLimit
  ) {
    throw new Error("BTC15M_MAX_BUY_PRICE_LIMIT must be greater than BTC15M_BUY_PRICE_LIMIT.");
  }

  for (const [name, value] of [
    ["BTC15M_TRAIL_STEP", settings.trailStep],
    ["BTC15M_TRAIL_DIST", settings.trailDist],
    ["BTC15M_TRAIL_UPDATE_SEC", settings.trailUpdateIntervalSec],
  ] as [string, number][]) {
    if (!(value > 0)) throw new Error(`${name} must be greater than zero.`);
  }

  if (settings.trailStep <= settings.trailDist) {
    throw new Error("BTC15M_TRAIL_STEP must be greater than BTC15M_TRAIL_DIST.");
  }

  for (const [name, value] of [
    ["BTC15M_ORDER_SIZE", settings.orderSize],
    ["BTC15M_WORKING_BUDGET", settings.workingBudgetUsd],
    ["BTC15M_REPEAT_MIN", settings.repeatThresholdMin],
    ["BTC15M_FORCE_SELL_MIN", settings.forceSellThresholdMin],
    ["BTC15M_NEUTRAL_ZONE_USD", settings.neutralZoneUsd],
    ["BTC15M_TICK_INTERVAL_SEC", settings.tickIntervalSec],
  ] as const) {
    if (value <= 0) {
      throw new Error(`${name} must be greater than zero.`);
    }
  }

  if (settings.forceSellThresholdMin >= 15) {
    throw new Error("BTC15M_FORCE_SELL_MIN must be less than the 15-minute window.");
  }
}

function validateBtc15mHedgeSettings(settings: Btc15mHedgeSettings): void {
  if (
    settings.targetCombinedPrice !== null &&
    !(settings.targetCombinedPrice > 0 && settings.targetCombinedPrice < 1)
  ) {
    throw new Error("BTC15M_HEDGE_TARGET_COMBINED_PRICE must be between 0 and 1.");
  }

  for (const [name, value] of [
    ["BTC15M_HEDGE_WORKING_BUDGET", settings.workingBudgetUsd],
    ["BTC15M_HEDGE_ORDER_SIZE", settings.orderSize],
    ["BTC15M_HEDGE_ENTRY_CUTOFF_MIN", settings.entryCutoffMin],
    ["BTC15M_HEDGE_FORCE_UNWIND_MIN", settings.forceUnwindThresholdMin],
    ["BTC15M_HEDGE_TICK_INTERVAL_SEC", settings.tickIntervalSec],
  ] as const) {
    if (value <= 0) {
      throw new Error(`${name} must be greater than zero.`);
    }
  }

  if (settings.entryCutoffMin >= 15) {
    throw new Error("BTC15M_HEDGE_ENTRY_CUTOFF_MIN must be less than the 15-minute window.");
  }

  if (settings.forceUnwindThresholdMin >= 15) {
    throw new Error("BTC15M_HEDGE_FORCE_UNWIND_MIN must be less than the 15-minute window.");
  }

  if (settings.forceUnwindThresholdMin >= settings.entryCutoffMin) {
    throw new Error("BTC15M_HEDGE_FORCE_UNWIND_MIN must be less than BTC15M_HEDGE_ENTRY_CUTOFF_MIN.");
  }
}
