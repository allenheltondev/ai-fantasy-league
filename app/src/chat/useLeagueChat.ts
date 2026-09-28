import { useCallback, useEffect, useState } from 'react';
import { mergeMessages, type ChatApi, type ChatMessage, type ChatTeam } from './api';
import { liveTarget, type Connect } from './realtime';

export type ChatStatus = 'loading' | 'live' | 'polling';

export interface LeagueChat {
  messages: ChatMessage[];
  teams: ChatTeam[];
  status: ChatStatus;
  /** Seconds between refreshes while polling. */
  pollSeconds: number;
  send(text: string): Promise<void>;
}

/** Refresh the live token this long before it expires. */
const RENEW_EARLY_MS = 60_000;
const PAGE = 50;
const DEFAULT_POLL_SECONDS = 5;
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Loads a league's chat and keeps it current: live through Momento when the API vends a token,
 * otherwise (local dev, e2e, or a failed subscription) by polling get_chat. `api` and `connect`
 * must be stable (memoize them), or the chat reloads on every render; key the component by league
 * so a different league starts fresh.
 */
export function useLeagueChat(leagueId: string, api: ChatApi, connect: Connect): LeagueChat {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [teams, setTeams] = useState<ChatTeam[]>([]);
  const [status, setStatus] = useState<ChatStatus>('loading');
  const [pollSeconds, setPollSeconds] = useState(DEFAULT_POLL_SECONDS);
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

    const refresh = async () => add((await chat.list(leagueId, { limit: PAGE })).messages);
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
          onChat: (message) => add([message]),
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
        const expiresAt = Date.parse(info.expiresAt ?? '');
        if (!Number.isNaN(expiresAt)) {
          const renewIn = expiresAt - Date.now() - RENEW_EARLY_MS;
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
  }, [leagueId, api, connect, add]);

  const send = useCallback(
    async (text: string) => {
      const message = await api.post(leagueId, text);
      add([message]);
    },
    [leagueId, api, add]
  );

  return { messages, teams, status, pollSeconds, send };
}
