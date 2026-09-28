import { weekEndsAt, type Clock } from '@fantasy/core';
import { IdCrosswalk, isInGameWindow, type ScheduledGame } from '@fantasy/data';
import { resumeDraftStartup } from '../operations/draft/start-draft.js';
import { createServices } from '../services.js';
import type { StoredStatLine } from '../repos/reference.js';
import type { League, Matchup } from '../repos/types.js';
import { advanceLeague } from '../season/cycle.js';
import { finalizeOfficialWeek } from '../season/official.js';
import { listInSeason, weekGames } from '../season/lineups.js';
import { scoreLine, updateMatchupScores } from '../season/scoring.js';
import { matchupScoringLog, type ScoringLogEntry } from '../season/scoring-log.js';
import type { JobDeps, JobResult } from './deps.js';
import { settle, skipped } from './deps.js';
import { refreshNflGames, type NflWeekTarget } from './nfl-games.js';
import { inUniverse, sameLine, scoringEvents, universeIds } from './ingest-stats.js';
import { STATS_GAME_DURATION_MS } from '../season/window.js';

type SeasonJobDeps = Pick<JobDeps, 'repos' | 'reference' | 'events' | 'log'>;
type LiveJobDeps = SeasonJobDeps & Partial<Pick<JobDeps, 'provider'>>;

/** How far back the live push looks for scoring log entries; clients merge repeats by id. */
export const LIVE_LOG_WINDOW_MS = 5 * 60_000;
/** At most this many log entries per matchup ride on one push; the app reloads for more. */
export const LIVE_LOG_MAX_ENTRIES = 20;

/**
 * The players whose stat lines changed within `LIVE_LOG_WINDOW_MS`, one stats read per season and
 * week in the run: only their events are read for the push.
 */
function recentPlayersCache(deps: SeasonJobDeps, now: Date) {
  const since = new Date(now.getTime() - LIVE_LOG_WINDOW_MS).toISOString();
  const cache = new Map<string, Promise<Set<string>>>();
  return {
    since,
    players(season: number, week: number) {
      const key = `${season}:${week}`;
      let players = cache.get(key);
      if (players === undefined) {
        players = deps.reference.stats
          .getWeek(season, week)
          .then((lines) => new Set(lines.filter((l) => l.updatedAt >= since).map((l) => l.playerId)));
        cache.set(key, players);
      }
      return players;
    }
  };
}
type RecentPlayers = ReturnType<typeof recentPlayersCache>;

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
 * score lines. The realtime push to browsers subscribes to that event. One league failing is
 * logged and does not stop the others; once all are done the job fails (`settle`), so Lambda
 * retries it (rescoring is idempotent) and the failure is emailed. A league that stays broken
 * therefore sends one failure email per two-minute run during game windows.
 *
 * Each run first refreshes the week's NFL games from ESPN (`refreshNflGames`: scores, possession,
 * the red zone, and the scoring plays of games whose score moved), once per season and week, not
 * per league, so the scoring log entries pushed with the scores already carry the play
 * descriptions. That is best effort: it logs a warning on failure and never fails the job.
 */
export async function scoreLiveWeek(deps: LiveJobDeps, clock: Clock): Promise<JobResult> {
  const now = clock.now();
  const leagues = await listInSeason(deps.repos);
  if (leagues.length === 0) return skipped('no_leagues_in_season');
  const games = gamesCache(deps);
  const recent = recentPlayersCache(deps, now);
  const weeks = new Map<string, NflWeekTarget>();
  const scoring: { league: League; week: number }[] = [];
  let live = 0;
  let updated = 0;
  let failed = 0;
  for (const league of leagues) {
    if (league.week === null) continue;
    const week = league.week;
    try {
      const weekGames = await games(league.season, week);
      const inWindow = isInGameWindow(now, weekGames, { gameDurationMs: STATS_GAME_DURATION_MS });
      weeks.set(`${league.season}:${week}`, {
        season: league.season,
        week,
        games: weekGames,
        live: inWindow
      });
      if (inWindow) scoring.push({ league, week });
    } catch (error) {
      failed++;
      deps.log.error('could not score league', { leagueId: league.id, week, error });
    }
  }
  // The NFL games first: a scoring play read now is on the log entries pushed below (#164).
  const nflGames: Record<string, number> = {};
  for (const target of weeks.values()) {
    const outcome = await refreshNflGames(deps, target, now);
    nflGames[outcome] = (nflGames[outcome] ?? 0) + 1;
  }
  for (const { league, week } of scoring) {
    live++;
    try {
      if (await scoreLeague(deps, league, week, now, recent)) updated++;
    } catch (error) {
      failed++;
      deps.log.error('could not score league', { leagueId: league.id, week, error });
    }
  }
  if (live === 0) {
    return settle(
      deps.log,
      'scoreLiveWeek',
      skipped('outside_game_window', { leagues: leagues.length, nflGames, ...(failed > 0 ? { failed } : {}) })
    );
  }
  return settle(deps.log, 'scoreLiveWeek', {
    status: 'ok',
    leagues: leagues.length,
    live,
    updated,
    nflGames,
    failed
  });
}

/** Rescores one league's week; emits `Scores Updated` and returns true when a score changed. */
async function scoreLeague(
  deps: SeasonJobDeps,
  league: League,
  week: number,
  now: Date,
  recent: RecentPlayers
): Promise<boolean> {
  const scored = await updateMatchupScores(deps, league, week, 'in_progress', now);
  if (scored.changed.length === 0) return false;
  const scoringLog = await liveLogEntries(deps, league, week, scored.changed, now, recent);
  await deps.events.publish('Scores Updated', {
    leagueId: league.id,
    season: league.season,
    week,
    matchups: scored.matchups.map(scoreLine),
    ...(scoringLog.length > 0 ? { scoringLog } : {}),
    updatedAt: now.toISOString()
  });
  return true;
}

/**
 * The recent scoring log entries (#162) of the matchups whose score changed, for the realtime push.
 * Best effort: the log is an extra, so a failure here is logged and the push goes out without it
 * (the app still reloads the log on the event).
 */
async function liveLogEntries(
  deps: SeasonJobDeps,
  league: League,
  week: number,
  changed: readonly Matchup[],
  now: Date,
  recent: RecentPlayers
): Promise<{ matchupId: string; entries: ScoringLogEntry[] }[]> {
  try {
    const onlyPlayers = await recent.players(league.season, week);
    if (onlyPlayers.size === 0) return [];
    const teams = await deps.repos.teams.list(league.id);
    const logs = await Promise.all(
      changed.map(async (m) => ({
        matchupId: m.id,
        entries: (
          await matchupScoringLog(deps, league, teams, m, now, {
            includeBench: true,
            since: recent.since,
            onlyPlayers
          })
        ).slice(0, LIVE_LOG_MAX_ENTRIES)
      }))
    );
    return logs.filter((l) => l.entries.length > 0);
  } catch (error) {
    deps.log.warn('could not build the live scoring log', { leagueId: league.id, error });
    return [];
  }
}

/**
 * The weekly cycle (every 15 minutes). Advances every in-season league whose week is over: final
 * scores, `Week Provisionally Final`, and the rollover (`advanceLeague`). One league failing is
 * logged and does not stop the others; once all are done the job fails (`settle`), so Lambda
 * retries it (`advanceLeague` is safe to run repeatedly) and the failure is emailed.
 */
export async function advanceSeason(deps: SeasonJobDeps, clock: Clock): Promise<JobResult> {
  const now = clock.now();
  const [active, complete, drafting] = await Promise.all([
    listInSeason(deps.repos),
    deps.repos.leagues.listByPhase('complete'),
    deps.repos.leagues.listByPhase('drafting')
  ]);
  const leagues = [
    ...active,
    ...complete.filter((l) => l.pendingRollover),
    ...drafting.filter(
      (l) => l.draftStartup && !(Date.parse(l.draftStartup.leaseUntil ?? '') > now.getTime())
    )
  ];
  if (leagues.length === 0) return skipped('no_leagues_in_season');
  const outcomes: Record<string, number> = {};
  let failed = 0;
  for (const league of leagues) {
    try {
      if (league.draftStartup) {
        await resumeDraftStartup(createServices({ ...deps, clock }), league);
        outcomes.draft_recovered = (outcomes.draft_recovered ?? 0) + 1;
        continue;
      }
      const outcome = await advanceLeague(deps, league, now);
      outcomes[outcome.status] = (outcomes[outcome.status] ?? 0) + 1;
    } catch (error) {
      failed++;
      deps.log.error('could not advance league', { leagueId: league.id, error });
    }
  }
  return settle(deps.log, 'advanceSeason', { status: 'ok', leagues: leagues.length, ...outcomes, failed });
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
 * changed, each as a `correction` scoring log event. Stats are shared by every league, so this runs
 * once per season and week.
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
  // Corrections show in the matchup scoring log (#162) as "Stat correction" entries.
  await deps.reference.scoringLog.put(scoringEvents(previous, changed, 'correction'));
  await deps.reference.stats.putLines(changed);
  return changed.length;
}

/**
 * The Thursday official final (#80; Thursday and Friday, the second run a cheap retry). For every
 * in-season league (and every league completed in the last `COMPLETE_LOOKBACK_MS`), each played
 * week that is past the stat-correction window and not yet official is due: the last finished
 * week, and any earlier one that a failed or missed run left behind (#123). It re-pulls each due
 * week's stats once (`refreshOfficialStats`) and finalizes each league's weeks oldest first
 * (`finalizeOfficialWeek`): corrected scores, `Stat Correction Applied`, standings and bracket
 * updates, `Week Official Final`, and the week's achievements. Idempotent per league and week.
 * A league or week that fails is logged and does not stop the others; once all are done the job
 * fails (`settle`), so Lambda retries it and the failure is emailed.
 */
export async function officialFinal(deps: OfficialJobDeps, clock: Clock): Promise<JobResult> {
  const now = clock.now();
  const [inSeason, complete] = await Promise.all([
    listInSeason(deps.repos),
    deps.repos.leagues.listByPhase('complete')
  ]);
  const leagues = [
    // An in-season league's current week is still being played.
    ...inSeason.flatMap((league) => (league.week === null ? [] : [{ league, lastWeek: league.week - 1 }])),
    ...complete.flatMap((league) =>
      league.week !== null && now.getTime() - Date.parse(league.updatedAt) <= COMPLETE_LOOKBACK_MS
        ? [{ league, lastWeek: league.week }]
        : []
    )
  ].filter(({ league, lastWeek }) => lastWeek >= league.settings.schedule.startWeek);
  const targets: { league: League; week: number }[] = [];
  let failed = 0;
  for (const { league, lastWeek } of leagues) {
    try {
      targets.push(...(await playedWeeks(deps, league, lastWeek)).map((week) => ({ league, week })));
    } catch (error) {
      failed++;
      deps.log.error('could not list the weeks to make official', { leagueId: league.id, error });
    }
  }
  if (targets.length === 0) {
    return settle(deps.log, 'officialFinal', skipped('no_weeks_to_finalize', failed > 0 ? { failed } : {}));
  }
  const games = gamesCache(deps);
  const due: typeof targets = [];
  for (const target of targets) {
    const endsAt = weekEndsAt(await games(target.league.season, target.week), STATS_GAME_DURATION_MS);
    if (endsAt === null || now.getTime() < Date.parse(endsAt) + OFFICIAL_AFTER_MS) continue;
    const official = await deps.repos.history.getOfficialWeek(target.league.id, target.week);
    if (official?.status !== 'complete') due.push(target);
  }
  if (due.length === 0) {
    return settle(
      deps.log,
      'officialFinal',
      skipped('nothing_due', { leagues: leagues.length, weeks: targets.length, failed })
    );
  }

  let statsChanged = 0;
  for (const key of new Set(due.map((t) => `${t.league.season}:${t.week}`))) {
    const [season, week] = key.split(':').map(Number) as [number, number];
    statsChanged += await refreshOfficialStats(deps, season, week, now);
  }
  const outcomes: Record<string, number> = {};
  let corrections = 0;
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
  const leagueCount = new Set(due.map((t) => t.league.id)).size;
  return settle(deps.log, 'officialFinal', {
    status: 'ok',
    leagues: leagueCount,
    weeks: due.length,
    statsChanged,
    corrections,
    ...outcomes,
    failed
  });
}

/**
 * The weeks up to `lastWeek` whose matchups are all final, oldest first. A void week (before a
 * mid-season draft's first week) keeps its matchups `scheduled`, so it is never due.
 */
async function playedWeeks(deps: SeasonJobDeps, league: League, lastWeek: number): Promise<number[]> {
  const byWeek = new Map<number, Matchup[]>();
  for (const m of await deps.repos.schedule.listMatchups(league.id)) {
    if (m.week <= lastWeek) byWeek.set(m.week, [...(byWeek.get(m.week) ?? []), m]);
  }
  return [...byWeek]
    .filter(([, matchups]) => matchups.every((m) => m.status === 'final'))
    .map(([week]) => week)
    .sort((a, b) => a - b);
}
