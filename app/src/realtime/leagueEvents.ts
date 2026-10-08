import { useEffect, useRef, useState } from 'react';
import type { RealtimeInfo } from '../chat/api';
import { parseChatItem, subscribeToken } from '../chat/realtime';

/**
 * Live league events over AWS AppSync Events, for pages that refresh when something happens (the
 * draft board on a pick, the matchup on new scores). The realtime publisher relays each league event
 * to `/fantasy/league/<id>`, results for one team to that team's channel for its current occupant
 * (`/fantasy/team/<id>/<teamId>/<tenureKey>`), and league-less ones (the live-stats job's
 * `Scores Updated`) to `/fantasy/global`, as `{ type: 'event', detailType, leagueId, ... }`
 * (packages/server/src/realtime/relay.ts).
 *
 * Events only say *that* something changed: pages re-read through the API, which stays the source of
 * truth. Polling is the fallback whenever realtime is off (local dev, e2e) or the subscription fails.
 */

export interface LeagueEvent {
  detailType: string;
  /** Null for events on the global channel. */
  leagueId: string | null;
  /** The bus event id, when relayed: the same event can arrive on the league and the team channel. */
  eventId?: string;
  /** The event detail as relayed (packages/server/src/events/details.ts), for toasts. */
  detail?: Record<string, unknown>;
}

export interface EventTarget {
  httpHost: string;
  realtimeHost: string;
  channels: string[];
}

/** Opens subscriptions to every channel and resolves to a function that closes them all. */
export type EventConnect = (
  target: EventTarget,
  handlers: { onEvent(event: LeagueEvent): void; onError(): void }
) => Promise<() => void>;

export type LiveStatus = 'loading' | 'live' | 'polling';

/** The subscription target when realtime is on and the config is complete, else null. */
export function eventTarget(info: RealtimeInfo, global: boolean): EventTarget | null {
  if (!info.enabled || info.httpHost === null || info.realtimeHost === null || info.channels === null) {
    return null;
  }
  // The caller's own team channel (their waiver awards and trade offers) rides along when they have one.
  const team = info.channels.team ?? null;
  const channels = [
    info.channels.league,
    ...(team === null ? [] : [team]),
    ...(global ? [info.channels.global] : [])
  ];
  return { httpHost: info.httpHost, realtimeHost: info.realtimeHost, channels };
}

/** The league event in a channel event, or null for chat messages and anything malformed. */
export function parseEventItem(raw: string): LeagueEvent | null {
  try {
    const value = JSON.parse(raw) as {
      type?: unknown;
      detailType?: unknown;
      leagueId?: unknown;
      eventId?: unknown;
      detail?: unknown;
    };
    if (value.type !== 'event' || typeof value.detailType !== 'string') return null;
    return {
      detailType: value.detailType,
      leagueId: typeof value.leagueId === 'string' ? value.leagueId : null,
      ...(typeof value.eventId === 'string' ? { eventId: value.eventId } : {}),
      ...(isRecord(value.detail) ? { detail: value.detail } : {})
    };
  } catch {
    return null;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Chat messages ride the league channel as `{ type: 'chat' }`; they surface as this event type. */
export const CHAT_EVENT = 'Chat Message Posted';

/**
 * A channel event as a league event: relayed events as they are, and chat messages as a `CHAT_EVENT`
 * whose detail holds the message (for mention toasts). Null for anything else.
 */
export function parseTopicItem(raw: string): LeagueEvent | null {
  const event = parseEventItem(raw);
  if (event !== null) return event;
  const message = parseChatItem(raw);
  return message === null
    ? null
    : {
        detailType: CHAT_EVENT,
        leagueId: typeof message.leagueId === 'string' ? message.leagueId : null,
        eventId: message.id,
        detail: { message }
      };
}

declare global {
  interface Window {
    /** Dev builds only: a stand-in for AppSync Events that e2e tests install to push events (see below). */
    __fantasyEvents?: EventConnect;
  }
}

export const connectLiveEvents: EventConnect = async (target, handlers) => {
  // The e2e suite runs the dev server and cannot reach AppSync, so a page script may stand in for
  // it there and push events. Production builds drop this branch (`import.meta.env.DEV` is false).
  if (import.meta.env.DEV && window.__fantasyEvents) return window.__fantasyEvents(target, handlers);
  const token = await subscribeToken();
  const { subscribeChannels } = await import('./appsyncEvents');
  return subscribeChannels(target, token, {
    onData: (raw) => {
      const event = parseTopicItem(raw);
      if (event !== null) handlers.onEvent(event);
    },
    onError: () => handlers.onError()
  });
};

/** Ask for the realtime config again this long before `refreshAt`. */
const RENEW_EARLY_MS = 60_000;
const MAX_TIMER_MS = 2_147_483_647;

export interface LiveEventsOptions {
  leagueId: string;
  /** The event detail types that matter to the page. */
  types: readonly string[];
  /** Also subscribe to the global channel (for `Scores Updated`, which names no league). */
  global?: boolean;
  /** get_realtime_config. Read when (re)subscribing, so it may change every render. */
  realtime: (leagueId: string) => Promise<RealtimeInfo>;
  /** Must be stable. */
  connect: EventConnect;
  /** Called for each matching event. May change every render. */
  onEvent: (event: LeagueEvent) => void;
}

/**
 * Subscribes to a league's live events while mounted and reports whether the page is live or must
 * poll. Asks for the config again (and resubscribes) before `refreshAt`, and falls back to polling
 * on any failure.
 */
export function useLiveEvents({
  leagueId,
  types,
  global = false,
  realtime,
  connect,
  onEvent
}: LiveEventsOptions): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>('loading');
  const handler = useRef(onEvent);
  const fetchInfo = useRef(realtime);
  useEffect(() => {
    handler.current = onEvent;
    fetchInfo.current = realtime;
  });
  const typeKey = types.join('\n');

  useEffect(() => {
    let stopped = false;
    let close: (() => void) | null = null;
    let renew: ReturnType<typeof setTimeout> | null = null;
    const wanted = new Set(typeKey.split('\n'));
    const disconnect = () => {
      close?.();
      close = null;
    };
    const fallBack = () => {
      disconnect();
      if (!stopped) setStatus('polling');
    };

    const goLive = async (): Promise<void> => {
      const info = await fetchInfo.current(leagueId).catch(() => null);
      if (stopped) return;
      const target = info === null ? null : eventTarget(info, global);
      if (info === null || target === null) return fallBack();
      try {
        const unsubscribe = await connect(target, {
          onEvent: (event) => {
            if (!wanted.has(event.detailType)) return;
            if (event.leagueId !== null && event.leagueId !== leagueId) return;
            handler.current(event);
          },
          onError: fallBack
        });
        if (stopped) return unsubscribe();
        close = unsubscribe;
        setStatus('live');
        const refreshAt = Date.parse(info.refreshAt ?? '');
        if (!Number.isNaN(refreshAt)) {
          const renewIn = refreshAt - Date.now() - RENEW_EARLY_MS;
          // setTimeout fires at once for delays past 2^31 - 1 ms, so cap it.
          renew = setTimeout(
            () => {
              disconnect();
              void goLive();
            },
            Math.min(Math.max(1000, renewIn), MAX_TIMER_MS)
          );
        }
      } catch {
        fallBack();
      }
    };
    void goLive();

    return () => {
      stopped = true;
      disconnect();
      if (renew !== null) clearTimeout(renew);
    };
  }, [leagueId, typeKey, global, connect]);

  return status;
}
