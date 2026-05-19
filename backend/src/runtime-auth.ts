import { type ApiKeyCreds } from "@polymarket/clob-client-v2";
import { ethers } from "ethers";

import { hasL2Creds, loadSettings } from "./config.js";
import { TradingClient } from "./trading.js";

let runtimeApiCreds: ApiKeyCreds | null = null;
let runtimeApiCredsPromise: Promise<ApiKeyCreds | null> | null = null;
let runtimeTradingClient: TradingClient | null = null;
let lastRuntimeApiCredsError: string | null = null;
let runtimeApiCredsSource: "env" | "unavailable" = "unavailable";

export async function initializeRuntimeApiCreds(): Promise<ApiKeyCreds | null> {
  if (runtimeApiCreds) {
    return runtimeApiCreds;
  }

  if (!runtimeApiCredsPromise) {
    runtimeApiCredsPromise = loadRuntimeApiCredsFromEnv().finally(() => {
      if (!runtimeApiCreds) {
        runtimeApiCredsPromise = null;
      }
    });
  }

  return runtimeApiCredsPromise;
}

export async function getRuntimePolymarketService(): Promise<TradingClient> {
  if (runtimeTradingClient) {
    return runtimeTradingClient;
  }

  const settings = loadSettings();
  const baseClient = new TradingClient(settings);
  const runtimeCreds = await initializeRuntimeApiCreds();

  runtimeTradingClient = runtimeCreds
    ? baseClient.withApiCreds(runtimeCreds)
    : baseClient;

  return runtimeTradingClient;
}

export async function getRuntimeTradingClient(): Promise<TradingClient> {
  return getRuntimePolymarketService();
}

export async function getRuntimeApiCreds(): Promise<ApiKeyCreds | null> {
  return initializeRuntimeApiCreds();
}

export function getRuntimeAuthState(): {
  signerAddress: string | null;
  funderAddress: string | null;
  signatureType: number;
  credsLoaded: boolean;
  credsSource: "env" | "unavailable";
  keyPreview: string | null;
  passphrasePreview: string | null;
  lastError: string | null;
} {
  const settings = loadSettings();
  const signerAddress = settings.privateKey
    ? new ethers.Wallet(normalizePrivateKey(settings.privateKey)).address
    : null;

  return {
    signerAddress,
    funderAddress: settings.funderAddress ?? null,
    signatureType: settings.signatureType,
    credsLoaded: runtimeApiCreds !== null,
    credsSource: runtimeApiCredsSource,
    keyPreview: runtimeApiCreds?.key
      ? `${runtimeApiCreds.key.slice(0, 8)}...`
      : null,
    passphrasePreview: runtimeApiCreds?.passphrase
      ? `${runtimeApiCreds.passphrase.slice(0, 8)}...`
      : null,
    lastError: lastRuntimeApiCredsError,
  };
}

async function loadRuntimeApiCredsFromEnv(): Promise<ApiKeyCreds | null> {
  const settings = loadSettings();
  if (!hasL2Creds(settings)) {
    lastRuntimeApiCredsError =
      "L2 credentials (POLYMARKET_API_KEY / SECRET / PASSPHRASE) are missing from env.";
    runtimeApiCredsSource = "unavailable";
    return null;
  }

  runtimeApiCreds = {
    key: settings.apiKey!,
    secret: settings.apiSecret!,
    passphrase: settings.apiPassphrase!,
  };
  runtimeApiCredsSource = "env";
  lastRuntimeApiCredsError = null;
  return runtimeApiCreds;
}

export async function forceReloadApiCreds(): Promise<ApiKeyCreds | null> {
  runtimeApiCreds = null;
  runtimeApiCredsPromise = null;
  runtimeTradingClient = null;
  lastRuntimeApiCredsError = null;
  runtimeApiCredsSource = "unavailable";
  return initializeRuntimeApiCreds();
}

function normalizePrivateKey(value: string): `0x${string}` {
  return (value.startsWith("0x") ? value : `0x${value}`) as `0x${string}`;
}
