import { useEffect, useRef, useState } from 'react';
import type { RealtimeInfo } from '../chat/api';
import { parseChatItem } from '../chat/realtime';

/**
 * Live league events over Momento Topics, for pages that refresh when something happens (the draft
 * board on a pick, the matchup on new scores). The realtime publisher relays each league event to
 * `fantasy.league.<id>`, results for one team to `fantasy.team.<id>.<teamId>`, and league-less ones (the live-stats job's `Scores Updated`) to the global
 * topic, as `{ type: 'event', detailType, leagueId, ... }` (packages/server/src/realtime/relay.ts).
 *
 * Events only say *that* something changed: pages re-read through the API, which stays the source of
 * truth. Polling is the fallback whenever realtime is off (local dev, e2e) or the subscription fails.
 */

export interface LeagueEvent {
  detailType: string;
  /** Null for events on the global topic. */
  leagueId: string | null;
  /** The bus event id, when relayed: the same event can arrive on the league and the team topic. */
  eventId?: string;
  /** The event detail as relayed (packages/server/src/events/details.ts), for toasts. */
  detail?: Record<string, unknown>;
}

export interface EventTarget {
  token: string;
  cacheName: string;
  topics: string[];
}

/** Opens subscriptions to every topic and resolves to a function that closes them all. */
export type EventConnect = (
  target: EventTarget,
  handlers: { onEvent(event: LeagueEvent): void; onError(): void }
) => Promise<() => void>;

export type LiveStatus = 'loading' | 'live' | 'polling';

/** The subscription target when realtime is on and the token is complete, else null. */
export function eventTarget(info: RealtimeInfo, global: boolean): EventTarget | null {
  if (!info.enabled || info.token === null || info.cacheName === null || info.topics === null) return null;
  // The caller's own team topic (their waiver awards and trade offers) rides along when they have one.
  const team = info.topics.team ?? null;
  const topics = [
    info.topics.league,
    ...(team === null ? [] : [team]),
    ...(global ? [info.topics.global] : [])
  ];
  return { token: info.token, cacheName: info.cacheName, topics };
}

/** The league event in a topic item, or null for chat messages and anything malformed. */
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

/** Chat messages ride the league topic as `{ type: 'chat' }`; they surface as this event type. */
export const CHAT_EVENT = 'Chat Message Posted';

/**
 * A topic item as a league event: relayed events as they are, and chat messages as a `CHAT_EVENT`
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
    /** Dev builds only: a stand-in for Momento that e2e tests install to push events (see below). */
    __fantasyEvents?: EventConnect;
  }
}

export const connectMomentoEvents: EventConnect = async (target, handlers) => {
  // The e2e suite runs the dev server and cannot reach Momento, so a page script may stand in for
  // it there and push events. Production builds drop this branch (`import.meta.env.DEV` is false).
  if (import.meta.env.DEV && window.__fantasyEvents) return window.__fantasyEvents(target, handlers);
  const sdk = await import('@gomomento/sdk-web');
  const client = new sdk.TopicClient({
    configuration: sdk.TopicConfigurations.Browser.latest(),
    credentialProvider: sdk.CredentialProvider.fromDisposableToken({ authToken: target.token })
  });
  const closers: (() => void)[] = [];
  const closeAll = () => closers.forEach((close) => close());
  for (const topic of target.topics) {
    const subscription = await client.subscribe(target.cacheName, topic, {
      onItem: (item) => {
        const event = parseTopicItem(item.valueString());
        if (event !== null) handlers.onEvent(event);
      },
      onError: () => handlers.onError()
    });
    if (!(subscription instanceof sdk.TopicSubscribe.Subscription)) {
      closeAll();
      throw new Error('Could not subscribe to live league events.');
    }
    closers.push(() => subscription.unsubscribe());
  }
  return closeAll;
};

/** Refresh the live token this long before it expires. */
const RENEW_EARLY_MS = 60_000;
const MAX_TIMER_MS = 2_147_483_647;

export interface LiveEventsOptions {
  leagueId: string;
  /** The event detail types that matter to the page. */
  types: readonly string[];
  /** Also subscribe to the global topic (for `Scores Updated`, which names no league). */
  global?: boolean;
  /** get_realtime_token. Read when (re)subscribing, so it may change every render. */
  realtime: (leagueId: string) => Promise<RealtimeInfo>;
  /** Must be stable. */
  connect: EventConnect;
  /** Called for each matching event. May change every render. */
  onEvent: (event: LeagueEvent) => void;
}

/**
 * Subscribes to a league's live events while mounted and reports whether the page is live or must
 * poll. Renews the token before it expires and falls back to polling on any failure.
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
        const expiresAt = Date.parse(info.expiresAt ?? '');
        if (!Number.isNaN(expiresAt)) {
          const renewIn = expiresAt - Date.now() - RENEW_EARLY_MS;
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
