import { useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useToast } from '@readysetcloud/ui';
import { useLeagueApi } from '../api/league';
import { useNotifications } from '../notifications/NotificationsContext';
import { CHAT_EVENT, connectLiveEvents, useLiveEvents, type EventConnect } from './leagueEvents';
import { NOTIFICATION_EVENT, NOTIFY_EVENTS, notificationFor } from './notifications';

/** How many event ids to remember for de-duplication (an award arrives on two channels). */
const SEEN_LIMIT = 100;

/**
 * Toasts for live league news while you're anywhere in the league: new items in your notification
 * inbox (#165: trade offers and answers, waiver results, your turn in the draft), trades between
 * other teams up for review or vetoed, and chat mentions and direct messages, each linking to where
 * it leads (chat not while you're reading the chat). An inbox toast marks its item delivered, its
 * Open link marks it read, and the bell's count refreshes as it arrives.
 * Renders nothing; the design system's ToastProvider shows the toasts.
 */
export function LeagueNotifications({
  leagueId,
  yourTeamId,
  connect = connectLiveEvents
}: {
  leagueId: string;
  yourTeamId: string | null;
  connect?: EventConnect;
}) {
  const api = useLeagueApi();
  const { refresh } = useNotifications();
  const { toast } = useToast();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const seen = useRef<string[]>([]);
  useLiveEvents({
    leagueId,
    types: NOTIFY_EVENTS,
    realtime: api.getRealtime,
    connect,
    onEvent: (event) => {
      if (event.detailType === CHAT_EVENT && pathname.endsWith('/chat')) return;
      if (event.eventId !== undefined) {
        const id = `${event.detailType}:${event.eventId}`;
        if (seen.current.includes(id)) return;
        seen.current = [...seen.current.slice(-(SEEN_LIMIT - 1)), id];
      }
      if (event.detailType === NOTIFICATION_EVENT) refresh();
      const note = notificationFor(event, yourTeamId);
      if (note === null) return;
      const item = note.inbox;
      if (item !== undefined) {
        void api.markNotificationsDelivered(item.leagueId, [item.id]).catch(() => undefined);
      }
      const href =
        item?.href ??
        (note.roomId === undefined
          ? null
          : `/leagues/${encodeURIComponent(leagueId)}/chat?room=${encodeURIComponent(note.roomId)}`);
      toast(
        href === null ? (
          note.message
        ) : (
          // Toasts render outside the router, so the link navigates through this component's router.
          <span>
            {note.message}{' '}
            <a
              className="font-semibold underline"
              href={href}
              onClick={(e) => {
                e.preventDefault();
                if (item !== undefined) {
                  void api
                    .markNotificationsRead(item.leagueId, { notificationIds: [item.id] })
                    .then(refresh, () => undefined);
                }
                void navigate(href);
              }}
            >
              Open
            </a>
          </span>
        ),
        { variant: note.variant }
      );
    }
  });
  return null;
}
