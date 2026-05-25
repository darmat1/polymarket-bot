import React, { createContext, useCallback, useState, useEffect } from 'react';

export interface WeatherSession {
  id: string;
  slug: string;
  city: string;
  date: string;
  event_url: string;
  icao: string | null;
  created_at: string;
}

interface WeatherTabContextType {
  sessions: WeatherSession[];
  activeSessionId: string | null;
  loading: boolean;
  error: string | null;
  openSession(eventUrl: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  setActiveSession(sessionId: string): void;
  refreshSessions(): Promise<void>;
}

export const WeatherTabContext = createContext<WeatherTabContextType | undefined>(undefined);

export function WeatherTabProvider({ children }: { children: React.ReactNode }) {
  const [sessions, setSessions] = useState<WeatherSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshSessions = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/weather/sessions');
      const data = (await response.json()) as { sessions: WeatherSession[] };
      setSessions(data.sessions);
      setError(null);

      // Set first session as active if none selected
      if (!activeSessionId && data.sessions.length > 0) {
        setActiveSessionId(data.sessions[0].id);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load sessions';
      setError(message);
      console.error('[WeatherTabContext] Load sessions error:', err);
    } finally {
      setLoading(false);
    }
  }, [activeSessionId]);

  const openSession = useCallback(
    async (eventUrl: string) => {
      try {
        setLoading(true);
        const response = await fetch('/api/weather/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event_url: eventUrl }),
        });

        if (!response.ok) {
          const data = (await response.json()) as any;
          throw new Error(data.error || 'Failed to create session');
        }

        const session = (await response.json()) as WeatherSession;
        setSessions((prev) => [session, ...prev]);
        setActiveSessionId(session.id);
        setError(null);

        // Background enrichment takes ~2s — refresh to get real city name
        setTimeout(() => {
          fetch('/api/weather/sessions')
            .then((r) => r.json())
            .then((data: { sessions: WeatherSession[] }) => setSessions(data.sessions))
            .catch(() => {});
        }, 3000);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create session';
        setError(message);
        console.error('[WeatherTabContext] Create session error:', err);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const closeSession = useCallback(
    async (sessionId: string) => {
      try {
        const response = await fetch(`/api/weather/session/${sessionId}`, {
          method: 'DELETE',
        });

        if (!response.ok) {
          throw new Error('Failed to close session');
        }

        setSessions((prev) => prev.filter((s) => s.id !== sessionId));

        // Switch to next session if closing active one
        if (activeSessionId === sessionId) {
          const remaining = sessions.filter((s) => s.id !== sessionId);
          setActiveSessionId(remaining.length > 0 ? remaining[0].id : null);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to close session';
        setError(message);
        console.error('[WeatherTabContext] Close session error:', err);
        throw err;
      }
    },
    [activeSessionId, sessions]
  );

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  return (
    <WeatherTabContext.Provider
      value={{
        sessions,
        activeSessionId,
        loading,
        error,
        openSession,
        closeSession,
        setActiveSession: setActiveSessionId,
        refreshSessions,
      }}
    >
      {children}
    </WeatherTabContext.Provider>
  );
}

export function useWeatherTabs(): WeatherTabContextType {
  const context = React.useContext(WeatherTabContext);
  if (!context) {
    throw new Error('useWeatherTabs must be used within WeatherTabProvider');
  }
  return context;
}
