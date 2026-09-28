import { useCallback, useState } from 'react';
import type { PlayerRef } from './board';

/**
 * Your draft queue: players you want next, in order. Kept in this browser only (localStorage, per
 * league); the server's autopick does not read it.
 */

const key = (leagueId: string) => `fantasy:draft-queue:${leagueId}`;

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

export function readQueue(leagueId: string): PlayerRef[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key(leagueId)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isPlayerRef) : [];
  } catch {
    return [];
  }
}

function writeQueue(leagueId: string, queue: readonly PlayerRef[]): void {
  try {
    localStorage.setItem(key(leagueId), JSON.stringify(queue));
  } catch {
    // Storage full or blocked: the queue still works for this visit.
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
  has(playerId: string): boolean;
  add(player: PlayerRef): void;
  remove(playerId: string): void;
  move(playerId: string, delta: number): void;
}

export function useDraftQueue(leagueId: string): DraftQueue {
  const [players, setPlayers] = useState(() => readQueue(leagueId));
  const update = useCallback(
    (change: (current: PlayerRef[]) => PlayerRef[]) =>
      setPlayers((current) => {
        const next = change(current);
        writeQueue(leagueId, next);
        return next;
      }),
    [leagueId]
  );
  return {
    players,
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
