import type { RosterPlayer } from '../rules/lineup.js';
import {
  POSITIONS,
  ROSTER_SLOTS,
  SLOT_ELIGIBILITY,
  isEligibleForSlot,
  isStarterSlot,
  type PlayerStatus,
  type Position
} from '../rules/positions.js';
import { slotCount, type LeagueSettings } from '../rules/settings.js';
import { roundPoints, scorePlayer, type ScoringSource, type StatLine } from '../scoring/engine.js';

/** Projected fantasy points by player, then by NFL week. A missing week (bye, no projection) is 0. */
export type PlayerProjections = Readonly<Record<string, Readonly<Record<number, number>>>>;

/** Projected fantasy points for one week, by player. */
export type WeekProjections = Readonly<Record<string, number>>;

/** Projected points for a projected stat line, scored exactly like real stats. */
export function projectPoints(scoring: ScoringSource, projectedStatLine: StatLine): number {
  return scorePlayer(scoring, projectedStatLine).points;
}

/** Builds a projection table from projected stat lines (player → week → stat line). */
export function projectionsFromStatLines(
  scoring: ScoringSource,
  lines: Readonly<Record<string, Readonly<Record<number, StatLine>>>>
): Record<string, Record<number, number>> {
  const out: Record<string, Record<number, number>> = {};
  for (const [playerId, weeks] of Object.entries(lines)) {
    const row: Record<number, number> = {};
    for (const [week, line] of Object.entries(weeks)) row[Number(week)] = projectPoints(scoring, line);
    out[playerId] = row;
  }
  return out;
}

/** One week's slice of a projection table. */
export function weekProjections(projections: PlayerProjections, week: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [playerId, weeks] of Object.entries(projections)) {
    const pts = weeks[week];
    if (pts !== undefined) out[playerId] = pts;
  }
  return out;
}

/**
 * Knobs that let strategy archetypes value players differently.
 * - `positionWeights`: multiplies a position's value (a zero-RB drafter might use `{ RB: 0.7 }`). Default 1.
 * - `riskTolerance`: 0 applies the full injury-status discount, 1 ignores injuries. Default 0.5.
 * - `recencyBias`: 0 weighs every remaining week equally; values toward 1 favour the next few weeks
 *   (win-now). The weights are normalized so the total stays on the points scale. Default 0.
 */
export interface ValuationWeights {
  positionWeights?: Partial<Record<Position, number>>;
  riskTolerance?: number;
  recencyBias?: number;
}

/** Hook for strength of schedule: a multiplier on a player's projection in a week (default 1). */
export type ScheduleFactor = (playerId: string, week: number) => number;

export interface ValuationOptions {
  /** First week to count (usually the current or next week). */
  fromWeek: number;
  /** Last week to count, inclusive. */
  toWeek: number;
  weights?: ValuationWeights;
  scheduleFactor?: ScheduleFactor;
}

export type ValuedPlayer = Pick<RosterPlayer, 'playerId' | 'positions' | 'status'>;

/** How much of a player's value an injury status puts at risk, at `riskTolerance` 0. */
export const STATUS_RISK: Readonly<Record<PlayerStatus, number>> = {
  active: 0,
  questionable: 0.1,
  doubtful: 0.3,
  covid: 0.3,
  out: 0.4,
  suspended: 0.5,
  na: 0.5,
  ir: 0.7,
  pup: 0.7,
  nfi: 0.7
};

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Per-week weights for `recencyBias`, normalized to average 1. */
export function recencyWeights(fromWeek: number, toWeek: number, recencyBias = 0): number[] {
  const n = Math.max(0, toWeek - fromWeek + 1);
  if (n === 0) return [];
  const decay = 1 - clamp01(recencyBias) * 0.99;
  const raw = Array.from({ length: n }, (_, i) => decay ** i);
  const mean = raw.reduce((a, b) => a + b, 0) / n;
  return raw.map((w) => w / mean);
}

/** Rest-of-season projected points with recency weights and the schedule factor (no injury risk). */
export function restOfSeasonPoints(
  playerId: string,
  projections: PlayerProjections,
  options: ValuationOptions
): number {
  const weeks = projections[playerId] ?? {};
  const weights = recencyWeights(options.fromWeek, options.toWeek, options.weights?.recencyBias);
  let total = 0;
  weights.forEach((w, i) => {
    const week = options.fromWeek + i;
    const factor = options.scheduleFactor ? options.scheduleFactor(playerId, week) : 1;
    total += (weeks[week] ?? 0) * w * factor;
  });
  return total;
}

/** Multiplier that discounts a player's points for his injury status. */
export function riskMultiplier(status: PlayerStatus, riskTolerance = 0.5): number {
  return 1 - (1 - clamp01(riskTolerance)) * STATUS_RISK[status];
}

export type ReplacementLevels = Record<Position, number>;

/**
 * Replacement level by position, VORP style. The league's starting slots (times the team count) are
 * filled from `pool` by rest-of-season points: single-position slots first, then flex slots from the
 * most to the least restrictive. A position's replacement level is the best player at that position
 * left over (0 if none). Players count at their first listed position.
 */
export function replacementLevels(
  settings: Pick<LeagueSettings, 'teamCount' | 'roster'>,
  pool: readonly ValuedPlayer[],
  projections: PlayerProjections,
  options: ValuationOptions
): ReplacementLevels {
  const ranked = pool
    .filter((p) => p.positions.length > 0)
    .map((p) => ({
      playerId: p.playerId,
      position: p.positions[0] as Position,
      points: restOfSeasonPoints(p.playerId, projections, options)
    }))
    .sort((a, b) => b.points - a.points || a.playerId.localeCompare(b.playerId));

  const slots = ROSTER_SLOTS.filter((s) => isStarterSlot(s) && slotCount(settings, s) > 0).sort(
    (a, b) => SLOT_ELIGIBILITY[a].length - SLOT_ELIGIBILITY[b].length
  );
  const taken = new Set<string>();
  for (const slot of slots) {
    let need = slotCount(settings, slot) * settings.teamCount;
    for (const p of ranked) {
      if (need === 0) break;
      if (!taken.has(p.playerId) && isEligibleForSlot(slot, [p.position])) {
        taken.add(p.playerId);
        need -= 1;
      }
    }
  }

  const levels = Object.fromEntries(POSITIONS.map((pos) => [pos, 0])) as ReplacementLevels;
  const seen = new Set<Position>();
  for (const p of ranked) {
    if (taken.has(p.playerId) || seen.has(p.position)) continue;
    seen.add(p.position);
    levels[p.position] = p.points;
  }
  return levels;
}

export interface PlayerValuation {
  playerId: string;
  position: Position | null;
  /** Rest-of-season points after recency weights and the schedule factor. */
  rosPoints: number;
  /** `rosPoints` after the injury-risk discount. */
  adjustedPoints: number;
  replacementPoints: number;
  /** Value over replacement: `adjustedPoints − replacementPoints`. */
  vorp: number;
  /** `vorp` times the position weight. Negative means worse than a replacement-level pickup. */
  value: number;
}

/** Rest-of-season value for one player. Pass `replacement` (from `replacementLevels`) for VORP. */
export function playerValue(
  player: ValuedPlayer,
  projections: PlayerProjections,
  options: ValuationOptions & { replacement?: Partial<ReplacementLevels> }
): PlayerValuation {
  const position = player.positions[0] ?? null;
  const rosPoints = restOfSeasonPoints(player.playerId, projections, options);
  const adjustedPoints = rosPoints * riskMultiplier(player.status, options.weights?.riskTolerance);
  const replacementPoints = position ? (options.replacement?.[position] ?? 0) : 0;
  const vorp = adjustedPoints - replacementPoints;
  const weight = position ? (options.weights?.positionWeights?.[position] ?? 1) : 1;
  return {
    playerId: player.playerId,
    position,
    rosPoints: roundPoints(rosPoints),
    adjustedPoints: roundPoints(adjustedPoints),
    replacementPoints: roundPoints(replacementPoints),
    vorp: roundPoints(vorp),
    value: roundPoints(vorp * weight)
  };
}

/** Values every player in `pool`, with replacement levels derived from the same pool. Highest first. */
export function valuePlayers(
  settings: Pick<LeagueSettings, 'teamCount' | 'roster'>,
  pool: readonly ValuedPlayer[],
  projections: PlayerProjections,
  options: ValuationOptions
): PlayerValuation[] {
  const replacement = replacementLevels(settings, pool, projections, options);
  return pool
    .map((p) => playerValue(p, projections, { ...options, replacement }))
    .sort((a, b) => b.value - a.value || a.playerId.localeCompare(b.playerId));
}
