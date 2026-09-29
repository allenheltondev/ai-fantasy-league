import { openGameDay, weekEndsAt, type Clock } from '@fantasy/core';
import { matchInjuryReports, type InjuryStatus } from '@fantasy/data';
import { inSeasonRosters, rosteredPlayerIds } from '../players/roster-index.js';
import type { SyncedPlayer } from '../repos/reference.js';
import { weekGames } from '../season/lineups.js';
import { STATS_GAME_DURATION_MS } from '../season/window.js';
import { mapLimit, skipped, type JobDeps, type JobResult } from './deps.js';
import { statusChangedDetail } from './sync-players.js';

/**
 * The once-a-day run outside game days, so designations for a Thursday or Monday game land the
 * morning before: the 15:00 UTC run (11am Eastern in the season's daylight time). The job runs
 * every 15 minutes, so exactly one run falls in this quarter hour.
 */
export const GAMEDAY_MORNING_UTC = { hour: 15, minutes: 15 } as const;

function isMorningRun(now: Date): boolean {
  return now.getUTCHours() === GAMEDAY_MORNING_UTC.hour && now.getUTCMinutes() < GAMEDAY_MORNING_UTC.minutes;
}

/**
 * Game-day injury updates (#200, every 15 minutes, but only does work on a game day). Final
 * designations and inactives come out on game day, about 90 minutes before each kickoff, long
 * after the twice-daily Sleeper sync; this reads ESPN's league-wide injury report instead, from 3
 * hours before the day's first kickoff until its last kickoff (core `openGameDay`), plus one
 * morning run on other days. Outside those it returns after two reads (`outside_window`).
 *
 * Scope: only players rostered in some in-season league (the roster index) whose NFL team plays
 * that day (on the morning run: still has a game this week). Each is matched to ESPN's report by
 * the ESPN id Sleeper carries, else by name, team, and position (`matchInjuryReports`). A player
 * absent from the report is left alone: only an explicit status changes one.
 *
 * Output: a changed injury status is written to the player record, marked as a game-day status
 * held until the week ends (so the next Sleeper sync cannot revert it, `syncPlayers`), and
 * published as the same `Player Status Changed` the Sleeper sync emits, with
 * `source: 'espn_gameday'`: agents, views, and the matchup all read the stored status.
 */
export async function syncGameDayInjuries(
  deps: Pick<JobDeps, 'provider' | 'reference' | 'repos' | 'events' | 'directory' | 'log'>,
  clock: Clock
): Promise<JobResult> {
  const now = clock.now();
  const read = deps.provider.getInjuries?.bind(deps.provider);
  if (read === undefined) return skipped('no_injury_source');
  const state = await deps.reference.nflState.get();
  if (state === null) return skipped('no_nfl_state');
  if (state.seasonType !== 'regular') return skipped('not_regular_season', { seasonType: state.seasonType });
  const at = { season: state.season, week: state.week };
  const games = await weekGames(deps.reference, state.season, state.week);
  if (games.length === 0) return skipped('no_schedule', at);
  const day = openGameDay(games, now);
  if (day === null && !isMorningRun(now)) return skipped('outside_window', at);
  const teams = new Set(
    day?.teams ??
      games.filter((g) => Date.parse(g.kickoff) > now.getTime()).flatMap((g) => [g.homeTeam, g.awayTeam])
  );
  if (teams.size === 0) return skipped('no_games_ahead', at);

  const rostered = rosteredPlayerIds(await inSeasonRosters(deps.repos));
  const records = (await deps.reference.playerSync.getMany([...rostered])).filter(
    ({ player }) => player.team !== null && teams.has(player.team)
  );
  if (records.length === 0) return skipped('nobody_rostered', { ...at, teams: teams.size });

  const reports = await read(now);
  const matches = matchInjuryReports(
    reports,
    records.map(({ player, source }) => ({ ...player, espnId: source.espnId }))
  );
  const heldUntil = weekEndsAt(games, STATS_GAME_DURATION_MS) as string;
  const asOf = now.toISOString();
  const changed: { record: SyncedPlayer; from: string | null; to: InjuryStatus | null }[] = [];
  for (const { player, source } of records) {
    const report = matches.byPlayer.get(player.id);
    if (report === undefined || report.injuryStatus === player.injuryStatus) continue;
    const { injuryStatusRaw: _raw, ...rest } = source;
    changed.push({
      from: player.injuryStatus,
      to: report.injuryStatus,
      record: {
        source: { ...rest, injuryStatus: report.injuryStatus },
        player: {
          ...player,
          injuryStatus: report.injuryStatus,
          updatedAt: asOf,
          statusSource: 'espn_gameday',
          statusAsOf: asOf,
          statusHeldUntil: heldUntil
        }
      }
    });
  }
  await deps.reference.playerSync.upsert(changed.map((c) => c.record));
  if (changed.length > 0) deps.directory.invalidate();
  await mapLimit(changed, 10, ({ record, from, to }) =>
    deps.events.publish(
      'Player Status Changed',
      statusChangedDetail(
        record.player,
        [{ playerId: record.player.id, field: 'injuryStatus', from, to }],
        asOf,
        'espn_gameday'
      )
    )
  );
  const result: JobResult = {
    status: 'ok',
    ...at,
    window: day === null ? 'morning' : 'game_day',
    teams: teams.size,
    inScope: records.length,
    reported: reports.length,
    matchedById: matches.byId,
    matchedByName: matches.byName,
    statusChanges: changed.length
  };
  deps.log.info('game-day injuries synced', result);
  return result;
}
