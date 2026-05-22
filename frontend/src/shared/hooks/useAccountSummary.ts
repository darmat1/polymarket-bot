import { useCallback, useRef, useState } from "react";

import { getAccountSummary } from "../api/account";
import type { AccountSummaryPayload } from "../types/api";

export function useAccountSummary() {
  const [accountSummary, setAccountSummary] =
    useState<AccountSummaryPayload | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlightRef = useRef<Promise<void> | null>(null);

  const refreshAccountSummary = useCallback(async () => {
    if (inFlightRef.current) {
      return inFlightRef.current;
    }

    const pending = (async () => {
      setLoading(true);
      try {
        const payload = await getAccountSummary();
        setAccountSummary(payload);
        setAccountError(null);
      } catch (error) {
        setAccountError(
          error instanceof Error
            ? error.message
            : "Failed to load account summary",
        );
        setAccountSummary(null);
      } finally {
        setLoading(false);
        inFlightRef.current = null;
      }
    })();

    inFlightRef.current = pending;
    return pending;
  }, []);

  return {
    accountSummary,
    accountError,
    loading,
    refreshAccountSummary,
  };
}
