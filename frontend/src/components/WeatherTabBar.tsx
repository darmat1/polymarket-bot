import React, { useState } from 'react';
import { useWeatherTabs } from '../context/WeatherTabContext.js';
import styles from './WeatherTabBar.module.css';

export function WeatherTabBar() {
  const { sessions, activeSessionId, openSession, closeSession, setActiveSession, loading } =
    useWeatherTabs();
  const [showNewInput, setShowNewInput] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);

  const handleOpenNew = async () => {
    if (!inputValue.trim()) return;

    try {
      setInputError(null);
      await openSession(inputValue.trim());
      setInputValue('');
      setShowNewInput(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to open session';
      setInputError(message);
      console.error('Failed to open session:', error);
    }
  };

  return (
    <div className={styles.tabBar}>
      <div className={styles.tabs}>
        {sessions.map((session) => (
          <div
            key={session.id}
            className={`${styles.tab} ${activeSessionId === session.id ? styles.active : ''}`}
            onClick={() => setActiveSession(session.id)}
          >
            <span className={styles.tabLabel}>
              {session.city} • {session.date}
            </span>
            <button
              className={styles.closeBtn}
              onClick={(e) => {
                e.stopPropagation();
                closeSession(session.id).catch(console.error);
              }}
              title="Close tab"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {!showNewInput && (
        <button
          className={styles.newBtn}
          onClick={() => {
            setShowNewInput(true);
            setInputError(null);
          }}
          disabled={loading}
        >
          +
        </button>
      )}

      {showNewInput && (
        <div className={styles.inputGroup}>
          <input
            type="text"
            placeholder="https://polymarket.com/event/..."
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value);
              setInputError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleOpenNew();
              }
              if (e.key === 'Escape') {
                setShowNewInput(false);
                setInputError(null);
              }
            }}
            autoFocus
          />
          <button onClick={handleOpenNew} disabled={!inputValue.trim() || loading}>
            Load
          </button>
          <button
            onClick={() => {
              setShowNewInput(false);
              setInputError(null);
            }}
          >
            Cancel
          </button>
          {inputError && <div className={styles.inputError}>{inputError}</div>}
        </div>
      )}
    </div>
  );
}
