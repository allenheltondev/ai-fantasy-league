import { ROSTER_SLOTS, isStarterSlot, type Position, type RosterSlot } from '../rules/positions.js';
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
