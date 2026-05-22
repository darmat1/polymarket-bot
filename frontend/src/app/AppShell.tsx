import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { APP_TABS } from "./tabs";
import { useAccountSummary } from "../shared/hooks/useAccountSummary";
import { Header } from "../shared/ui/Header";
import { Tabs } from "../shared/ui/Tabs";
import type { AccountSummaryPayload } from "../shared/types/api";
import type { AppTab, ShellControls } from "../shared/types/app";

export type AppShellRenderProps = {
  accountError: string | null;
  accountSummary: AccountSummaryPayload | null;
  activeTab: AppTab;
  isRefreshingAccountSummary: boolean;
  setTabsVisible: (visible: boolean) => void;
  shellControls: ShellControls;
};

type AppShellProps = {
  children: (props: AppShellRenderProps) => ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  const [activeTab, setActiveTab] = useState<AppTab>("positions");
  const [tabsVisible, setTabsVisible] = useState(true);
  const {
    accountSummary,
    accountError,
    loading,
    refreshAccountSummary,
  } = useAccountSummary();

  useEffect(() => {
    void refreshAccountSummary();
  }, [refreshAccountSummary]);

  useEffect(() => {
    setTabsVisible(true);
  }, [activeTab]);

  const handleRefresh = useCallback(() => {
    void refreshAccountSummary();
  }, [refreshAccountSummary]);

  const shellControls = useMemo<ShellControls>(
    () => ({
      refreshAccountSummary,
    }),
    [refreshAccountSummary],
  );

  return (
    <div className="shell">
      <Header
        accountError={accountError}
        accountSummary={accountSummary}
        isRefreshing={loading}
        onRefresh={handleRefresh}
      />
      {tabsVisible ? (
        <Tabs
          activeTab={activeTab}
          onChange={setActiveTab}
          tabs={APP_TABS}
        />
      ) : null}
      {children({
        accountError,
        accountSummary,
        activeTab,
        isRefreshingAccountSummary: loading,
        setTabsVisible,
        shellControls,
      })}
    </div>
  );
}
