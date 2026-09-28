import type { LineupMove, RosterEntry, SlotCount } from '../../api/types';

/**
 * Lineup slot rules the editor needs to offer moves (docs/rules.md, "Roster"). The server
 * validates every move again; this only decides what to show.
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

export function isStarter(slot: string): boolean {
  return !RESERVE_SLOTS.includes(slot);
}

/** Slots this player could move to: the league's starting slots he is eligible for, then BN and IR. */
export function slotOptions(entry: RosterEntry, slots: readonly SlotCount[]): string[] {
  const starting = slots
    .filter(
      (s) => isStarter(s.slot) && s.count > 0 && (ELIGIBLE[s.slot] ?? []).includes(entry.player.position)
    )
    .map((s) => s.slot);
  const ir = slots.some((s) => s.slot === 'IR' && s.count > 0) && IR_STATUSES.includes(entry.status);
  return [...starting, 'BN', ...(ir ? ['IR'] : [])].filter((s) => s !== entry.slot);
}

/**
 * The moves for "put this player in `target`". When the target slot is full, the first unlocked
 * player there swaps into the moving player's old slot, so the lineup stays legal. Null when the
 * slot is full of locked players.
 */
export function planMove(
  players: readonly RosterEntry[],
  slots: readonly SlotCount[],
  playerId: string,
  target: string
): LineupMove[] | null {
  const mover = players.find((p) => p.player.id === playerId);
  if (mover === undefined) return null;
  const move = { playerId, slot: target };
  const limit = slots.find((s) => s.slot === target)?.count ?? 0;
  const occupants = players.filter((p) => p.slot === target);
  if (target === 'BN' || occupants.length < limit) return [move];
  const out = occupants.find((p) => !p.locked);
  if (out === undefined) return null;
  return [move, { playerId: out.player.id, slot: mover.slot }];
}

/** A short label for a player's availability, or null when he is healthy and playing. */
export function statusLabel(entry: RosterEntry): string | null {
  if (entry.onBye) return 'Bye';
  if (entry.status === 'active') return null;
  return entry.injuryStatus ?? entry.status.toUpperCase();
}
