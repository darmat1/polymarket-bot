export type AppTab = "positions" | "btc5m" | "btc15m" | "btc15mAuto";

export type ShellControls = {
  refreshAccountSummary: () => Promise<void>;
};
