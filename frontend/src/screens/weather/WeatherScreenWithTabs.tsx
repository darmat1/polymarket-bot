import React from 'react';
import { WeatherTabBar } from '../../components/WeatherTabBar.js';
import { useWeatherTabs } from '../../context/WeatherTabContext.js';
import { useWeatherWebSocket } from '../../hooks/useWeatherWebSocket.js';
import { WeatherScreen } from './WeatherScreen.js';
import type { AddToast } from './WeatherScreen';
import type { ShellControls } from '../../shared/types/app';
import styles from './WeatherScreenWithTabs.module.css';

interface WeatherScreenWithTabsProps {
  addToast: AddToast;
  shellControls: ShellControls;
}

export function WeatherScreenWithTabs(props: WeatherScreenWithTabsProps) {
  const { sessions, activeSessionId, error: tabError } = useWeatherTabs();
  const activeSession = sessions.find((s) => s.id === activeSessionId);

  const { markets, weather: wsWeather, tokenPrices, isConnected, error: wsError } = useWeatherWebSocket(
    activeSessionId || '',
    activeSession?.slug || ''
  );

  const error = tabError || wsError;
  const connectionStatus =
    !isConnected && activeSession ? 'Reconnecting...' : isConnected ? 'Connected' : null;

  return (
    <div className={styles.weatherScreenWithTabs}>
      <WeatherTabBar />

      {error && <div className={styles.errorBanner}>{error}</div>}
      {connectionStatus && <div className={styles.statusBanner}>{connectionStatus}</div>}

      {!activeSession ? (
        <div className={styles.emptyState}>
          <p>📍 No weather markets loaded</p>
          <p>Use [+ New] to add a Polymarket event and start trading</p>
        </div>
      ) : (
        <div className={styles.screenContent}>
          {/* key forces remount on tab switch, initialUrl auto-loads the event */}
          <WeatherScreen
            key={activeSessionId}
            {...props}
            initialUrl={activeSession.event_url}
            wsWeather={wsWeather}
            tokenPrices={tokenPrices}
          />
        </div>
      )}
    </div>
  );
}
