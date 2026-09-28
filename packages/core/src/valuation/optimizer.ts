import {
  isOnBye,
  isPlayerLocked,
  validateLineup,
  type LineupContext,
  type LineupEntry,
  type LineupValidation,
  type RosterPlayer,
  type WeekGames
} from '../rules/lineup.js';
import {
  ROSTER_SLOTS,
  WILL_NOT_PLAY_STATUSES,
  isEligibleForSlot,
  isStarterSlot,
  type RosterSlot
} from '../rules/positions.js';
import { slotCount, type LeagueSettings } from '../rules/settings.js';
import { roundPoints } from '../scoring/engine.js';
import type { WeekProjections } from './value.js';

/**
 * Minimum-cost assignment of every row to a distinct column (Hungarian algorithm, O(n²m)).
 * Requires rows ≤ columns. Returns the column chosen for each row.
 */
export function solveAssignment(cost: readonly (readonly number[])[]): number[] {
  const n = cost.length;
  if (n === 0) return [];
  const m = (cost[0] as readonly number[]).length;
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0);
  const way = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(Infinity);
    const used = new Array<boolean>(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1]![j - 1]! - u[i0]! - v[j]!;
        if (cur < minv[j]!) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]!]! += delta;
          v[j]! -= delta;
        } else {
          minv[j]! -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0 !== 0);
  }
  const result = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]! > 0) result[p[j]! - 1] = j - 1;
  return result;
}

export interface OptimizedLineup {
  /** Every rostered player with a slot; valid input for `set_lineup`. */
  lineup: LineupEntry[];
  /** Projected points of the starters, rounded to 2 decimals. */
  projectedPoints: number;
  /** Proof of legality: `validateLineup` run on `lineup` with the same context. */
  validation: LineupValidation;
}

const FORBIDDEN = 1e15;

/**
 * The highest-projected legal lineup, solved exactly as an assignment problem (so flex slots are
 * chosen optimally, not greedily).
 *
 * - Locked players (with `games`, `now` and `previousLineup`) keep the slot they had.
 * - Players on IR in `previousLineup` stay on IR.
 * - Players on bye (when `games` is given) or with a will-not-play status (Out, IR, …) are benched.
 * - Among lineups with equal projected points, one that fills more slots wins, then one that moves
 *   the fewest players from `previousLineup`; a slot is left empty only when no eligible player
 *   remains or every eligible player projects below 0.
 */
export function optimizeLineup(
  settings: Pick<LeagueSettings, 'roster'>,
  roster: readonly RosterPlayer[],
  projections: WeekProjections,
  context: LineupContext = {}
): OptimizedLineup {
  const { games, now, previousLineup } = context;
  const prev = new Map((previousLineup ?? []).map((e) => [e.playerId, e.slot]));
  const locksApply = games !== undefined && now !== undefined && previousLineup !== undefined;
  const pts = (id: string): number => projections[id] ?? 0;

  const fixed = new Map<string, RosterSlot>();
  for (const player of roster) {
    const before = prev.get(player.playerId) ?? 'BN';
    if (locksApply && isPlayerLocked(player, games, now)) fixed.set(player.playerId, before);
    else if (before === 'IR') fixed.set(player.playerId, 'IR');
  }

  const openSlots: RosterSlot[] = [];
  for (const slot of ROSTER_SLOTS) {
    if (!isStarterSlot(slot)) continue;
    const taken = [...fixed.values()].filter((s) => s === slot).length;
    for (let i = taken; i < slotCount(settings, slot); i++) openSlots.push(slot);
  }

  const candidates = roster
    .filter(
      (p) =>
        !fixed.has(p.playerId) &&
        !WILL_NOT_PLAY_STATUSES.includes(p.status) &&
        !(games !== undefined && isOnBye(p, games))
    )
    .sort((a, b) => a.playerId.localeCompare(b.playerId));

  // Integer weights: whole cents × 100000, plus 100 for filling a slot and 1 for a player keeping
  // the slot he had. Ties favour full lineups, then the fewest moves, and neither ever outweighs a
  // cent of projected points.
  const cost = openSlots.map((slot) => [
    ...candidates.map((p) =>
      isEligibleForSlot(slot, p.positions)
        ? -(Math.round(pts(p.playerId) * 100) * 100_000 + 100 + (prev.get(p.playerId) === slot ? 1 : 0))
        : FORBIDDEN
    ),
    ...openSlots.map(() => 0)
  ]);
  const assignment = solveAssignment(cost);

  const slotOf = new Map(fixed);
  assignment.forEach((col, row) => {
    const player = candidates[col];
    if (player) slotOf.set(player.playerId, openSlots[row] as RosterSlot);
  });

  const lineup = roster.map((p) => ({ playerId: p.playerId, slot: slotOf.get(p.playerId) ?? 'BN' }));
  const projectedPoints = roundPoints(
    lineup.filter((e) => isStarterSlot(e.slot)).reduce((sum, e) => sum + pts(e.playerId), 0)
  );
  return { lineup, projectedPoints, validation: validateLineup(settings, roster, lineup, context) };
}

/**
 * Projected points of a lineup's starters who will play: a starter on bye (when `games` is given)
 * or with a will-not-play status (Out, IR, …) counts 0, as he will score nothing. Rounded to 2
 * decimals. This is the total a manager compares when choosing a lineup, and one that
 * `optimizeLineup`'s lineup never falls below (for a legal starting lineup).
 */
export function startersProjection(
  roster: readonly RosterPlayer[],
  lineup: readonly LineupEntry[],
  projections: WeekProjections,
  games?: WeekGames
): number {
  const byId = new Map(roster.map((p) => [p.playerId, p]));
  let cents = 0;
  for (const entry of lineup) {
    const player = byId.get(entry.playerId);
    if (player === undefined || !isStarterSlot(entry.slot)) continue;
    if (WILL_NOT_PLAY_STATUSES.includes(player.status)) continue;
    if (games !== undefined && isOnBye(player, games)) continue;
    cents += Math.round((projections[entry.playerId] ?? 0) * 100);
  }
  return cents / 100;
}

/**
 * The `set_lineup` moves that turn `before` into `after`: one per player whose slot changed
 * (players missing from `before` count as BN), in `after`'s order.
 */
export function lineupDiff(before: readonly LineupEntry[], after: readonly LineupEntry[]): LineupEntry[] {
  const was = new Map(before.map((e) => [e.playerId, e.slot]));
  return after.filter((e) => (was.get(e.playerId) ?? 'BN') !== e.slot).map((e) => ({ ...e }));
}
