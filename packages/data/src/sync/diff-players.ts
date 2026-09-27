import type { Player } from '../types.js';

/** Fields whose changes become `Player Status Changed` events. */
export const TRACKED_FIELDS = ['status', 'injuryStatus', 'team', 'depthChartOrder'] as const;
export type TrackedField = (typeof TRACKED_FIELDS)[number];

export interface PlayerChange {
  playerId: string;
  field: TrackedField;
  from: string | number | null;
  to: string | number | null;
}

export interface PlayerDiff {
  /** New players and players whose data changed in any way. Sorted by id. */
  upserts: Player[];
  /** Ids present before but missing now. Sleeper rarely drops ids; callers usually keep them. */
  removed: string[];
  /** Tracked-field changes on players present in both snapshots. */
  changes: PlayerChange[];
}

type PlayerSource = Iterable<Player> | ReadonlyMap<string, Player>;

function toMap(source: PlayerSource): Map<string, Player> {
  if (source instanceof Map) return new Map(source as ReadonlyMap<string, Player>);
  const map = new Map<string, Player>();
  for (const p of source as Iterable<Player>) map.set(p.id, p);
  return map;
}

/** Structural equality for JSON-like values (what normalized players are). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra).filter((k) => ra[k] !== undefined);
  const kb = Object.keys(rb).filter((k) => rb[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => deepEqual(ra[k], rb[k]));
}

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Pure diff between two player-universe snapshots. Deterministic: upserts are sorted by id and
 * changes by (id, field order).
 */
export function diffPlayers(previous: PlayerSource, next: PlayerSource): PlayerDiff {
  const prev = toMap(previous);
  const curr = toMap(next);
  const upserts: Player[] = [];
  const changes: PlayerChange[] = [];

  for (const player of [...curr.values()].sort(byId)) {
    const before = prev.get(player.id);
    if (!before) {
      upserts.push(player);
      continue;
    }
    if (deepEqual(before, player)) continue;
    upserts.push(player);
    for (const field of TRACKED_FIELDS) {
      const from = before[field] ?? null;
      const to = player[field] ?? null;
      if (from !== to) changes.push({ playerId: player.id, field, from, to });
    }
  }

  const removed = [...prev.keys()].filter((id) => !curr.has(id)).sort();
  return { upserts, removed, changes };
}
