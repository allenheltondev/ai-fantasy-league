import type { Clock } from '@fantasy/core';
import { isInGameWindow, type ScheduledGame } from '@fantasy/data';
import { advanceLeague } from '../season/cycle.js';
import { listInSeason, weekGames } from '../season/lineups.js';
import { scoreLine, updateMatchupScores } from '../season/scoring.js';
import type { JobDeps, JobResult } from './deps.js';
import { skipped } from './deps.js';
import { STATS_GAME_DURATION_MS } from '../season/window.js';

type SeasonJobDeps = Pick<JobDeps, 'repos' | 'reference' | 'events' | 'log'>;

/** One read of a week's games per season and week, shared by every league in the run. */
function gamesCache(deps: SeasonJobDeps) {
  const cache = new Map<string, Promise<ScheduledGame[]>>();
  return (season: number, week: number) => {
    const key = `${season}:${week}`;
    let games = cache.get(key);
    if (games === undefined) {
      games = weekGames(deps.reference, season, week);
      cache.set(key, games);
    }
    return games;
  };
}

/**
 * Live scoring (every 2 minutes, working only inside a game window, like `ingestStats`). For each
 * in-season league whose current week has a game in progress it recomputes the week's matchups
 * from the stored stat lines and, when a score changed, emits `Scores Updated` with the league's
 * score lines. The realtime push to browsers subscribes to that event.
 */
export async function scoreLiveWeek(deps: SeasonJobDeps, clock: Clock): Promise<JobResult> {
  const now = clock.now();
  const leagues = await listInSeason(deps.repos);
  if (leagues.length === 0) return skipped('no_leagues_in_season');
  const games = gamesCache(deps);
  let live = 0;
  let updated = 0;
  for (const league of leagues) {
    if (league.week === null) continue;
    const week = league.week;
    if (!isInGameWindow(now, await games(league.season, week), { gameDurationMs: STATS_GAME_DURATION_MS })) {
      continue;
    }
    live++;
    const scored = await updateMatchupScores(deps, league, week, 'in_progress', now);
    if (scored.changed.length === 0) continue;
    updated++;
    await deps.events.publish('Scores Updated', {
      leagueId: league.id,
      season: league.season,
      week,
      matchups: scored.matchups.map(scoreLine),
      updatedAt: now.toISOString()
    });
  }
  if (live === 0) return skipped('outside_game_window', { leagues: leagues.length });
  return { status: 'ok', leagues: leagues.length, live, updated };
}

/**
 * The weekly cycle (every 15 minutes). Advances every in-season league whose week is over: final
 * scores, `Week Provisionally Final`, and the rollover (`advanceLeague`). One league failing is
 * logged and does not stop the others; the next run retries it.
 */
export async function advanceSeason(deps: SeasonJobDeps, clock: Clock): Promise<JobResult> {
  const now = clock.now();
  const leagues = await listInSeason(deps.repos);
  if (leagues.length === 0) return skipped('no_leagues_in_season');
  const outcomes: Record<string, number> = {};
  let failed = 0;
  for (const league of leagues) {
    try {
      const outcome = await advanceLeague(deps, league, now);
      outcomes[outcome.status] = (outcomes[outcome.status] ?? 0) + 1;
    } catch (error) {
      failed++;
      deps.log.error('could not advance league', { leagueId: league.id, error });
    }
  }
  return { status: 'ok', leagues: leagues.length, ...outcomes, failed };
}
