import { ROSTER_SLOTS, SLOT_ELIGIBILITY, isEligibleForSlot, isStarterSlot } from '../rules/positions.js';
import type { Position, RosterSlot } from '../rules/positions.js';
import type { LeagueSettings } from '../rules/settings.js';
import { currentPick, teamPicks, type DraftState } from './draft.js';

export interface DraftablePlayer {
  playerId: string;
  /** Fantasy positions, primary first. */
  positions: readonly Position[];
}

/**
 * Player rankings: either ids best-first, or a map of id to rank (lower is better). Unranked
 * players come after every ranked one.
 */
export type PlayerRankings = readonly string[] | Readonly<Record<string, number>>;

/** The roster the team is drafting for (league `roster` settings). */
export type RosterNeeds = Pick<LeagueSettings, 'roster'>;

export interface AutopickChoice {
  playerId: string;
  positions: readonly Position[];
  /** `starter_need`: fills an empty starting slot. `best_available`: every starting slot is full. */
  reason: 'starter_need' | 'best_available';
}

/**
 * Starting slots still empty after placing the given players. Each player goes into the most
 * specific open slot he is eligible for (QB before Q/W/R/T, WR before W/R/T), so flex slots stay
 * open for as long as possible.
 */
export function unfilledStarterSlots(
  needs: RosterNeeds,
  drafted: readonly (readonly Position[])[]
): RosterSlot[] {
  const open: RosterSlot[] = [];
  const bySpecificity = [...ROSTER_SLOTS]
    .filter(isStarterSlot)
    .sort((a, b) => SLOT_ELIGIBILITY[a].length - SLOT_ELIGIBILITY[b].length);
  for (const slot of bySpecificity) {
    for (let i = 0; i < (needs.roster.slots[slot] ?? 0); i++) open.push(slot);
  }
  const players = [...drafted].sort((a, b) => a.length - b.length);
  for (const positions of players) {
    const idx = open.findIndex((slot) => isEligibleForSlot(slot, positions));
    if (idx >= 0) open.splice(idx, 1);
  }
  return open;
}

function rankOf(rankings: PlayerRankings): (id: string) => number {
  if (Array.isArray(rankings)) {
    const index = new Map((rankings as readonly string[]).map((id, i) => [id, i]));
    return (id) => index.get(id) ?? Number.POSITIVE_INFINITY;
  }
  const map = rankings as Readonly<Record<string, number>>;
  return (id) => (Object.hasOwn(map, id) ? (map[id] as number) : Number.POSITIVE_INFINITY);
}

/**
 * Chooses a pick for the team on the clock: the best-ranked available player who fills an empty
 * starting slot, or the best-ranked available player once every starting slot is filled. So a team
 * never takes a second K or DEF (or any bench player) while a starting slot is still open.
 *
 * Players already drafted, and players at a position the team has maxed out, are skipped. Equal
 * ranks break by player id. Returns null when the draft is over or no player qualifies.
 */
export function autopick(
  draft: DraftState,
  availablePlayers: readonly DraftablePlayer[],
  rankings: PlayerRankings,
  rosterNeeds: RosterNeeds
): AutopickChoice | null {
  const slot = currentPick(draft);
  if (!slot) return null;
  const drafted = new Set(draft.picks.map((p) => p.playerId));
  const mine = teamPicks(draft, slot.teamId);
  const counts = new Map<Position, number>();
  for (const p of mine) {
    const primary = p.positions[0];
    if (primary) counts.set(primary, (counts.get(primary) ?? 0) + 1);
  }
  const atLimit = (player: DraftablePlayer): boolean => {
    const primary = player.positions[0];
    if (primary === undefined) return false;
    const limit = draft.positionLimits[primary];
    return limit !== undefined && (counts.get(primary) ?? 0) >= limit;
  };
  const rank = rankOf(rankings);
  const candidates = availablePlayers
    .filter((p) => !drafted.has(p.playerId) && !atLimit(p))
    .sort((a, b) => {
      const d = rank(a.playerId) - rank(b.playerId);
      if (d !== 0 && !Number.isNaN(d)) return d;
      return a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0;
    });
  const open = unfilledStarterSlots(
    rosterNeeds,
    mine.map((p) => p.positions)
  );
  const filler = candidates.find((p) => open.some((s) => isEligibleForSlot(s, p.positions)));
  if (filler) return { playerId: filler.playerId, positions: filler.positions, reason: 'starter_need' };
  const best = candidates[0];
  return best ? { playerId: best.playerId, positions: best.positions, reason: 'best_available' } : null;
}
