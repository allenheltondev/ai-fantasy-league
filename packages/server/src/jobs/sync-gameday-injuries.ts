import { openGameDay, weekEndsAt, type Clock } from '@fantasy/core';
import { matchInjuryReports, type InjuryReport, type InjuryStatus } from '@fantasy/data';
import type { InjuryNote, Player } from '../players/model.js';
import { inSeasonRosters, rosteredPlayerIds } from '../players/roster-index.js';
import type { SyncedPlayer } from '../repos/reference.js';
import { weekGames } from '../season/lineups.js';
import { STATS_GAME_DURATION_MS } from '../season/window.js';
import { mapLimit, skipped, type JobDeps, type JobResult } from './deps.js';
import { isGameDayHeld, statusChangedDetail } from './sync-players.js';

/**
 * The once-a-day run outside game days, so designations for a Thursday or Monday game land the
 * morning before: the 15:00 UTC run (11am Eastern in the season's daylight time). The job runs
 * every 15 minutes, so exactly one run falls in this quarter hour.
 */
export const GAMEDAY_MORNING_UTC = { hour: 15, minutes: 15 } as const;

/**
 * A report with fewer entries than this is treated as partial (a bad read, or ESPN mid-update): it
 * still sets the statuses it lists, but clears none. A normal report lists a few hundred players.
 */
export const MIN_REPORT_FOR_CLEARING = 20;

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
 * absent from the report is left alone, unless his designation came from this job (still held):
 * then he is off the report and is cleared to active, but only on a full read (at least
 * `MIN_REPORT_FOR_CLEARING` entries). A status Sleeper set is never cleared by absence.
 *
 * Output: a changed injury status is written to the player record, marked as a game-day status
 * held until the week ends (so the next Sleeper sync cannot revert it, `syncPlayers`), and
 * published as the same `Player Status Changed` the Sleeper sync emits, with
 * `source: 'espn_gameday'`: agents, views, and the matchup all read the stored status. ESPN's
 * note on the injury ("Jefferson (hamstring) is doubtful for Sunday.") is stored with it
 * (`injuryNote`), and refreshed without an event when only the note changed.
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
  // Clearing trusts absence, so only a full read may clear (#200 review): a partial or empty
  // report must never mass-clear statuses.
  const canClear = reports.length >= MIN_REPORT_FOR_CLEARING;
  if (!canClear) {
    deps.log.warn('injury report too short to clear statuses', {
      reported: reports.length,
      minimum: MIN_REPORT_FOR_CLEARING
    });
  }
  const changed: { record: SyncedPlayer; from: string | null; to: InjuryStatus | null }[] = [];
  // Same designation, but ESPN's note on it is new or changed: stored without an event.
  const noted: SyncedPlayer[] = [];
  let cleared = 0;
  for (const { player, source } of records) {
    const report = matches.byPlayer.get(player.id);
    let to: InjuryStatus | null;
    if (report !== undefined) {
      to = report.injuryStatus;
    } else if (canClear && isGameDayHeld(player, now) && player.injuryStatus !== null) {
      // ESPN set his designation and no longer lists him: he is off the report. A status Sleeper
      // set is left to Sleeper, which stays authoritative for players ESPN does not list.
      to = null;
      cleared++;
    } else {
      continue;
    }
    const note = to === null ? undefined : injuryNote(report);
    if (to === player.injuryStatus) {
      if (!sameNote(player.injuryNote, note)) noted.push({ source, player: withInjuryNote(player, note) });
      continue;
    }
    const { injuryStatusRaw: _raw, ...rest } = source;
    changed.push({
      from: player.injuryStatus,
      to,
      record: {
        source: { ...rest, injuryStatus: to },
        player: {
          ...withInjuryNote(player, note),
          injuryStatus: to,
          updatedAt: asOf,
          statusSource: 'espn_gameday',
          statusAsOf: asOf,
          statusHeldUntil: heldUntil
        }
      }
    });
  }
  await deps.reference.playerSync.upsert([...changed.map((c) => c.record), ...noted]);
  if (changed.length > 0 || noted.length > 0) deps.directory.invalidate();
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
    statusChanges: changed.length,
    notesUpdated: noted.length,
    cleared,
    clearing: canClear
  };
  deps.log.info('game-day injuries synced', result);
  return result;
}

/** ESPN's note on a report entry, or undefined when it has none. */
function injuryNote(report: InjuryReport | undefined): InjuryNote | undefined {
  const text = report?.comment?.trim();
  return text ? { text, reportedAt: report?.reportedAt ?? null } : undefined;
}

function sameNote(a: InjuryNote | undefined, b: InjuryNote | undefined): boolean {
  return a?.text === b?.text && (a?.reportedAt ?? null) === (b?.reportedAt ?? null);
}

/** The profile with `note` as its injury note, or with none. */
export function withInjuryNote(player: Player, note: InjuryNote | undefined): Player {
  const { injuryNote: _old, ...rest } = player;
  return note === undefined ? rest : { ...rest, injuryNote: note };
}
