import { useEffect } from "react";
import { useToasts } from "./shared/hooks/useToasts";
import type { AppShellRenderProps } from "./app/AppShell";
import { Btc5mScreen } from "./screens/btc5m/Btc5mScreen";
import { Btc15mScreen } from "./screens/btc15m/Btc15mScreen";
import { Btc15mAutoScreen } from "./screens/btc15mAuto/Btc15mAutoScreen";
import { Btc15mHedgeScreen } from "./screens/btc15mHedge/Btc15mHedgeScreen";
import { PositionsScreen } from "./screens/positions/PositionsScreen";

type AppProps = AppShellRenderProps;

export function App({ activeTab, setTabsVisible, shellControls }: AppProps) {
  const { addToast, removeToast, toasts } = useToasts();

  useEffect(() => {
    setTabsVisible(true);
  }, [activeTab, setTabsVisible]);

  return (
    <>
      <div className="toast-stack">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.type}`}>
            <span className="toast-icon">
              {toast.type === "error" ? "✖" : toast.type === "warn" ? "⚠" : toast.type === "success" ? "✔" : "ℹ"}
            </span>
            <div className="toast-body">
              <strong>{toast.title}</strong>
              <span>{toast.message}</span>
            </div>
            <button className="toast-close" onClick={() => removeToast(toast.id)}>
              ×
            </button>
          </div>
        ))}
      </div>

      {activeTab === "positions" ? (
        <PositionsScreen
          addToast={addToast}
          setTabsVisible={setTabsVisible}
          shellControls={shellControls}
        />
      ) : activeTab === "btc5m" ? (
        <Btc5mScreen addToast={addToast} refreshAccountSummary={shellControls.refreshAccountSummary} />
      ) : activeTab === "btc15mAuto" ? (
        <Btc15mAutoScreen addToast={addToast} />
      ) : activeTab === "btc15mHedge" ? (
        <Btc15mHedgeScreen addToast={addToast} />
      ) : (
        <Btc15mScreen addToast={addToast} />
      )}
    </>
  );
}
