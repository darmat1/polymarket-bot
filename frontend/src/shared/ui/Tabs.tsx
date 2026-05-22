import type { AppTab } from "../types/app";

type TabDefinition = {
  id: AppTab;
  label: string;
};

type TabsProps = {
  activeTab: AppTab;
  onChange: (tab: AppTab) => void;
  tabs: TabDefinition[];
};

export function Tabs({ activeTab, onChange, tabs }: TabsProps) {
  return (
    <nav className="app-nav">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={`button tab-button ${activeTab === tab.id ? "tab-button-active" : ""}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
