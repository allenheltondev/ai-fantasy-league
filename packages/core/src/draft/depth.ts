import {
  ROSTER_SLOTS,
  SLOT_ELIGIBILITY,
  isEligibleForSlot,
  isStarterSlot,
  type Position,
  type RosterSlot
} from '../rules/positions.js';
import { unfilledStarterSlots, type RosterNeeds } from './autopick.js';

/** One starting slot's fill on a drafted roster: e.g. RB 1 of 2. */
export interface SlotFill {
  slot: RosterSlot;
  required: number;
  filled: number;
}

/**
 * How full each starting slot is after placing the drafted players, most specific slot first (the
 * same placement as `unfilledStarterSlots`, so a third RB fills W/R/T once both RB slots are full).
 * Slots the league does not use are left out; `required - filled` is the gap.
 */
export function starterSlotFill(needs: RosterNeeds, drafted: readonly (readonly Position[])[]): SlotFill[] {
  const open = unfilledStarterSlots(needs, drafted);
  return ROSTER_SLOTS.filter((slot) => isStarterSlot(slot) && (needs.roster.slots[slot] ?? 0) > 0).map(
    (slot) => {
      const required = needs.roster.slots[slot] ?? 0;
      return { slot, required, filled: required - open.filter((s) => s === slot).length };
    }
  );
}

/** A drafted player, for placing on a roster. */
export interface DraftedPlayer {
  playerId: string;
  /** Fantasy positions, primary first. */
  positions: readonly Position[];
}

/** A drafted roster laid out as a draft room shows it: every starting slot, filled or not, then the bench. */
export interface RosterLayout {
  /** Every starting slot the league uses, one entry per seat, in `ROSTER_SLOTS` order. */
  starters: { slot: RosterSlot; playerId: string | null }[];
  /** Drafted players who fit no open starting slot, in pick order. */
  bench: string[];
}

/**
 * Places drafted players (in pick order) into the league's starting slots the way
 * `unfilledStarterSlots` does: the most specific open slot first, players with fewer eligible
 * positions first, so a third RB fills W/R/T once both RB slots are full. The rest sit on the bench.
 */
export function rosterLayout(needs: RosterNeeds, drafted: readonly DraftedPlayer[]): RosterLayout {
  const starters = ROSTER_SLOTS.filter((slot) => isStarterSlot(slot)).flatMap((slot) =>
    Array.from({ length: needs.roster.slots[slot] ?? 0 }, () => ({ slot, playerId: null as string | null }))
  );
  const bySpecificity = starters
    .map((seat, index) => ({ seat, index }))
    .sort(
      (a, b) =>
        SLOT_ELIGIBILITY[a.seat.slot].length - SLOT_ELIGIBILITY[b.seat.slot].length || a.index - b.index
    );
  const order = drafted
    .map((player, index) => ({ player, index }))
    .sort((a, b) => a.player.positions.length - b.player.positions.length || a.index - b.index);
  const placed = new Set<number>();
  for (const { player, index } of order) {
    const open = bySpecificity.find(
      ({ seat }) => seat.playerId === null && isEligibleForSlot(seat.slot, player.positions)
    );
    if (open === undefined) continue;
    open.seat.playerId = player.playerId;
    placed.add(index);
  }
  return {
    starters,
    bench: drafted.filter((_, index) => !placed.has(index)).map((p) => p.playerId)
  };
}
