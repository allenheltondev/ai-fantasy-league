import { useRef } from 'react';
import { useLocation } from 'react-router';
import { useToast } from '@readysetcloud/ui';
import { useLeagueApi } from '../api/league';
import { CHAT_EVENT, connectMomentoEvents, useLiveEvents, type EventConnect } from './leagueEvents';
import { NOTIFY_EVENTS, notificationFor } from './notifications';

/** How many event ids to remember for de-duplication (an award arrives on two topics). */
const SEEN_LIMIT = 100;

/**
 * Toasts for live league news while you're anywhere in the league: waiver awards, trade offers,
 * accepted, completed, and vetoed trades, and chat mentions (not while you're reading the chat).
 * Renders nothing; the design system's ToastProvider shows the toasts.
 */
export function LeagueNotifications({
  leagueId,
  yourTeamId,
  connect = connectMomentoEvents
}: {
  leagueId: string;
  yourTeamId: string | null;
  connect?: EventConnect;
}) {
  const api = useLeagueApi();
  const { toast } = useToast();
  const { pathname } = useLocation();
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
      const note = notificationFor(event, yourTeamId);
      if (note !== null) toast(note.message, { variant: note.variant });
    }
  });
  return null;
}
