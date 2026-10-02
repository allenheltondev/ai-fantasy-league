import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiFetch } from '../api';
import type { PlayerRef } from './board';

/**
 * Your draft queue: players you want next, in order. It lives on the server (get_draft_queue /
 * set_draft_queue), so the pick clock's autopick takes your first available queued player when your
 * time runs out. Queues kept in this browser before that (localStorage, per league) are uploaded
 * once, the first time the server queue is empty.
 */

const key = (leagueId: string) => `fantasy:draft-queue:${leagueId}`;

/** `get_draft_queue` / `set_draft_queue`. */
export interface ServerDraftQueue {
  teamId: string;
  maxSize: number;
  updatedAt: string | null;
  players: { player: PlayerRef; rank: number | null; available: boolean }[];
}

function isPlayerRef(value: unknown): value is PlayerRef {
  const p = value as Partial<PlayerRef> | null;
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    typeof p.position === 'string'
  );
}

/** The queue this browser kept before the server did, if any. */
export function readQueue(leagueId: string): PlayerRef[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key(leagueId)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isPlayerRef) : [];
  } catch {
    return [];
  }
}

function forgetLocalQueue(leagueId: string): void {
  try {
    localStorage.removeItem(key(leagueId));
  } catch {
    // Blocked storage: nothing to forget.
  }
}

/** Moves the entry at `index` by `delta` places, clamped to the list. */
export function move<T>(list: readonly T[], index: number, delta: number): T[] {
  const to = Math.min(list.length - 1, Math.max(0, index + delta));
  const next = [...list];
  const [item] = next.splice(index, 1) as [T];
  next.splice(to, 0, item);
  return next;
}

export interface DraftQueue {
  players: PlayerRef[];
  /** False until the server queue has loaded. */
  ready: boolean;
  /** True while a change is still on its way to the server. */
  saving: boolean;
  /** Why the last load or save failed, or null. */
  error: string | null;
  has(playerId: string): boolean;
  add(player: PlayerRef): void;
  remove(playerId: string): void;
  move(playerId: string, delta: number): void;
}

const refs = (queue: ServerDraftQueue) => queue.players.map((p) => p.player);

export function useDraftQueue(leagueId: string, api: ApiFetch): DraftQueue {
  const [players, setPlayers] = useState<PlayerRef[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const path = `/leagues/${leagueId}/draft/queue`;
  // Saves run one at a time, in order, so the last change always wins on the server.
  const saving = useRef<Promise<void>>(Promise.resolve());

  const save = useCallback(
    (next: readonly PlayerRef[]) => {
      setPending((n) => n + 1);
      saving.current = saving.current.then(async () => {
        try {
          await api<ServerDraftQueue>(path, { method: 'PUT', body: { playerIds: next.map((p) => p.id) } });
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Could not save your queue.');
        } finally {
          setPending((n) => n - 1);
        }
      });
    },
    [api, path]
  );

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setPlayers([]);
    setError(null);
    void (async () => {
      try {
        let queue = (await api<ServerDraftQueue>(path)).data;
        const local = readQueue(leagueId);
        if (queue.players.length === 0 && local.length > 0) {
          queue = (
            await api<ServerDraftQueue>(path, {
              method: 'PUT',
              body: { playerIds: local.map((p) => p.id) }
            })
          ).data;
        }
        forgetLocalQueue(leagueId);
        if (!cancelled) {
          setPlayers(refs(queue));
          setReady(true);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load your queue.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, path, leagueId]);

  const update = (change: (current: PlayerRef[]) => PlayerRef[]) => {
    if (!ready) return;
    const next = change(players);
    if (next === players) return;
    setPlayers(next);
    save(next);
  };

  return {
    players,
    ready,
    saving: pending > 0,
    error,
    has: (playerId) => players.some((p) => p.id === playerId),
    add: (player) => update((q) => (q.some((p) => p.id === player.id) ? q : [...q, player])),
    remove: (playerId) => update((q) => q.filter((p) => p.id !== playerId)),
    move: (playerId, delta) =>
      update((q) =>
        move(
          q,
          q.findIndex((p) => p.id === playerId),
          delta
        )
      )
  };
}
