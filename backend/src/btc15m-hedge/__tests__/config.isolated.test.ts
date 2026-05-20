import assert from "node:assert/strict";

import { loadSettings } from "../../config.js";

function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void,
): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function main() {
  withEnv(
    {
      BTC15M_HEDGE_TARGET_COMBINED_PRICE: "1.2",
    },
    () => {
      assert.throws(
        () => loadSettings(),
        /BTC15M_HEDGE_TARGET_COMBINED_PRICE must be between 0 and 1/,
      );
    },
  );

  withEnv(
    {
      BTC15M_HEDGE_TARGET_COMBINED_PRICE: "",
      BTC15M_HEDGE_ENTRY_CUTOFF_MIN: "2",
      BTC15M_HEDGE_FORCE_UNWIND_MIN: "2",
    },
    () => {
      assert.throws(
        () => loadSettings(),
        /BTC15M_HEDGE_FORCE_UNWIND_MIN must be less than BTC15M_HEDGE_ENTRY_CUTOFF_MIN/,
      );
    },
  );

  withEnv(
    {
      BTC15M_HEDGE_TARGET_COMBINED_PRICE: "",
      BTC15M_HEDGE_ENTRY_CUTOFF_MIN: "6",
      BTC15M_HEDGE_FORCE_UNWIND_MIN: "2",
    },
    () => {
      const settings = loadSettings();
      assert.equal(settings.btc15mHedge.targetCombinedPrice, null);
    },
  );

  console.log("btc15m hedge config: OK");
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
