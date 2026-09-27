import { z } from 'zod';

/** Fantasy positions. `DEF` is a team defense/special teams unit; `DL`/`LB`/`DB` are IDP positions. */
export const OFFENSE_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'] as const;
export const IDP_POSITIONS = ['DL', 'LB', 'DB'] as const;
export const POSITIONS = [...OFFENSE_POSITIONS, ...IDP_POSITIONS] as const;
export const PositionSchema = z.enum(POSITIONS);
export type Position = z.infer<typeof PositionSchema>;

/**
 * Roster slots, labelled the way Yahoo labels them.
 * `W/R/T` is the standard flex, `Q/W/R/T` is superflex, `IDP` is Yahoo's "D" (any defensive player).
 */
export const ROSTER_SLOTS = [
  'QB',
  'WR',
  'RB',
  'TE',
  'W/R/T',
  'Q/W/R/T',
  'W/T',
  'W/R',
  'K',
  'DEF',
  'DL',
  'LB',
  'DB',
  'IDP',
  'BN',
  'IR'
] as const;
export const RosterSlotSchema = z.enum(ROSTER_SLOTS);
export type RosterSlot = z.infer<typeof RosterSlotSchema>;

/** Slots that do not score: bench and injured reserve. */
export const RESERVE_SLOTS: readonly RosterSlot[] = ['BN', 'IR'];
export const IDP_SLOTS: readonly RosterSlot[] = ['DL', 'LB', 'DB', 'IDP'];

export function isStarterSlot(slot: RosterSlot): boolean {
  return !RESERVE_SLOTS.includes(slot);
}

/** Which positions may fill each slot. BN and IR accept anyone (IR also needs an IR-eligible status). */
export const SLOT_ELIGIBILITY: Readonly<Record<RosterSlot, readonly Position[]>> = {
  QB: ['QB'],
  WR: ['WR'],
  RB: ['RB'],
  TE: ['TE'],
  'W/R/T': ['WR', 'RB', 'TE'],
  'Q/W/R/T': ['QB', 'WR', 'RB', 'TE'],
  'W/T': ['WR', 'TE'],
  'W/R': ['WR', 'RB'],
  K: ['K'],
  DEF: ['DEF'],
  DL: ['DL'],
  LB: ['LB'],
  DB: ['DB'],
  IDP: ['DL', 'LB', 'DB'],
  BN: POSITIONS,
  IR: POSITIONS
};

/** True when a player with any of `positions` may occupy `slot`. */
export function isEligibleForSlot(slot: RosterSlot, positions: readonly Position[]): boolean {
  const allowed = SLOT_ELIGIBILITY[slot];
  return positions.some((p) => allowed.includes(p));
}

/** Starting slots a player could legally fill, in `ROSTER_SLOTS` order. */
export function eligibleStarterSlots(positions: readonly Position[]): RosterSlot[] {
  return ROSTER_SLOTS.filter((s) => isStarterSlot(s) && isEligibleForSlot(s, positions));
}

const POSITION_ALIASES: Readonly<Record<string, Position>> = {
  QB: 'QB',
  RB: 'RB',
  FB: 'RB',
  WR: 'WR',
  TE: 'TE',
  K: 'K',
  PK: 'K',
  DEF: 'DEF',
  DST: 'DEF',
  'D/ST': 'DEF',
  DL: 'DL',
  DE: 'DL',
  DT: 'DL',
  NT: 'DL',
  LB: 'LB',
  OLB: 'LB',
  ILB: 'LB',
  MLB: 'LB',
  DB: 'DB',
  CB: 'DB',
  S: 'DB',
  FS: 'DB',
  SS: 'DB'
};

/** Maps a raw position string (Sleeper `position` / `fantasy_positions`) to a fantasy position, or null. */
export function normalizePosition(raw: string): Position | null {
  return POSITION_ALIASES[raw.trim().toUpperCase()] ?? null;
}

/**
 * Normalized player availability. Mirrors Sleeper's `injury_status` values plus the roster
 * designations that only appear in its `status` field.
 */
export const PLAYER_STATUSES = [
  'active',
  'questionable',
  'doubtful',
  'out',
  'ir',
  'pup',
  'nfi',
  'suspended',
  'covid',
  'na'
] as const;
export const PlayerStatusSchema = z.enum(PLAYER_STATUSES);
export type PlayerStatus = z.infer<typeof PlayerStatusSchema>;

/**
 * Statuses that may occupy an IR slot by default. Matches Yahoo: IR, O (out), PUP, NFI and the
 * COVID-19 list. Suspended, questionable, doubtful and NA players are not IR-eligible.
 */
export const DEFAULT_IR_ELIGIBLE_STATUSES: readonly PlayerStatus[] = ['ir', 'out', 'pup', 'nfi', 'covid'];

/** Statuses that mean the player will not play this week. Starting one produces a warning. */
export const WILL_NOT_PLAY_STATUSES: readonly PlayerStatus[] = [
  'out',
  'ir',
  'pup',
  'nfi',
  'suspended',
  'covid'
];

const STATUS_ALIASES: Readonly<Record<string, PlayerStatus>> = {
  ACTIVE: 'active',
  Q: 'questionable',
  QUESTIONABLE: 'questionable',
  D: 'doubtful',
  DOUBTFUL: 'doubtful',
  O: 'out',
  OUT: 'out',
  IR: 'ir',
  'INJURED RESERVE': 'ir',
  PUP: 'pup',
  'PUP-R': 'pup',
  'PUP-P': 'pup',
  'PHYSICALLY UNABLE TO PERFORM': 'pup',
  NFI: 'nfi',
  'NFI-R': 'nfi',
  'NFI-A': 'nfi',
  'NON FOOTBALL INJURY': 'nfi',
  SUS: 'suspended',
  SUSPENDED: 'suspended',
  COV: 'covid',
  COVID: 'covid',
  'COVID-19': 'covid',
  NA: 'na',
  'N/A': 'na',
  INACTIVE: 'na'
};

/**
 * Normalizes Sleeper's `injury_status` (e.g. "Questionable", "Out", "IR", "PUP", "Sus") and
 * `status` (e.g. "Active", "Injured Reserve") into one `PlayerStatus`. `injury_status` wins when set.
 */
export function normalizePlayerStatus(
  injuryStatus: string | null | undefined,
  rosterStatus?: string | null
): PlayerStatus {
  for (const raw of [injuryStatus, rosterStatus]) {
    if (raw) {
      const hit = STATUS_ALIASES[raw.trim().toUpperCase()];
      if (hit) return hit;
    }
  }
  return 'active';
}
