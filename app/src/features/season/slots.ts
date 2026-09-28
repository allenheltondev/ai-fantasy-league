import type { LineupMove, RosterEntry, SlotCount } from '../../api/types';

/**
 * Lineup slot rules the editor needs to offer moves (docs/rules.md, "Roster"). The server
 * validates every move again in set_lineup; this only decides what to show and allow.
 */
const ELIGIBLE: Readonly<Record<string, readonly string[]>> = {
  QB: ['QB'],
  WR: ['WR'],
  RB: ['RB'],
  TE: ['TE'],
  'W/R/T': ['WR', 'RB', 'TE'],
  'Q/W/R/T': ['QB', 'WR', 'RB', 'TE'],
  'W/T': ['WR', 'TE'],
  'W/R': ['WR', 'RB'],
  K: ['K'],
  DEF: ['DEF']
};

export const RESERVE_SLOTS = ['BN', 'IR'];

/** Statuses that may sit on IR by default (the server checks the league's own list). */
const IR_STATUSES = ['ir', 'out', 'pup', 'nfi', 'covid'];

/** Statuses that score nothing: such a starter counts 0 (core WILL_NOT_PLAY_STATUSES). */
const WILL_NOT_PLAY = ['out', 'ir', 'pup', 'nfi', 'suspended', 'covid'];

export function isStarter(slot: string): boolean {
  return !RESERVE_SLOTS.includes(slot);
}

export function isEligible(slot: string, position: string): boolean {
  return (ELIGIBLE[slot] ?? []).includes(position);
}

/** A short label for a player's availability, or null when he is healthy and playing. */
export function statusLabel(entry: RosterEntry): string | null {
  if (entry.onBye) return 'Bye';
  if (entry.status === 'active') return null;
  return entry.injuryStatus ?? entry.status.toUpperCase();
}

/** False when he will score nothing this week: on bye or ruled out. */
export function willPlay(entry: RosterEntry): boolean {
  return !entry.onBye && !WILL_NOT_PLAY.includes(entry.status);
}

/** Where each player sits: player id → slot. The editor's working copy of the lineup. */
export type Placement = Readonly<Record<string, string>>;

export function placementOf(players: readonly RosterEntry[]): Placement {
  return Object.fromEntries(players.map((p) => [p.player.id, p.slot]));
}

/** The players with their slots taken from `placement`. */
export function placed(players: readonly RosterEntry[], placement: Placement): RosterEntry[] {
  return players.map((p) => ({ ...p, slot: placement[p.player.id] ?? p.slot }));
}

/**
 * The starters' projected points, to the cent: a starter on bye or ruled out counts 0, as in
 * get_roster's `projectedPoints`.
 */
export function projectedTotal(players: readonly RosterEntry[], placement: Placement): number {
  const cents = placed(players, placement)
    .filter((p) => isStarter(p.slot) && willPlay(p))
    .reduce((sum, p) => sum + Math.round((p.projectedPoints ?? 0) * 100), 0);
  return cents / 100;
}

/** One starting slot on the board: `QB-0`, `WR-2`, … and who fills it, if anyone. */
export interface SlotSeat {
  key: string;
  slot: string;
  entry: RosterEntry | null;
}

/** The league's starting slots, one seat each, filled in slot order by the players placed there. */
export function seats(
  players: readonly RosterEntry[],
  slots: readonly SlotCount[],
  placement: Placement
): SlotSeat[] {
  const rows = placed(players, placement);
  return slots
    .filter((s) => isStarter(s.slot))
    .flatMap((s) => {
      const filling = rows.filter((p) => p.slot === s.slot);
      return Array.from({ length: Math.max(s.count, filling.length) }, (_, i) => ({
        key: `${s.slot}-${i}`,
        slot: s.slot,
        entry: filling[i] ?? null
      }));
    });
}

/** Where a player can be put: a starting slot (maybe filled), the bench, IR, or onto a bench player. */
export type Target =
  | { kind: 'slot'; slot: string; occupant: string | null }
  | { kind: 'bench' }
  | { kind: 'ir' }
  | { kind: 'player'; playerId: string };

/**
 * The placement after putting `moverId` at `target`, or null when that move is not allowed: he or
 * the player he would displace is locked, he cannot play that slot, IR is full or he is not hurt,
 * or it changes nothing. A displaced starter takes the mover's old slot when he can play it, and
 * otherwise goes to the bench.
 */
export function place(
  players: readonly RosterEntry[],
  slots: readonly SlotCount[],
  placement: Placement,
  moverId: string,
  target: Target
): Placement | null {
  const rows = placed(players, placement);
  const byId = new Map(rows.map((p) => [p.player.id, p]));
  const mover = byId.get(moverId);
  if (mover === undefined || mover.locked) return null;
  const from = mover.slot;
  const next = { ...placement };
  switch (target.kind) {
    case 'bench':
      if (from === 'BN') return null;
      return { ...next, [moverId]: 'BN' };
    case 'ir': {
      const room = slots.find((s) => s.slot === 'IR')?.count ?? 0;
      const used = rows.filter((p) => p.slot === 'IR').length;
      if (from === 'IR' || !IR_STATUSES.includes(mover.status) || used >= room) return null;
      return { ...next, [moverId]: 'IR' };
    }
    case 'player': {
      const other = byId.get(target.playerId);
      if (other === undefined || other.locked || other.player.id === moverId) return null;
      if (!isStarter(from) || other.slot !== 'BN' || !isEligible(from, other.player.position)) return null;
      return { ...next, [moverId]: 'BN', [other.player.id]: from };
    }
    case 'slot': {
      if (!isEligible(target.slot, mover.player.position) || target.occupant === moverId) return null;
      if (target.occupant === null) return { ...next, [moverId]: target.slot };
      const occupant = byId.get(target.occupant);
      if (occupant === undefined || occupant.locked) return null;
      const back = isStarter(from) && isEligible(from, occupant.player.position) ? from : 'BN';
      return { ...next, [moverId]: target.slot, [occupant.player.id]: back };
    }
  }
}

/** A player whose slot differs between the saved lineup and the working copy. */
export interface Change {
  entry: RosterEntry;
  from: string;
  to: string;
}

export function changes(players: readonly RosterEntry[], placement: Placement): Change[] {
  return players.flatMap((p) => {
    const to = placement[p.player.id] ?? p.slot;
    return to === p.slot ? [] : [{ entry: p, from: p.slot, to }];
  });
}

/** The set_lineup moves for the working copy (players who stay put are left out). */
export function movesFor(players: readonly RosterEntry[], placement: Placement): LineupMove[] {
  return changes(players, placement).map((c) => ({ playerId: c.entry.player.id, slot: c.to }));
}

/** The saved lineup with `moves` applied. */
export function applyMoves(players: readonly RosterEntry[], moves: readonly LineupMove[]): Placement {
  const out: Record<string, string> = { ...placementOf(players) };
  for (const m of moves) out[m.playerId] = m.slot;
  return out;
}
