import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_ROOM_ID, mergeMessages, type ChatApi, type ChatMessage, type ChatTeam } from './api';
import { liveTarget, type Connect } from './realtime';

export type ChatStatus = 'loading' | 'live' | 'polling';

export interface LeagueChat {
  messages: ChatMessage[];
  teams: ChatTeam[];
  status: ChatStatus;
  /**
   * The messages the first successful history read brought, less any that already arrived live: null
   * until a read succeeds (a failed first load stays null until a later one works).
   */
  history: ReadonlySet<string> | null;
  /** Seconds between refreshes while polling. */
  pollSeconds: number;
  /** The room has messages older than the ones loaded (#144). */
  hasEarlier: boolean;
  loadingEarlier: boolean;
  /** How many of `messages` came from paging back: they are never new. */
  earlierCount: number;
  /** Loads the next page of older messages; rejects when the read fails. */
  loadEarlier(): Promise<void>;
  send(text: string): Promise<void>;
}

/** Ask for the realtime config again this long before `refreshAt`. */
const RENEW_EARLY_MS = 60_000;
const PAGE = 50;
const DEFAULT_POLL_SECONDS = 5;
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Loads one chat room and keeps it current: live through AppSync Events when realtime is on,
 * otherwise (local dev, e2e, or a failed subscription) by polling get_chat. Live messages for other
 * rooms go to `onOther` (to bump their unread counts). `api` and `connect` must be stable (memoize
 * them), or the chat reloads on every render; key the component by league and room so a switch
 * starts fresh.
 */
export function useLeagueChat(
  leagueId: string,
  api: ChatApi,
  connect: Connect,
  roomId: string = DEFAULT_ROOM_ID,
  onOther?: (message: ChatMessage) => void
): LeagueChat {
  const other = useRef(onOther);
  useEffect(() => {
    other.current = onOther;
  }, [onOther]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [teams, setTeams] = useState<ChatTeam[]>([]);
  const [status, setStatus] = useState<ChatStatus>('loading');
  const [history, setHistory] = useState<ReadonlySet<string> | null>(null);
  const [pollSeconds, setPollSeconds] = useState(DEFAULT_POLL_SECONDS);
  // Where paging back continues: set by the first successful read, then by each older page. A
  // refresh reads the newest page again and leaves it alone.
  const [earlierCursor, setEarlierCursor] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierCount, setEarlierCount] = useState(0);
  const loaded = useRef<ChatMessage[]>([]);
  useEffect(() => {
    loaded.current = messages;
  }, [messages]);
  const add = useCallback(
    (incoming: readonly ChatMessage[]) => setMessages((current) => mergeMessages(current, incoming)),
    []
  );

  useEffect(() => {
    let stopped = false;
    let close: (() => void) | null = null;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (ms: number, run: () => void) => timers.push(setTimeout(run, ms));
    const chat = api;

    // Live arrivals before the first successful read are new, even when that read returns them too.
    let historyRead = false;
    const liveFirst = new Set<string>();
    const refresh = async () => {
      const { messages: page, nextCursor } = await chat.list(leagueId, { limit: PAGE, roomId });
      add(page);
      if (!historyRead) {
        historyRead = true;
        setEarlierCursor(nextCursor);
        setHistory(new Set(page.filter((m) => !liveFirst.has(m.id)).map((m) => m.id)));
      }
    };
    const disconnect = () => {
      close?.();
      close = null;
    };

    const poll = (seconds: number) => {
      setStatus('polling');
      setPollSeconds(seconds);
      const tick = () =>
        later(Math.max(50, seconds * 1000), () => {
          void refresh()
            .catch(() => undefined)
            .finally(() => {
              if (!stopped) tick();
            });
        });
      tick();
    };

    const goLive = async (): Promise<void> => {
      const info = await chat.realtime(leagueId).catch(() => null);
      if (stopped) return;
      const target = info === null ? null : liveTarget(info);
      if (info === null || target === null) return poll(info?.pollIntervalSeconds ?? DEFAULT_POLL_SECONDS);
      try {
        const unsubscribe = await connect(target, {
          // The channels carry every room; this view shows one.
          onChat: (message) => {
            if ((message.roomId ?? DEFAULT_ROOM_ID) === roomId) {
              if (!historyRead) liveFirst.add(message.id);
              add([message]);
            } else other.current?.(message);
          },
          onError: () => {
            disconnect();
            if (!stopped) poll(info.pollIntervalSeconds);
          }
        });
        if (stopped) return unsubscribe();
        close = unsubscribe;
        setStatus('live');
        // Catch anything posted while we were connecting.
        await refresh().catch(() => undefined);
        const refreshAt = Date.parse(info.refreshAt ?? '');
        if (!Number.isNaN(refreshAt)) {
          const renewIn = refreshAt - Date.now() - RENEW_EARLY_MS;
          // setTimeout fires at once for delays past 2^31 - 1 ms, so cap it.
          later(Math.min(Math.max(1000, renewIn), MAX_TIMER_MS), () => {
            disconnect();
            void goLive();
          });
        }
      } catch {
        if (!stopped) poll(info.pollIntervalSeconds);
      }
    };

    void (async () => {
      // A failed first load is retried by the live catch-up or the next poll.
      await refresh().catch(() => undefined);
      chat.teams(leagueId).then(setTeams, () => undefined);
      await goLive();
    })();

    return () => {
      stopped = true;
      disconnect();
      for (const t of timers) clearTimeout(t);
    };
  }, [leagueId, roomId, api, connect, add]);

  const send = useCallback(
    async (text: string) => {
      const message = await api.post(leagueId, text, roomId);
      add([message]);
    },
    [leagueId, roomId, api, add]
  );

  const loadEarlier = useCallback(async () => {
    if (earlierCursor === null || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const page = await api.list(leagueId, { limit: PAGE, roomId, after: earlierCursor });
      const known = new Set(loaded.current.map((m) => m.id));
      setEarlierCount((n) => n + page.messages.filter((m) => !known.has(m.id)).length);
      add(page.messages);
      setEarlierCursor(page.nextCursor);
    } finally {
      setLoadingEarlier(false);
    }
  }, [leagueId, roomId, api, add, earlierCursor, loadingEarlier]);

  return {
    messages,
    teams,
    status,
    history,
    pollSeconds,
    hasEarlier: earlierCursor !== null,
    loadingEarlier,
    earlierCount,
    loadEarlier,
    send
  };
}
