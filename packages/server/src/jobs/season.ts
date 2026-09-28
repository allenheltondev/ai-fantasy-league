import { weekEndsAt, type Clock } from '@fantasy/core';
import { IdCrosswalk, isInGameWindow, type ScheduledGame } from '@fantasy/data';
import type { StoredStatLine } from '../repos/reference.js';
import type { League } from '../repos/types.js';
import { advanceLeague } from '../season/cycle.js';
import { finalizeOfficialWeek } from '../season/official.js';
import { listInSeason, weekGames } from '../season/lineups.js';
import { scoreLine, updateMatchupScores } from '../season/scoring.js';
import type { JobDeps, JobResult } from './deps.js';
import { skipped } from './deps.js';
import { inUniverse, sameLine, universeIds } from './ingest-stats.js';
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

/**
 * When a week's stats are official: nflverse and Sleeper have applied the league's stat
 * corrections (finalized Monday to Wednesday) two days after the week's last game ends.
 */
export const OFFICIAL_AFTER_MS = 48 * 3_600_000;
/** A completed league is still checked for its last week's official final this long after it completed. */
export const COMPLETE_LOOKBACK_MS = 21 * 24 * 3_600_000;

type OfficialJobDeps = SeasonJobDeps & Pick<JobDeps, 'provider' | 'directory' | 'badgeChest'>;

/**
 * Re-pulls a week's stats with the stat corrections applied (`getOfficialWeekStats`: Sleeper
 * reconciled with nflverse; a provider without it serves `getWeekStats`) and stores the lines that
 * changed. Stats are shared by every league, so this runs once per season and week.
 */
async function refreshOfficialStats(deps: OfficialJobDeps, season: number, week: number, now: Date) {
  const [sources, stored, ids] = await Promise.all([
    deps.reference.playerSync.listSources(),
    deps.reference.stats.getWeek(season, week),
    universeIds(deps.directory)
  ]);
  const crosswalk = new IdCrosswalk(
    sources.flatMap((p) =>
      p.gsisId ? [{ sleeperId: p.id, gsisId: p.gsisId, method: 'sleeper' as const }] : []
    )
  );
  const lines = deps.provider.getOfficialWeekStats
    ? await deps.provider.getOfficialWeekStats(season, week, now, crosswalk)
    : await deps.provider.getWeekStats(season, week, now);
  const previous = new Map(stored.map((l) => [l.playerId, l]));
  const updatedAt = now.toISOString();
  const changed: StoredStatLine[] = inUniverse(lines, ids)
    .filter((line) => !sameLine(previous.get(line.playerId), line))
    .map((line) => ({ ...line, updatedAt }));
  await deps.reference.stats.putLines(changed);
  return changed.length;
}

/**
 * The Thursday official final (#80; Thursday and Friday, the second run a cheap retry). For every
 * league whose last finished week is past the stat-correction window and not yet official, it
 * re-pulls the week's stats once (`refreshOfficialStats`) and finalizes each league's week
 * (`finalizeOfficialWeek`): corrected scores, `Stat Correction Applied`, standings and bracket
 * updates, `Week Official Final`, and the week's achievements. Idempotent per league and week.
 */
export async function officialFinal(deps: OfficialJobDeps, clock: Clock): Promise<JobResult> {
  const now = clock.now();
  const [inSeason, complete] = await Promise.all([
    listInSeason(deps.repos),
    deps.repos.leagues.listByPhase('complete')
  ]);
  const targets: { league: League; week: number }[] = [
    ...inSeason.flatMap((league) =>
      league.week !== null && league.week - 1 >= league.settings.schedule.startWeek
        ? [{ league, week: league.week - 1 }]
        : []
    ),
    ...complete.flatMap((league) =>
      league.week !== null && now.getTime() - Date.parse(league.updatedAt) <= COMPLETE_LOOKBACK_MS
        ? [{ league, week: league.week }]
        : []
    )
  ];
  if (targets.length === 0) return skipped('no_weeks_to_finalize');
  const games = gamesCache(deps);
  const due: typeof targets = [];
  for (const target of targets) {
    const endsAt = weekEndsAt(await games(target.league.season, target.week), STATS_GAME_DURATION_MS);
    if (endsAt === null || now.getTime() < Date.parse(endsAt) + OFFICIAL_AFTER_MS) continue;
    const official = await deps.repos.history.getOfficialWeek(target.league.id, target.week);
    if (official?.status !== 'complete') due.push(target);
  }
  if (due.length === 0) return skipped('nothing_due', { leagues: targets.length });

  let statsChanged = 0;
  for (const key of new Set(due.map((t) => `${t.league.season}:${t.week}`))) {
    const [season, week] = key.split(':').map(Number) as [number, number];
    statsChanged += await refreshOfficialStats(deps, season, week, now);
  }
  const outcomes: Record<string, number> = {};
  let corrections = 0;
  let failed = 0;
  for (const { league, week } of due) {
    try {
      const outcome = await finalizeOfficialWeek(deps, league, week, now);
      outcomes[outcome.status] = (outcomes[outcome.status] ?? 0) + 1;
      if (outcome.status === 'official') corrections += outcome.corrections;
    } catch (error) {
      failed++;
      deps.log.error('could not make the week official', { leagueId: league.id, week, error });
    }
  }
  return { status: 'ok', leagues: due.length, statsChanged, corrections, ...outcomes, failed };
}
