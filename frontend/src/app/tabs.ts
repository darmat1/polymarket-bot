import type { AppTab } from "../shared/types/app";

export const APP_TABS: Array<{ id: AppTab; label: string }> = [
  { id: "positions", label: "Positions" },
  { id: "weather", label: "Weather" },
  { id: "split", label: "Split" },
  { id: "arb", label: "Arb" },
  { id: "btc5m", label: "BTC 5m" },
  { id: "btc15m", label: "BTC 15m" },
  { id: "btc15mAuto", label: "BTC 15m Auto" },
  { id: "btc15mHedge", label: "Hedging" },
];
