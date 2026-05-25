export type AppTab = "positions" | "btc5m" | "btc15m" | "btc15mAuto" | "btc15mHedge";

export type ShellControls = {
  refreshAccountSummary: () => Promise<void>;
};
