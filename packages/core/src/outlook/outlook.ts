import {
  ROSTER_SLOTS,
  WILL_NOT_PLAY_STATUSES,
  isEligibleForSlot,
  isStarterSlot,
  type PlayerStatus,
  type Position,
  type RosterSlot
} from '../rules/positions.js';
import { slotCount, type LeagueSettings } from '../rules/settings.js';
import { roundPoints } from '../scoring/engine.js';

/**
 * Matchup outlook math (SPEC §6 `get_matchup_outlook`): a projected outcome with a win probability
 * from a simple normal model, plus lineup insights. Pure: the caller supplies projections, points so
 * far, and each player's game state.
 */

/** Where a player's NFL game stands this week. */
export type GameState = 'bye' | 'pending' | 'live' | 'final';

export interface OutlookPlayer {
  playerId: string;
  slot: RosterSlot;
  positions: readonly Position[];
  status: PlayerStatus;
  game: GameState;
  /** Projected points for the whole game under league scoring, or null when unprojected. */
  projected: number | null;
  /** Points so far, or null before he has stats. */
  actual: number | null;
}

/**
 * The variance model. A pending player's score is normal with mean = projection and standard
 * deviation = `sdRatio` × projection (at least `sdFloor` when projected above 0); weekly fantasy
 * scores have a standard deviation of roughly 40-50% of the mean. A live game has no clock in our
 * data, so half the unmet projection is assumed to remain (`liveRemainingShare`). Final games, byes,
 * and players ruled out carry no uncertainty.
 */
export const OUTLOOK_MODEL = { sdRatio: 0.45, sdFloor: 2, liveRemainingShare: 0.5 } as const;

export interface PlayerForecast {
  /** Expected final points. */
  mean: number;
  variance: number;
  /** Points so far. */
  current: number;
  /** Expected points still to come. */
  remaining: number;
}

/** True once a player's game has kicked off: he cannot change slots. */
export function isLocked(player: Pick<OutlookPlayer, 'game'>): boolean {
  return player.game === 'live' || player.game === 'final';
}

/** True when the player will score nothing more this week: on bye or with a will-not-play status. */
export function willNotPlay(player: Pick<OutlookPlayer, 'game' | 'status'>): boolean {
  return player.game === 'bye' || WILL_NOT_PLAY_STATUSES.includes(player.status);
}

export function forecastPlayer(player: OutlookPlayer): PlayerForecast {
  const current = player.actual ?? 0;
  const projected = Math.max(player.projected ?? 0, 0);
  const sd = (mean: number) => (mean > 0 ? Math.max(OUTLOOK_MODEL.sdFloor, OUTLOOK_MODEL.sdRatio * mean) : 0);
  if (player.game === 'final' || (player.game !== 'live' && willNotPlay(player))) {
    return { mean: current, variance: 0, current, remaining: 0 };
  }
  if (player.game === 'live') {
    const remaining = Math.max(projected - current, 0) * OUTLOOK_MODEL.liveRemainingShare;
    const spread = OUTLOOK_MODEL.sdRatio * remaining;
    return { mean: current + remaining, variance: spread * spread, current, remaining };
  }
  const spread = sd(projected);
  return { mean: projected, variance: spread * spread, current: 0, remaining: projected };
}

export interface TeamForecast {
  /** Starters' points so far. */
  current: number;
  /** Expected final score (points so far plus expected remaining points). */
  projected: number;
  remaining: number;
  stdDev: number;
  /** Starters whose game has not kicked off (byes and players ruled out excluded). */
  yetToPlay: number;
  /** Starters whose game is under way. */
  inProgress: number;
}

/** The starters' combined forecast; players on the bench or IR do not count. */
export function forecastTeam(players: readonly OutlookPlayer[]): TeamForecast {
  let current = 0;
  let mean = 0;
  let variance = 0;
  let yetToPlay = 0;
  let inProgress = 0;
  for (const player of players) {
    if (!isStarterSlot(player.slot)) continue;
    const f = forecastPlayer(player);
    current += f.current;
    mean += f.mean;
    variance += f.variance;
    if (player.game === 'live') inProgress++;
    else if (player.game === 'pending' && !willNotPlay(player)) yetToPlay++;
  }
  return {
    current: roundPoints(current),
    projected: roundPoints(mean),
    remaining: roundPoints(mean - current),
    stdDev: roundPoints(Math.sqrt(variance)),
    yetToPlay,
    inProgress
  };
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26, |error| < 1.5e-7), exactly symmetric. */
export function normalCdf(z: number): number {
  if (z === 0) return 0.5;
  if (z < 0) return 1 - normalCdf(-z);
  const t = 1 / (1 + 0.3275911 * (z / Math.SQRT2));
  const poly =
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return 0.5 * (1 + erf);
}

/**
 * P(team A outscores team B), treating the final margin as normal with mean A − B and variance
 * A.stdDev² + B.stdDev². With no uncertainty left the leader wins outright (a tie is 0.5).
 * Rounded to 3 decimals; `winProbability(a, b) + winProbability(b, a)` is always 1.
 */
export function winProbability(
  a: Pick<TeamForecast, 'projected' | 'stdDev'>,
  b: Pick<TeamForecast, 'projected' | 'stdDev'>
): number {
  const margin = a.projected - b.projected;
  const spread = Math.sqrt(a.stdDev * a.stdDev + b.stdDev * b.stdDev);
  const p = spread === 0 ? (margin > 0 ? 1 : margin < 0 ? 0 : 0.5) : normalCdf(margin / spread);
  // Round the smaller side and derive the other, so the pair always sums to exactly 1.
  return p <= 0.5 ? Math.round(p * 1000) / 1000 : (1000 - Math.round((1 - p) * 1000)) / 1000;
}

export interface EmptySlot {
  slot: RosterSlot;
  missing: number;
}

export interface StarterProblem {
  playerId: string;
  slot: RosterSlot;
  reason: 'bye' | 'out';
}

export interface BenchUpgrade {
  benchPlayerId: string;
  /** The starter to replace, or null to fill an empty slot. */
  starterPlayerId: string | null;
  slot: RosterSlot;
  /** Projected points gained by the swap. */
  gain: number;
}

export interface LineupInsights {
  emptySlots: EmptySlot[];
  /** Starters on bye or ruled out whose slot can still be changed. */
  startersOut: StarterProblem[];
  /** Best swap per unlocked bench player that projects higher than an unlocked starter he can replace. */
  benchUpgrades: BenchUpgrade[];
  /** Players whose game has kicked off. */
  locked: string[];
}

/** The projection a starter is worth this week: nothing when he will not play. */
function worth(player: OutlookPlayer): number {
  return willNotPlay(player) ? 0 : Math.max(player.projected ?? 0, 0);
}

export function emptySlots(
  settings: Pick<LeagueSettings, 'roster'>,
  players: readonly OutlookPlayer[]
): EmptySlot[] {
  const out: EmptySlot[] = [];
  for (const slot of ROSTER_SLOTS) {
    if (!isStarterSlot(slot)) continue;
    const missing = slotCount(settings, slot) - players.filter((p) => p.slot === slot).length;
    if (missing > 0) out.push({ slot, missing });
  }
  return out;
}

export function lineupInsights(
  settings: Pick<LeagueSettings, 'roster'>,
  players: readonly OutlookPlayer[]
): LineupInsights {
  const empty = emptySlots(settings, players);
  const starters = players.filter((p) => isStarterSlot(p.slot));
  const startersOut: StarterProblem[] = starters
    .filter((p) => !isLocked(p) && willNotPlay(p))
    .map((p) => ({
      playerId: p.playerId,
      slot: p.slot,
      reason: p.game === 'bye' ? ('bye' as const) : ('out' as const)
    }));

  const benchUpgrades: BenchUpgrade[] = [];
  for (const bench of players) {
    if (bench.slot !== 'BN' || isLocked(bench) || willNotPlay(bench)) continue;
    const value = worth(bench);
    let best: BenchUpgrade | null = null;
    for (const starter of starters) {
      if (isLocked(starter) || !isEligibleForSlot(starter.slot, bench.positions)) continue;
      const gain = value - worth(starter);
      if (gain > 0 && (best === null || gain > best.gain)) {
        best = { benchPlayerId: bench.playerId, starterPlayerId: starter.playerId, slot: starter.slot, gain };
      }
    }
    for (const { slot } of empty) {
      if (value > 0 && isEligibleForSlot(slot, bench.positions) && (best === null || value > best.gain)) {
        best = { benchPlayerId: bench.playerId, starterPlayerId: null, slot, gain: value };
      }
    }
    if (best !== null && roundPoints(best.gain) > 0)
      benchUpgrades.push({ ...best, gain: roundPoints(best.gain) });
  }
  benchUpgrades.sort((a, b) => b.gain - a.gain || a.benchPlayerId.localeCompare(b.benchPlayerId));

  return {
    emptySlots: empty,
    startersOut,
    benchUpgrades,
    locked: players.filter(isLocked).map((p) => p.playerId)
  };
}

export interface WeakSpot {
  slot: RosterSlot;
  /** The opponent's player in that slot, or null for an empty slot. */
  playerId: string | null;
  reason: 'empty' | 'bye' | 'out' | 'outprojected';
  /** The opponent's expected points from that slot. */
  theirProjected: number;
  /** Your starter lined up against it (same slot, same rank by projection), or null. */
  yourPlayerId: string | null;
  yourProjected: number;
  /** Your expected points minus theirs in that slot. */
  edge: number;
}

/**
 * Where the opponent is weak: empty slots, starters on bye or ruled out, and slots where your
 * starter out-projects theirs. Starters are paired slot by slot, best projection against best.
 * Sorted by your edge, largest first.
 */
export function opponentWeakSpots(
  settings: Pick<LeagueSettings, 'roster'>,
  yours: readonly OutlookPlayer[],
  theirs: readonly OutlookPlayer[]
): WeakSpot[] {
  const spots: WeakSpot[] = [];
  const expected = (p: OutlookPlayer) => roundPoints(forecastPlayer(p).mean);
  for (const slot of ROSTER_SLOTS) {
    if (!isStarterSlot(slot)) continue;
    const ranked = (side: readonly OutlookPlayer[]) =>
      side
        .filter((p) => p.slot === slot)
        .sort((a, b) => expected(b) - expected(a) || a.playerId.localeCompare(b.playerId));
    const mine = ranked(yours);
    const other = ranked(theirs);
    for (let i = 0; i < slotCount(settings, slot); i++) {
      const me = mine[i];
      const them = other[i];
      const yourProjected = me === undefined ? 0 : expected(me);
      const theirProjected = them === undefined ? 0 : expected(them);
      const reason: WeakSpot['reason'] | null =
        them === undefined
          ? 'empty'
          : willNotPlay(them)
            ? them.game === 'bye'
              ? 'bye'
              : 'out'
            : yourProjected > theirProjected
              ? 'outprojected'
              : null;
      if (reason === null) continue;
      spots.push({
        slot,
        playerId: them?.playerId ?? null,
        reason,
        theirProjected,
        yourPlayerId: me?.playerId ?? null,
        yourProjected,
        edge: roundPoints(yourProjected - theirProjected)
      });
    }
  }
  // Stable sort: ties keep roster slot order.
  return spots.sort((a, b) => b.edge - a.edge);
}
