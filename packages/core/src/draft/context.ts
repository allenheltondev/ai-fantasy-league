import { normalizePlayerStatus, WILL_NOT_PLAY_STATUSES, type Position } from '../rules/positions.js';
import type { ScheduleSettings } from '../rules/settings.js';
import {
  autopick,
  rankOf,
  type AutopickChoice,
  type DraftablePlayer,
  type PlayerRankings,
  type RosterNeeds
} from './autopick.js';
import {
  currentPick,
  pickSlot,
  picksUntilTurn,
  totalPicks,
  type DraftPick,
  type DraftState
} from './draft.js';

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
 * How a person has drafted so far, read from their own picks (#151): the position they keep
 * taking (`lean`), and how many picks ahead of consensus rank they typically take a player
 * (`reach`). Built from the public draft history only. A team's draft queue is private to it, and
 * the estimate is shown to other teams, so it never reads a queue: any queue-driven prediction
 * would show other teams who is queued.
 */
export interface DraftTendency {
  lean: Position;
  /** Picks ahead of consensus rank, averaged over the team's own picks (0 = drafts by consensus). */
  reach: number;
}

/** A team shows a tendency only after making this many picks itself (not autopicked). */
export const TENDENCY_MIN_PICKS = 3;
/** The furthest the model expects a team to reach, in picks. */
export const MAX_TENDENCY_REACH = 24;

/**
 * `teamId`'s drafting tendency, or null when its history says nothing yet: fewer than
 * `TENDENCY_MIN_PICKS` picks it made itself (autopicks follow consensus, not the person), or no
 * position taken at least twice and more often than any other.
 */
export function draftTendency(
  picks: readonly Pick<DraftPick, 'teamId' | 'positions' | 'auto' | 'overall' | 'adp'>[],
  teamId: string
): DraftTendency | null {
  const own = picks.filter((p) => p.teamId === teamId && !p.auto);
  if (own.length < TENDENCY_MIN_PICKS) return null;
  const [first, second] = recentPositionRun(own, own.length);
  if (first === undefined || first.count < 2 || first.count === second?.count) return null;
  const reaches = own.flatMap((p) =>
    p.adp === null || p.adp === undefined ? [] : [Math.max(0, p.adp - p.overall)]
  );
  const mean = reaches.length === 0 ? 0 : reaches.reduce((sum, r) => sum + r, 0) / reaches.length;
  return { lean: first.position, reach: Math.min(MAX_TENDENCY_REACH, Math.round(mean)) };
}

/** Draft tendencies by team id: the teams the estimate models as people (`draftTendency`). */
export type DraftTendencies = Readonly<Record<string, DraftTendency | null | undefined>>;

/**
 * Who the team on the clock likely takes: core autopick by consensus rank, except that a team with a
 * tendency takes the best player at its lean position within its reach of autopick's choice, when
 * that player still fits its roster (the same checks as a queued pick).
 */
function predictedPick(
  draft: DraftState,
  available: readonly DraftablePlayer[],
  rankings: PlayerRankings,
  needs: RosterNeeds,
  tendency: DraftTendency | null | undefined
): AutopickChoice | null {
  const base = autopick(draft, available, rankings, needs);
  if (base === null || tendency === null || tendency === undefined) return base;
  const rank = rankOf(rankings);
  const within = rank(base.playerId) + tendency.reach;
  const leaning = available
    .filter((p) => p.positions[0] === tendency.lean && rank(p.playerId) <= within)
    .sort((a, b) => rank(a.playerId) - rank(b.playerId) || a.playerId.localeCompare(b.playerId))
    .map((p) => p.playerId);
  return autopick(draft, available, rankings, needs, leaning);
}

/** Plays out the next `count` picks from `draft` with `predictedPick`, stopping when nobody fits. */
function playOut(
  draft: DraftState,
  count: number,
  available: readonly DraftablePlayer[],
  rankings: PlayerRankings,
  needs: RosterNeeds,
  tendencies: DraftTendencies
): string[] {
  let state = draft;
  const taken: string[] = [];
  for (let i = 0; i < count; i++) {
    const slot = currentPick(state);
    if (slot === null) break;
    const choice = predictedPick(state, available, rankings, needs, tendencies[slot.teamId]);
    if (choice === null) break;
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

/**
 * Players the other teams will likely take before `teamId` picks again, in the order they go.
 * Each team in between takes what core autopick would take for it by consensus rank: the best player
 * for an empty starting slot, else the best player. A team in `tendencies` (the people, #151) leans
 * toward the position its own picks favour, as far ahead of consensus as it has been reaching. The
 * pick on the clock (`teamId`'s) is skipped, so nobody is assumed gone to it. Deterministic, and a
 * hint only: real drafters reach.
 */
export function likelyTakenBeforeNextTurn(
  draft: DraftState,
  teamId: string,
  available: readonly DraftablePlayer[],
  rankings: PlayerRankings,
  needs: RosterNeeds,
  tendencies: DraftTendencies = {}
): string[] {
  const between = picksBeforeNextTurn(draft, teamId);
  const clock = currentPick(draft);
  if (between === null || clock === null) return [];
  const state: DraftState = { ...draft, picks: [...draft.picks, placeholder(clock, teamId)] };
  return playOut(state, between, available, rankings, needs, tendencies);
}

/**
 * Players the other teams will likely take before `teamId` next picks, seen from anyone's seat: when
 * `teamId` is on the clock, those gone before its following pick (`likelyTakenBeforeNextTurn`);
 * otherwise, those gone before its upcoming pick. Same model, same caveat: a hint.
 */
export function likelyGoneBeforeYourPick(
  draft: DraftState,
  teamId: string,
  available: readonly DraftablePlayer[],
  rankings: PlayerRankings,
  needs: RosterNeeds,
  tendencies: DraftTendencies = {}
): string[] {
  const clock = currentPick(draft);
  if (clock === null) return [];
  if (clock.teamId === teamId) {
    return likelyTakenBeforeNextTurn(draft, teamId, available, rankings, needs, tendencies);
  }
  const away = picksUntilTurn(draft, teamId);
  if (away === null) return [];
  return playOut(draft, away, available, rankings, needs, tendencies);
}

/** How deep a position still runs: among the best available players, how many play it. */
export interface PositionScarcity<P extends Position = Position> {
  position: P;
  /** Players at the position among the `top` best available (primary position). */
  left: number;
  /** Of those, how many will likely be gone before your next pick. */
  likelyGone: number;
}

/**
 * Per position, how many of the `top` best available players (best first) play it, and how many of
 * those `gone` names. Positions in `positions` order; a position with none left still appears.
 */
export function positionScarcity<P extends Position>(
  available: readonly DraftablePlayer[],
  gone: readonly string[],
  positions: readonly P[],
  top: number,
  /** Positions counted across the whole pool instead: ones the ranking leaves out (team defenses). */
  unranked: readonly P[] = []
): PositionScarcity<P>[] {
  const best = available.slice(0, Math.max(0, top));
  const goneSet = new Set(gone);
  return positions.map((position) => {
    const from = unranked.includes(position) ? available : best;
    const at = from.filter((p) => p.positions[0] === position);
    return { position, left: at.length, likelyGone: at.filter((p) => goneSet.has(p.playerId)).length };
  });
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
