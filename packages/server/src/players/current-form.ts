import { seasonPoints, type ScoringSettings, type WeekPoints } from '@fantasy/core';
import type { Ctx } from '../context.js';
import type { Player } from './model.js';
import { cardTotals } from './research.js';

/**
 * A player's current form for the player card: this season's production so far (week by week,
 * totals, points per game) and his projection for the upcoming week with its matchup. Scored under
 * the caller's scoring, from the stored stat lines (`STATS#…`), projection snapshots, and the NFL
 * schedule, so it is always as current as the ingestion jobs.
 */

/** Regular-season weeks only: the postseason is not part of a fantasy season's stats. */
const LAST_REGULAR_WEEK = 18;

export interface ThisSeason {
  season: number;
  points: number;
  ppg: number;
  games: number;
  weekly: WeekPoints[];
  totals: Record<string, number>;
}

export interface NextWeek {
  season: number;
  week: number;
  /** Projected points under the caller's scoring, or null when no projection is published yet. */
  points: number | null;
  /** Projected stat totals for his position; empty when unprojected. */
  totals: Record<string, number>;
  /** True when his NFL team has no game that week. */
  bye: boolean;
  opponent: { team: string; home: boolean } | null;
  kickoff: string | null;
}

export interface CurrentForm {
  thisSeason: ThisSeason | null;
  nextWeek: NextWeek | null;
}

/**
 * The season and week the card calls current: during the regular season, the NFL's current week
 * (the one being played, or about to be); in the preseason, week 1 of the coming season. Null in
 * the offseason, and when the NFL state has not been synced.
 */
export function currentWeek(
  state: { season: number; seasonType: string; week: number; leagueSeason: number } | null
): {
  season: number;
  week: number;
} | null {
  if (state === null) return null;
  if (state.seasonType === 'regular')
    return { season: state.season, week: Math.min(Math.max(state.week, 1), LAST_REGULAR_WEEK) };
  if (state.seasonType === 'pre') return { season: Math.max(state.season, state.leagueSeason), week: 1 };
  return null;
}

export async function loadCurrentForm(
  ctx: Pick<Ctx, 'data' | 'clock'>,
  scoring: ScoringSettings,
  player: Player
): Promise<CurrentForm> {
  const reference = ctx.data.reference;
  const state = await reference.nflState.get();
  const current = currentWeek(state);
  if (current === null) return { thisSeason: null, nextWeek: null };
  const { season, week } = current;

  const [history, research, snapshot, games] = await Promise.all([
    reference.stats.getPlayerHistory(player.id, season),
    reference.seasons.get('stats', season, [player.id]),
    reference.projections.latestSnapshot(season, week, ctx.clock.now()),
    reference.schedule.getWeek(season, week)
  ]);

  // Completed weeks come from the research set (every week, even one the live job missed); the
  // live stat lines win where both have a week, since they are fresher during a game.
  const byWeek = new Map<number, Record<string, number>>();
  for (const w of research[0]?.weeks ?? []) byWeek.set(w.week, w.stats as Record<string, number>);
  for (const l of history) if (l.season === season) byWeek.set(l.week, l.stats as Record<string, number>);
  const played = [...byWeek]
    .filter(([week]) => week >= 1 && week <= LAST_REGULAR_WEEK)
    .sort(([a], [b]) => a - b)
    .map(([week, stats]) => ({ week, stats }));
  let thisSeason: ThisSeason | null = null;
  if (played.length > 0) {
    const scored = seasonPoints(scoring, played);
    thisSeason = {
      season,
      points: scored.points,
      ppg: scored.ppg,
      games: scored.games,
      weekly: scored.weekly,
      totals: cardTotals({ playerId: player.id, season, weeks: played }, player.position)
    };
  }

  const [line] = snapshot === null ? [] : await reference.projections.getLines(snapshot, [player.id]);
  const projected = line === undefined ? null : [{ week, stats: line.stats }];
  const game =
    player.team === null
      ? undefined
      : games.find((g) => g.homeTeam === player.team || g.awayTeam === player.team);
  const nextWeek: NextWeek = {
    season,
    week,
    points: projected === null ? null : seasonPoints(scoring, projected).points,
    totals:
      projected === null
        ? {}
        : cardTotals({ playerId: player.id, season, weeks: projected }, player.position),
    // No game this week means a bye, once the week's schedule is known.
    bye: games.length > 0 && game === undefined,
    opponent:
      game === undefined
        ? null
        : game.homeTeam === player.team
          ? { team: game.awayTeam, home: true }
          : { team: game.homeTeam, home: false },
    kickoff: game?.kickoff ?? null
  };
  return { thisSeason, nextWeek };
}
