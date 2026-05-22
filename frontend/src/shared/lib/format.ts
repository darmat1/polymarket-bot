import type { Btc15mAutoStatusPayload, Btc15mStatusPayload, Btc5mBotStatus } from "../types/api";

export function formatMaybeNumber(value: number | null) {
  return typeof value === "number" ? value.toFixed(2) : "-";
}

export function formatPercentSigned(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`
    : "-";
}

export function formatBtcPrice(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
    : "-";
}

export function formatCompactBtcPrice(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? `$${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}`
    : "-";
}

export function formatMarketPrice(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(value * 100)}c`
    : "-";
}

export function formatConfidence(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? `(${Math.round(value * 100)}%)`
    : "";
}

export function formatBalance(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : value;
}

export function formatMoneyValue(value: string | null | undefined) {
  return value !== null && value !== undefined ? `$${formatBalance(value)}` : "$0.00";
}

export function formatUsdcValue(value: string | null | undefined) {
  return value !== null && value !== undefined ? `${formatBalance(value)} USDC` : "0.00 USDC";
}

export function formatUsdValue(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(2)}` : "$0.00";
}

export function formatUsdSigned(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`
    : "$0.00";
}

export function formatSignedUsd(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`
    : "$0.00";
}

export function formatBpsValue(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(value)} bps`
    : "-";
}

export function formatDurationMs(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  if (value < 1000) {
    return `${Math.round(value)}ms`;
  }
  if (value < 60_000) {
    return `${(value / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatCountdownMs(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }

  const totalSeconds = Math.max(0, Math.floor(value / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function shortenAddress(value: string) {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function availableLabel(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function formatPosNum(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(2)
    : "—";
}

export function formatPosDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function formatPosDateParts(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return [iso];
  }

  const day = date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const time = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

  return [day, time];
}

export function formatBtc5mPrice(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(value * 100)}¢`
    : "—";
}

export function formatUsd(value: number | null | undefined) {
  return formatUsdValue(value);
}

export function formatUsdPrice(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(2)}` : "—";
}

export function formatBtcDelta(status: Btc15mStatusPayload | Btc15mAutoStatusPayload | null) {
  if (!status || status.currentBtcPrice === null || status.marketStartBtcPrice === null) {
    return "—";
  }
  const delta = status.currentBtcPrice - status.marketStartBtcPrice;
  return `${delta >= 0 ? "+" : "-"}$${Math.abs(delta).toFixed(2)}`;
}

export function describeBtc5mStatus(status: Btc5mBotStatus | null) {
  if (!status) {
    return "BTC 5m bot status unavailable.";
  }

  switch (status.phase) {
    case "looking_for_market":
      return status.nextMarket
        ? "Next market selected. BUY on UP at 60¢ is queued for 5 shares; waiting for market activation and fill."
        : "Waiting for the next Bitcoin 5-minute market.";
    case "placing_buy":
      return "Placing limit BUY on UP at 60¢.";
    case "buy_open":
      return "BUY order is live. Watching for fill.";
    case "placing_sell":
      return "BUY filled. Placing SELL for all UP shares at 70¢.";
    case "sell_open":
      return "SELL order is live. Waiting for full exit.";
    case "completed_waiting_next":
      return "Trade cycle finished. Waiting for the next 5-minute Bitcoin market.";
    case "error":
      return status.lastError ? `Error: ${status.lastError}` : "BTC 5m bot hit an error.";
    case "idle":
    default:
      return status.active ? "BTC 5m bot is idle." : "BTC 5m bot is stopped.";
  }
}
