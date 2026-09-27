import type { NflState, ScheduledGame, SeasonType } from '../types.js';

const HOUR = 3_600_000;

/** Default length of a game window: kickoff until the game is assumed final. */
export const DEFAULT_GAME_DURATION_MS = 4 * HOUR;

/**
 * Default delay from a week's last kickoff to rollover. Monday night at 8:15pm ET + 36h lands on
 * Wednesday morning, roughly when Sleeper moves its `week`.
 */
export const DEFAULT_ROLLOVER_DELAY_MS = 36 * HOUR;

export interface WeekRollover {
  kind: 'week' | 'season_type' | 'season';
  from: { season: number; seasonType: SeasonType; week: number };
  to: { season: number; seasonType: SeasonType; week: number };
}

const SEASON_TYPE_ORDER: Record<SeasonType, number> = { pre: 0, regular: 1, post: 2, off: 3 };

/**
 * Compares two polls of the NFL state and returns the rollover to announce (`Week Rolled Over`),
 * or null. The first observation (no previous state) and backwards moves (upstream glitches) are
 * not rollovers.
 */
export function detectWeekRollover(prev: NflState | null | undefined, next: NflState): WeekRollover | null {
  if (!prev) return null;
  const from = { season: prev.season, seasonType: prev.seasonType, week: prev.week };
  const to = { season: next.season, seasonType: next.seasonType, week: next.week };
  if (next.season !== prev.season) {
    return next.season > prev.season ? { kind: 'season', from, to } : null;
  }
  if (next.seasonType !== prev.seasonType) {
    return SEASON_TYPE_ORDER[next.seasonType] > SEASON_TYPE_ORDER[prev.seasonType]
      ? { kind: 'season_type', from, to }
      : null;
  }
  return next.week > prev.week ? { kind: 'week', from, to } : null;
}

export interface GameWindowOptions {
  /** How long after kickoff a game counts as live. Default 4 hours. */
  gameDurationMs?: number;
  /** Start the window this long before kickoff (for pre-game polling). Default 0. */
  leadMs?: number;
}

/** Games live at `now`: kickoff − lead ≤ now < kickoff + duration, and not already final early. */
export function liveGames(
  now: Date,
  schedule: readonly ScheduledGame[],
  options: GameWindowOptions = {}
): ScheduledGame[] {
  const duration = options.gameDurationMs ?? DEFAULT_GAME_DURATION_MS;
  const lead = options.leadMs ?? 0;
  const t = now.getTime();
  return schedule.filter((g) => {
    const kickoff = Date.parse(g.kickoff);
    return t >= kickoff - lead && t < kickoff + duration;
  });
}

/** True while any game is in its window: drives live-score polling. */
export function isInGameWindow(
  now: Date,
  schedule: readonly ScheduledGame[],
  options: GameWindowOptions = {}
): boolean {
  return liveGames(now, schedule, options).length > 0;
}

/**
 * When a player on `playerTeam` locks in `week`: his game's kickoff. Null when the team is on bye,
 * has no game that week, or the player is a free agent.
 */
export function lockTimeFor(
  playerTeam: string | null | undefined,
  week: number,
  schedule: readonly ScheduledGame[],
  seasonType: 'regular' | 'post' = 'regular'
): Date | null {
  if (!playerTeam) return null;
  const game = schedule.find(
    (g) =>
      g.week === week &&
      g.seasonType === seasonType &&
      (g.homeTeam === playerTeam || g.awayTeam === playerTeam)
  );
  return game ? new Date(game.kickoff) : null;
}

/** The next kickoff strictly after `now`, or null when the schedule is exhausted. */
export function nextKickoff(now: Date, schedule: readonly ScheduledGame[]): ScheduledGame | null {
  const t = now.getTime();
  let best: ScheduledGame | null = null;
  for (const g of schedule) {
    const k = Date.parse(g.kickoff);
    if (k > t && (best === null || k < Date.parse(best.kickoff))) best = g;
  }
  return best;
}

export interface WeekBounds {
  seasonType: 'regular' | 'post';
  week: number;
  firstKickoff: number;
  lastKickoff: number;
}

export function weekBounds(schedule: readonly ScheduledGame[]): WeekBounds[] {
  const map = new Map<string, WeekBounds>();
  for (const g of schedule) {
    const key = `${g.seasonType}:${g.week}`;
    const k = Date.parse(g.kickoff);
    const b = map.get(key);
    if (!b) map.set(key, { seasonType: g.seasonType, week: g.week, firstKickoff: k, lastKickoff: k });
    else {
      b.firstKickoff = Math.min(b.firstKickoff, k);
      b.lastKickoff = Math.max(b.lastKickoff, k);
    }
  }
  return [...map.values()].sort((a, b) => a.firstKickoff - b.firstKickoff);
}

export interface DeriveStateOptions {
  rolloverDelayMs?: number;
  /** How long before week 1's first kickoff the state reads `regular` week 1. Default 7 days. */
  preseasonLeadMs?: number;
}

/**
 * Derives the NFL state Sleeper would report at `asOf` from one season's schedule. Week W is
 * current from the previous week's rollover until its own (last kickoff + rollover delay). Used by
 * historical providers, where there is no live `/state/nfl` to ask.
 */
export function deriveNflState(
  season: number,
  schedule: readonly ScheduledGame[],
  asOf: Date,
  options: DeriveStateOptions = {}
): NflState {
  const delay = options.rolloverDelayMs ?? DEFAULT_ROLLOVER_DELAY_MS;
  const lead = options.preseasonLeadMs ?? 7 * 24 * HOUR;
  const t = asOf.getTime();
  const bounds = weekBounds(schedule.filter((g) => g.season === season));
  const first = bounds[0];
  const base = { season, leagueSeason: season, previousSeason: season - 1 };
  const seasonStartDate = first ? new Date(first.firstKickoff).toISOString().slice(0, 10) : null;
  if (!first || t < first.firstKickoff - lead) {
    return { ...base, seasonType: 'pre', week: 0, displayWeek: 0, seasonStartDate };
  }
  for (const b of bounds) {
    if (t < b.lastKickoff + delay) {
      const seasonType: SeasonType = b.seasonType === 'regular' ? 'regular' : 'post';
      return { ...base, seasonType, week: b.week, displayWeek: b.week, seasonStartDate };
    }
  }
  const last = bounds[bounds.length - 1] as WeekBounds;
  return { ...base, seasonType: 'off', week: last.week, displayWeek: last.week, seasonStartDate };
}
