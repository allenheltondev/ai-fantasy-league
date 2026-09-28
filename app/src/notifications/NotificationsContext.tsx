import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { useLeagueApi } from '../api/league';
import { useLoad } from '../lib/useLoad';
import type { NotificationSummary } from './types';

/**
 * The signed-in person's notification summary (#165): unread items and trade offers waiting, per
 * league (get_notification_summary). The bell and the league nav's Trades badge read it. It is
 * polled, re-read on every navigation and whenever the tab comes back into view, and refreshed at
 * once when a live `Notification Created` arrives (`LeagueNotifications`).
 */

/** How often the summary is polled while the app is open. */
export const SUMMARY_POLL_MS = 60_000;

export interface NotificationsState {
  summary: NotificationSummary | null;
  /** Unread notifications in every league. */
  unreadCount: number;
  /** Open trade offers waiting on your answer in one league. */
  offersWaiting(leagueId: string): number;
  /** Re-reads the summary. */
  refresh(): void;
}

const NONE: NotificationsState = {
  summary: null,
  unreadCount: 0,
  offersWaiting: () => 0,
  refresh: () => undefined
};

const NotificationsContext = createContext<NotificationsState>(NONE);

export function useNotifications(): NotificationsState {
  return useContext(NotificationsContext);
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const api = useLeagueApi();
  const { pathname } = useLocation();
  const summary = useLoad(() => api.getNotificationSummary(), 'summary', SUMMARY_POLL_MS);
  const { reload } = summary;

  // A navigation (answering an offer, opening the draft) may change what is waiting.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    reload();
  }, [pathname, reload]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [reload]);

  const data = summary.data;
  const offersWaiting = useCallback(
    (leagueId: string) => data?.leagues.find((l) => l.leagueId === leagueId)?.tradeOffersWaiting ?? 0,
    [data]
  );
  const value = useMemo<NotificationsState>(
    () => ({ summary: data, unreadCount: data?.unreadCount ?? 0, offersWaiting, refresh: reload }),
    [data, offersWaiting, reload]
  );
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}
