export type AppTab = "weather" | "positions" | "btc5m" | "btc15m";

export type ShellControls = {
  refreshAccountSummary: () => Promise<void>;
};
