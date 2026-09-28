import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Button, Drawer, EmptyState, Loading } from '@readysetcloud/ui';
import { useLeagueApi } from '../api/league';
import { ApiErrorAlert } from '../components/ApiErrorAlert';
import { useNotifications } from './NotificationsContext';
import { notificationHref, type AppNotification } from './types';

/** Items read per league when the panel opens. */
const PER_LEAGUE = 20;

/** "just now", "5m ago", "3h ago", "2d ago", then the date. */
export function timeAgo(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * The notification panel (#165): every league's inbox, newest first, as a sheet from the right
 * (full width on a phone). Opening an item marks it read and goes where it leads: the trade, the
 * roster, or the draft room. "Mark all read" clears every league.
 */
export function NotificationPanel({ onClose, now = Date.now }: { onClose(): void; now?: () => number }) {
  const api = useLeagueApi();
  const { summary, refresh } = useNotifications();
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const leagues = summary === null ? null : summary.leagues;
  const names = new Map(summary?.leagues.map((l) => [l.leagueId, l.name]));
  const leagueKey = [...names.keys()].join(',');

  useEffect(() => {
    if (leagues === null) return undefined;
    let current = true;
    Promise.all(leagues.map((l) => api.listNotifications(l.leagueId, { limit: PER_LEAGUE }))).then(
      (inboxes) => {
        if (!current) return;
        const all = inboxes.flatMap((i) => i.notifications);
        setItems(all.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)));
      },
      (e: unknown) => current && setError(e)
    );
    return () => {
      current = false;
    };
    // Re-read when the set of leagues changes, not on every summary poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, leagueKey]);

  const unread = (items ?? []).filter((n) => !n.read);
  const markRead = (ids: Set<string>) =>
    // Only called once the items are on screen.
    setItems((list) => (list as AppNotification[]).map((n) => (ids.has(n.id) ? { ...n, read: true } : n)));

  const open = (n: AppNotification) => {
    if (!n.read) {
      markRead(new Set([n.id]));
      void api.markNotificationsRead(n.leagueId, { notificationIds: [n.id] }).then(refresh, setError);
    }
    onClose();
  };

  const markAll = async () => {
    setError(null);
    const leaguesWithUnread = [...new Set(unread.map((n) => n.leagueId))];
    try {
      await Promise.all(leaguesWithUnread.map((id) => api.markNotificationsRead(id, { all: true })));
      markRead(new Set(unread.map((n) => n.id)));
    } catch (e) {
      setError(e);
    }
    refresh();
  };

  return (
    <Drawer
      open
      modal
      hideTab
      side="right"
      size="min(24rem, 100vw)"
      title="Notifications"
      titleAs="h2"
      aria-label="Notifications"
      bodyClassName="p-0"
      // The panel is open while it is mounted: any change is a close.
      onOpenChange={() => onClose()}
    >
      <div className="flex min-h-11 items-center justify-between gap-2 border-b border-border px-4 py-2">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {items === null ? 'Loading…' : unread.length === 0 ? 'All caught up' : `${unread.length} unread`}
        </p>
        {unread.length > 0 ? (
          <Button size="sm" variant="secondary" className="min-h-11" onClick={() => void markAll()}>
            Mark all read
          </Button>
        ) : null}
      </div>
      <div className="px-4 pt-2">
        <ApiErrorAlert error={error} />
      </div>
      {items === null && error === null ? (
        <Loading text="Loading notifications" className="p-6" />
      ) : items !== null && items.length === 0 ? (
        <div className="p-4">
          <EmptyState
            title="You're all caught up"
            description="Trade offers, waiver results, and your turn in the draft show up here."
          />
        </div>
      ) : (
        <ul aria-label="Notifications" className="divide-y divide-border">
          {(items ?? []).map((n, i) => (
            <li key={n.id} className="motion-stagger" style={{ ['--motion-i' as string]: Math.min(i, 10) }}>
              <Link
                to={notificationHref(n)}
                onClick={() => open(n)}
                aria-label={`${n.read ? '' : 'Unread: '}${n.title}`}
                data-testid={`notification-${n.kind}`}
                className={`motion-row flex min-h-11 gap-3 px-4 py-3 text-left no-underline ${
                  n.read ? 'text-muted-foreground' : 'bg-primary-50/60 text-foreground'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${n.read ? 'bg-transparent' : 'bg-error-600'}`}
                />
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className={`block break-words ${n.read ? '' : 'font-semibold'}`}>{n.title}</span>
                  <span className="block break-words text-sm">{n.body}</span>
                  <span className="block text-xs text-muted-foreground">
                    {timeAgo(n.createdAt, now())}
                    {names.size > 1 ? ` · ${names.get(n.leagueId) as string}` : ''}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}
