import { normalizePlayerStatus, WILL_NOT_PLAY_STATUSES, type Position } from '../rules/positions.js';
import type { ScheduleSettings } from '../rules/settings.js';
import { autopick, type DraftablePlayer, type PlayerRankings, type RosterNeeds } from './autopick.js';
import { currentPick, pickSlot, totalPicks, type DraftPick, type DraftState } from './draft.js';

/**
 * Draft context: the small, deterministic facts a drafter weighs beyond rank (issue #135). How long
 * until my next pick and who will be gone by then, what positions are running, where the season
 * stands for a mid-season draft, and the bye-week and injury risk of a candidate. Agents put these
 * in their draft prompt, and their autopick (recommendation and fallback) uses the risk multiplier.
 */

/**
 * Picks the other teams make after the pick on the clock and before `teamId` picks again, or null
 * when the pick on the clock is `teamId`'s last one (or the draft is over). In a snake draft, pick
 * p of n in a round waits 2(n - p) picks: the rest of this round, then as many of the next.
 */
export function picksBeforeNextTurn(draft: DraftState, teamId: string): number | null {
  const now = draft.picks.length + 1;
  for (let o = now + 1; o <= totalPicks(draft); o++) {
    if (pickSlot(draft, o)?.teamId === teamId) return o - now - 1;
  }
  return null;
}

export interface PositionCount {
  position: Position;
  count: number;
}

/**
 * The primary positions of the last `n` picks, most-picked first (ties in order of first
 * appearance, newest first). A run on a position shows as a high count.
 */
export function recentPositionRun(
  picks: readonly Pick<DraftPick, 'positions'>[],
  n: number
): PositionCount[] {
  const counts = new Map<Position, number>();
  for (const pick of picks.slice(Math.max(0, picks.length - Math.max(0, n))).reverse()) {
    const position = pick.positions[0];
    if (position !== undefined) counts.set(position, (counts.get(position) ?? 0) + 1);
  }
  return [...counts].map(([position, count]) => ({ position, count })).sort((a, b) => b.count - a.count);
}

/**
 * Players the other teams will likely take before `teamId` picks again, in the order they go.
 * Each team in between takes what core autopick would take for it by consensus rank: the best player
 * for an empty starting slot, else the best player. The pick on the clock (`teamId`'s) is skipped,
 * so nobody is assumed gone to it. Deterministic, and a hint only: real drafters reach.
 */
export function likelyTakenBeforeNextTurn(
  draft: DraftState,
  teamId: string,
  available: readonly DraftablePlayer[],
  rankings: PlayerRankings,
  needs: RosterNeeds
): string[] {
  const between = picksBeforeNextTurn(draft, teamId);
  const clock = currentPick(draft);
  if (between === null || clock === null) return [];
  let state: DraftState = { ...draft, picks: [...draft.picks, placeholder(clock, teamId)] };
  const taken: string[] = [];
  for (let i = 0; i < between; i++) {
    const slot = currentPick(state);
    const choice = autopick(state, available, rankings, needs);
    if (slot === null || choice === null) break;
    taken.push(choice.playerId);
    state = {
      ...state,
      picks: [
        ...state.picks,
        { ...slot, playerId: choice.playerId, positions: choice.positions, madeAt: null, auto: true }
      ]
    };
  }
  return taken;
}

function placeholder(slot: NonNullable<ReturnType<typeof currentPick>>, teamId: string): DraftPick {
  return { ...slot, teamId, playerId: '\u0000on-the-clock', positions: [], madeAt: null, auto: false };
}

/** Where the fantasy regular season stands for a draft. */
export interface SeasonWindow {
  /** First week the drafted team plays: the league's start week, or the current NFL week if later. */
  firstWeek: number;
  /** Last regular-season week. */
  lastWeek: number;
  /** Regular-season weeks left to play, counting `firstWeek`. */
  weeksRemaining: number;
  /** True when the league starts after NFL week 1: injured players cost games that count. */
  midSeason: boolean;
  /** True when few regular-season weeks remain: production now beats upside. */
  shortSeason: boolean;
}

/** At or below this many regular-season weeks left, a draft should favour players producing now. */
export const SHORT_SEASON_WEEKS = 8;

export function seasonWindow(schedule: ScheduleSettings, currentWeek: number | null): SeasonWindow {
  const firstWeek = Math.max(schedule.startWeek, currentWeek ?? 0);
  const weeksRemaining = Math.max(0, schedule.regularSeasonEndWeek - firstWeek + 1);
  return {
    firstWeek,
    lastWeek: schedule.regularSeasonEndWeek,
    weeksRemaining,
    midSeason: firstWeek > 1,
    shortSeason: weeksRemaining <= SHORT_SEASON_WEEKS
  };
}

/** True when a bye week falls in the weeks the team still plays. */
export function byeRemains(
  bye: number | null,
  window: Pick<SeasonWindow, 'firstWeek' | 'lastWeek'>
): boolean {
  return bye !== null && bye >= window.firstWeek && bye <= window.lastWeek;
}

/** True for an injury designation that means the player will not play (Out, IR, PUP, suspended). */
export function isSidelined(injuryStatus: string | null): boolean {
  return WILL_NOT_PLAY_STATUSES.includes(normalizePlayerStatus(injuryStatus));
}

export interface DraftRiskPlayer {
  position: Position;
  /** NFL bye week, or null when unknown. */
  bye: number | null;
  injuryStatus?: string | null;
}

/** Rank multiplier for a player whose bye matches most of the team's players at his position. */
export const BYE_CLASH_PENALTY = 1.25;
/** Rank multiplier for a sidelined player in a mid-season draft. */
export const SIDELINED_PENALTY = 3;

/**
 * True when the candidate's bye (still to come) is the bye of most of the team's players at his
 * position, so drafting him leaves that position empty that week.
 */
export function byeClash(
  candidate: DraftRiskPlayer,
  roster: readonly DraftRiskPlayer[],
  window: Pick<SeasonWindow, 'firstWeek' | 'lastWeek'>
): boolean {
  if (!byeRemains(candidate.bye, window)) return false;
  const mates = roster.filter((p) => p.position === candidate.position);
  const same = mates.filter((p) => p.bye === candidate.bye).length;
  return mates.length > 0 && same * 2 > mates.length;
}

/**
 * How much worse to rank a candidate (1 = no change; multiply a rank, lower is better): a bye
 * clash with the team's players at his position, and, in a mid-season draft, a player who is not
 * playing. Used by agent autopick; human autopick keeps pure consensus rank.
 */
export function draftRiskMultiplier(
  candidate: DraftRiskPlayer,
  roster: readonly DraftRiskPlayer[],
  window: SeasonWindow
): number {
  let multiplier = 1;
  if (byeClash(candidate, roster, window)) multiplier *= BYE_CLASH_PENALTY;
  if (window.midSeason && isSidelined(candidate.injuryStatus ?? null)) multiplier *= SIDELINED_PENALTY;
  return multiplier;
}
