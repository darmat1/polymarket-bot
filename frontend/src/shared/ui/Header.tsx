import { formatMoneyValue, formatUsdcValue, shortenAddress } from "../lib/format";
import type { AccountSummaryPayload } from "../types/api";

type HeaderProps = {
  accountSummary: AccountSummaryPayload | null;
  accountError: string | null;
  isRefreshing: boolean;
  onRefresh: () => void;
};

export function Header({
  accountSummary,
  accountError,
  isRefreshing,
  onRefresh,
}: HeaderProps) {
  const portfolioValue = accountSummary
    ? formatMoneyValue(accountSummary.portfolio_value)
    : "—";
  const availableToTrade = accountSummary
    ? formatMoneyValue(accountSummary.available_to_trade)
    : "—";
  const walletUsdc = accountSummary
    ? formatUsdcValue(accountSummary.usdc_balance)
    : "—";
  const modeClassName = accountSummary
    ? `topbar-mode ${accountSummary.dry_run ? "dry" : "live"}`
    : "topbar-mode";
  const modeLabel = accountSummary
    ? accountSummary.dry_run
      ? "dry-run"
      : "live"
    : "unknown";

  return (
    <header className="topbar">
      <div className="topbar-metrics">
        <div className="topbar-metric">
          <span className="topbar-label">Portfolio</span>
          <strong className="topbar-value">{portfolioValue}</strong>
        </div>
        <div className="topbar-metric">
          <span className="topbar-label">Available</span>
          <strong className="topbar-value">{availableToTrade}</strong>
        </div>
        <div className="topbar-metric">
          <span className="topbar-label">Wallet USDC</span>
          <strong className="topbar-value">{walletUsdc}</strong>
        </div>
      </div>

      <div className="topbar-side">
        <button
          className="button button-secondary button-small"
          disabled={isRefreshing}
          onClick={onRefresh}
          type="button"
        >
          {isRefreshing ? "Refreshing..." : "Refresh Balance"}
        </button>
        <span className="topbar-meta">
          {accountSummary?.address
            ? shortenAddress(accountSummary.address)
            : accountError
              ? accountError
              : "No wallet"}
        </span>
        <span className={modeClassName}>{modeLabel}</span>
      </div>
    </header>
  );
}
