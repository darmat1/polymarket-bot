import { type ApiKeyCreds } from "@polymarket/clob-client-v2";
import { ethers } from "ethers";

import { hasL2Creds, loadSettings } from "./config.js";
import { TradingClient } from "./trading.js";

let runtimeApiCreds: ApiKeyCreds | null = null;
let runtimeApiCredsPromise: Promise<ApiKeyCreds | null> | null = null;
let lastRuntimeApiCredsError: string | null = null;
let runtimeApiCredsSource: "derived" | "env-fallback" | "unavailable" = "unavailable";

export async function initializeRuntimeApiCreds(): Promise<ApiKeyCreds | null> {
  if (runtimeApiCreds) {
    return runtimeApiCreds;
  }

  if (!runtimeApiCredsPromise) {
    runtimeApiCredsPromise = deriveRuntimeApiCreds().finally(() => {
      if (!runtimeApiCreds) {
        runtimeApiCredsPromise = null;
      }
    });
  }

  return runtimeApiCredsPromise;
}

export async function getRuntimeTradingClient(): Promise<TradingClient> {
  const settings = loadSettings();
  const baseClient = new TradingClient(settings);
  const runtimeCreds = await initializeRuntimeApiCreds();

  if (!runtimeCreds) {
    return baseClient;
  }

  return baseClient.withApiCreds(runtimeCreds);
}

export function getRuntimeAuthState(): {
  signerAddress: string | null;
  funderAddress: string | null;
  signatureType: number;
  credsLoaded: boolean;
  credsSource: "derived" | "env-fallback" | "unavailable";
  keyPreview: string | null;
  passphrasePreview: string | null;
  lastError: string | null;
} {
  const settings = loadSettings();
  const signerAddress = settings.privateKey ? new ethers.Wallet(normalizePrivateKey(settings.privateKey)).address : null;

  return {
    signerAddress,
    funderAddress: settings.funderAddress ?? null,
    signatureType: settings.signatureType,
    credsLoaded: runtimeApiCreds !== null,
    credsSource: runtimeApiCredsSource,
    keyPreview: runtimeApiCreds?.key ? `${runtimeApiCreds.key.slice(0, 8)}...` : null,
    passphrasePreview: runtimeApiCreds?.passphrase ? `${runtimeApiCreds.passphrase.slice(0, 8)}...` : null,
    lastError: lastRuntimeApiCredsError,
  };
}

async function deriveRuntimeApiCreds(): Promise<ApiKeyCreds | null> {
  const settings = loadSettings();
  if (!settings.privateKey) {
    runtimeApiCredsSource = "unavailable";
    return null;
  }

  try {
    const client = new TradingClient(settings);
    const creds = sanitizeApiCreds(await client.createOrDeriveApiCredsRaw());
    if (!creds) {
      throw new Error("Derived API credential payload was empty or malformed.");
    }
    runtimeApiCreds = creds;
    runtimeApiCredsSource = "derived";
    lastRuntimeApiCredsError = null;
    return creds;
  } catch (error) {
    lastRuntimeApiCredsError = error instanceof Error ? error.message : String(error);

    if (hasL2Creds(settings)) {
      runtimeApiCreds = {
        key: settings.apiKey!,
        secret: settings.apiSecret!,
        passphrase: settings.apiPassphrase!,
      };
      runtimeApiCredsSource = "env-fallback";
      return runtimeApiCreds;
    }

    runtimeApiCredsSource = "unavailable";
    return null;
  }
}

/**
 * Force clears cached L2 credentials and re-derives them from scratch.
 * Use this when the current credentials are stale/invalid (401 errors).
 */
export async function forceRederiveApiCreds(): Promise<ApiKeyCreds | null> {
  // Clear all cached state
  runtimeApiCreds = null;
  runtimeApiCredsPromise = null;
  lastRuntimeApiCredsError = null;
  runtimeApiCredsSource = "unavailable";
  // Re-run derivation
  return initializeRuntimeApiCreds();
}

function normalizePrivateKey(value: string): `0x${string}` {
  return (value.startsWith("0x") ? value : `0x${value}`) as `0x${string}`;
}

function sanitizeApiCreds(value: unknown): ApiKeyCreds | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const maybeCreds = value as Partial<ApiKeyCreds>;
  if (
    typeof maybeCreds.key === "string" &&
    maybeCreds.key !== "" &&
    typeof maybeCreds.secret === "string" &&
    maybeCreds.secret !== "" &&
    typeof maybeCreds.passphrase === "string" &&
    maybeCreds.passphrase !== ""
  ) {
    return {
      key: maybeCreds.key,
      secret: maybeCreds.secret,
      passphrase: maybeCreds.passphrase,
    };
  }

  return null;
}
