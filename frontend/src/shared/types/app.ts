export type AppTab =
  | "positions"
  | "weather"
  | "split"
  | "btc5m"
  | "btc15m"
  | "btc15mAuto"
  | "btc15mHedge";

export type ShellControls = {
  refreshAccountSummary: () => Promise<void>;
};
