import { normalizeNameNoSuffix } from '../names.js';
import { toSleeperTeam } from '../teams.js';
import type { Player } from '../types.js';
import { csvValue, parseCsvObjects } from './csv.js';

/** One row of the dynastyprocess `db_playerids.csv` ID mapping table. */
export interface IdMapRow {
  gsisId?: string;
  sleeperId?: string;
  name: string;
  position: string | null;
  /** Sleeper team code, or null for free agents. */
  team: string | null;
  espnId?: string;
  yahooId?: string;
  pfrId?: string;
}

export const ID_MAP_COLUMNS = ['gsis_id', 'sleeper_id', 'name', 'position', 'team'] as const;

export function parseIdMap(csv: string): IdMapRow[] {
  return parseCsvObjects(csv, ID_MAP_COLUMNS, 'dynastyprocess db_playerids.csv').map((r) => {
    const row: IdMapRow = {
      name: csvValue(r, 'name') ?? '',
      position: csvValue(r, 'position') ?? null,
      team: toSleeperTeam(csvValue(r, 'team'))
    };
    const gsisId = csvValue(r, 'gsis_id');
    const sleeperId = csvValue(r, 'sleeper_id');
    const espnId = csvValue(r, 'espn_id');
    const yahooId = csvValue(r, 'yahoo_id');
    const pfrId = csvValue(r, 'pfr_id');
    if (gsisId) row.gsisId = gsisId;
    if (sleeperId) row.sleeperId = sleeperId;
    if (espnId) row.espnId = espnId;
    if (yahooId) row.yahooId = yahooId;
    if (pfrId) row.pfrId = pfrId;
    return row;
  });
}

export type CrosswalkMethod = 'idmap' | 'sleeper' | 'name';

export interface CrosswalkEntry {
  sleeperId: string;
  gsisId: string;
  method: CrosswalkMethod;
}

export interface CrosswalkConflict {
  sleeperId: string;
  kind: 'gsis_mismatch' | 'duplicate_gsis';
  /** The gsis id we kept. */
  kept: string;
  /** The competing gsis id (mismatch) or the other Sleeper id that claimed it (duplicate). */
  other: string;
  detail: string;
}

export interface UnmappedPlayer {
  sleeperId: string;
  name: string;
  position: string | null;
  team: string | null;
  reason: 'no_match' | 'ambiguous_name';
}

export interface CrosswalkReport {
  /** Players considered (in scope). */
  considered: number;
  mapped: number;
  byMethod: Record<CrosswalkMethod, number>;
  unmapped: UnmappedPlayer[];
  conflicts: CrosswalkConflict[];
}

export interface CrosswalkOptions {
  /** Positions that must map; others are mapped when possible but never reported. */
  positions?: readonly string[];
  /** Report inactive players too. Default false. */
  includeInactive?: boolean;
}

export const DEFAULT_CROSSWALK_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K'] as const;

/** Sleeper id ↔ nflverse GSIS id. */
export class IdCrosswalk {
  readonly #bySleeper = new Map<string, CrosswalkEntry>();
  readonly #byGsis = new Map<string, CrosswalkEntry>();

  constructor(entries: Iterable<CrosswalkEntry> = []) {
    for (const e of entries) this.add(e);
  }

  /** Adds an entry unless either id is already mapped. Returns whether it was added. */
  add(entry: CrosswalkEntry): boolean {
    if (this.#bySleeper.has(entry.sleeperId) || this.#byGsis.has(entry.gsisId)) return false;
    this.#bySleeper.set(entry.sleeperId, entry);
    this.#byGsis.set(entry.gsisId, entry);
    return true;
  }

  toGsis(sleeperId: string): string | undefined {
    return this.#bySleeper.get(sleeperId)?.gsisId;
  }

  toSleeper(gsisId: string): string | undefined {
    return this.#byGsis.get(gsisId)?.sleeperId;
  }

  entry(sleeperId: string): CrosswalkEntry | undefined {
    return this.#bySleeper.get(sleeperId);
  }

  ownerOfGsis(gsisId: string): CrosswalkEntry | undefined {
    return this.#byGsis.get(gsisId);
  }

  get size(): number {
    return this.#bySleeper.size;
  }

  entries(): CrosswalkEntry[] {
    return [...this.#bySleeper.values()];
  }

  /** GSIS ids (for example from an nflverse stats file) with no Sleeper mapping. */
  unmappedGsis(gsisIds: Iterable<string>): string[] {
    return [...new Set(gsisIds)].filter((g) => !this.#byGsis.has(g)).sort();
  }
}

const POSITION_ALIASES: Record<string, string> = {
  PK: 'K',
  DE: 'DL',
  DT: 'DL',
  NT: 'DL',
  OLB: 'LB',
  ILB: 'LB'
};
const canonicalPosition = (p: string | null | undefined): string | null =>
  p ? (POSITION_ALIASES[p] ?? p) : null;

/**
 * Builds the crosswalk in three passes, most trusted first:
 * 1. `idmap`: the dynastyprocess table's sleeper_id → gsis_id.
 * 2. `sleeper`: the gsis_id Sleeper itself carries.
 * 3. `name`: a unique match on normalized name + position (team breaks ties) among table rows
 *    that have a gsis id but no sleeper id.
 * Disagreements and duplicate claims are reported as conflicts rather than silently dropped.
 */
export function buildCrosswalk(
  players: readonly Player[],
  idMap: readonly IdMapRow[],
  options: CrosswalkOptions = {}
): { crosswalk: IdCrosswalk; report: CrosswalkReport } {
  const positions = new Set(options.positions ?? DEFAULT_CROSSWALK_POSITIONS);
  const crosswalk = new IdCrosswalk();
  const conflicts: CrosswalkConflict[] = [];
  const ambiguous = new Set<string>();

  const idMapBySleeper = new Map<string, string>();
  for (const row of idMap) {
    if (row.sleeperId && row.gsisId && !idMapBySleeper.has(row.sleeperId)) {
      idMapBySleeper.set(row.sleeperId, row.gsisId);
    }
  }

  const tryAdd = (entry: CrosswalkEntry): void => {
    if (crosswalk.add(entry)) return;
    const owner = crosswalk.ownerOfGsis(entry.gsisId);
    if (owner && owner.sleeperId !== entry.sleeperId) {
      conflicts.push({
        sleeperId: entry.sleeperId,
        kind: 'duplicate_gsis',
        kept: entry.gsisId,
        other: owner.sleeperId,
        detail: `${entry.method} mapping of ${entry.sleeperId} → ${entry.gsisId} is already claimed by ${owner.sleeperId} (${owner.method})`
      });
    }
  };

  // Pass 1 + 2
  for (const p of players) {
    const fromMap = idMapBySleeper.get(p.id);
    if (fromMap) {
      if (p.gsisId && p.gsisId !== fromMap) {
        conflicts.push({
          sleeperId: p.id,
          kind: 'gsis_mismatch',
          kept: fromMap,
          other: p.gsisId,
          detail: `id map says ${fromMap}, Sleeper says ${p.gsisId}; kept the id map`
        });
      }
      tryAdd({ sleeperId: p.id, gsisId: fromMap, method: 'idmap' });
    }
  }
  for (const p of players) {
    if (!crosswalk.entry(p.id) && p.gsisId && !idMapBySleeper.has(p.id)) {
      tryAdd({ sleeperId: p.id, gsisId: p.gsisId, method: 'sleeper' });
    }
  }

  // Pass 3: name fallback over unclaimed table rows.
  const byName = new Map<string, IdMapRow[]>();
  for (const row of idMap) {
    if (!row.gsisId || row.sleeperId || crosswalk.ownerOfGsis(row.gsisId)) continue;
    const key = normalizeNameNoSuffix(row.name);
    byName.set(key, [...(byName.get(key) ?? []), row]);
  }
  for (const p of players) {
    if (crosswalk.entry(p.id) || p.position === 'DEF') continue;
    const pos = canonicalPosition(p.position);
    let candidates = (byName.get(normalizeNameNoSuffix(p.name)) ?? []).filter(
      (r) => canonicalPosition(r.position) === pos
    );
    if (candidates.length > 1 && p.team) candidates = candidates.filter((r) => r.team === p.team);
    const only = candidates[0];
    if (candidates.length === 1 && only?.gsisId) {
      tryAdd({ sleeperId: p.id, gsisId: only.gsisId, method: 'name' });
    } else if (candidates.length > 1) {
      ambiguous.add(p.id);
    }
  }

  const inScope = players.filter(
    (p) => p.position !== null && positions.has(p.position) && (options.includeInactive || p.active)
  );
  const byMethod: Record<CrosswalkMethod, number> = { idmap: 0, sleeper: 0, name: 0 };
  const unmapped: UnmappedPlayer[] = [];
  let mapped = 0;
  for (const p of inScope) {
    const e = crosswalk.entry(p.id);
    if (e) {
      mapped++;
      byMethod[e.method]++;
    } else {
      unmapped.push({
        sleeperId: p.id,
        name: p.name,
        position: p.position,
        team: p.team,
        reason: ambiguous.has(p.id) ? 'ambiguous_name' : 'no_match'
      });
    }
  }
  return { crosswalk, report: { considered: inScope.length, mapped, byMethod, unmapped, conflicts } };
}

/** Returns players with `gsisId` filled (or corrected) from the crosswalk. */
export function applyCrosswalk(players: readonly Player[], crosswalk: IdCrosswalk): Player[] {
  return players.map((p) => {
    const gsisId = crosswalk.toGsis(p.id);
    return gsisId && gsisId !== p.gsisId ? { ...p, gsisId } : p;
  });
}
