import { SchemaDriftError } from '../errors.js';
import { toSleeperTeam } from '../teams.js';
import type { ByeWeeks, ScheduledGame } from '../types.js';
import { csvNumber, csvValue, parseCsvObjects } from './csv.js';

export const SCHEDULE_REQUIRED_COLUMNS = [
  'game_id',
  'season',
  'game_type',
  'week',
  'gameday',
  'gametime',
  'away_team',
  'away_score',
  'home_team',
  'home_score'
] as const;

const EASTERN = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});

/** Offset (ms) of America/New_York from UTC at the given instant. */
function easternOffsetMs(utcMs: number): number {
  const parts: Record<string, number> = {};
  for (const p of EASTERN.formatToParts(utcMs)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(
    parts.year ?? 0,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0
  );
  return asUtc - utcMs;
}

/**
 * Converts an Eastern wall-clock date and time (nflverse's `gameday` + `gametime`, which are ET even
 * for international games) to a UTC instant, honoring daylight saving time.
 */
export function easternToUtc(date: string, time: string): Date {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!d || !t) throw new RangeError(`Invalid Eastern date/time: ${date} ${time}`);
  const naive = Date.UTC(
    Number(d[1]),
    Number(d[2]) - 1,
    Number(d[3]),
    Number(t[1]),
    Number(t[2]),
    Number(t[3] ?? 0)
  );
  let utc = naive - easternOffsetMs(naive);
  const corrected = naive - easternOffsetMs(utc);
  if (corrected !== utc) utc = corrected;
  return new Date(utc);
}

/**
 * Parses nflverse `games.csv` (the `schedules` release asset). Returns regular and postseason
 * games, optionally for one season, sorted by kickoff then game id. Team codes are Sleeper's.
 */
export function parseNflverseSchedule(csv: string, season?: number): ScheduledGame[] {
  const rows = parseCsvObjects(csv, SCHEDULE_REQUIRED_COLUMNS, 'nflverse games.csv');
  const games: ScheduledGame[] = [];
  for (const row of rows) {
    const rowSeason = csvNumber(row, 'season');
    if (season !== undefined && rowSeason !== season) continue;
    const gameId = csvValue(row, 'game_id');
    const week = csvNumber(row, 'week');
    const gameType = csvValue(row, 'game_type');
    const gameday = csvValue(row, 'gameday');
    const gametime = csvValue(row, 'gametime');
    const home = toSleeperTeam(csvValue(row, 'home_team'));
    const away = toSleeperTeam(csvValue(row, 'away_team'));
    if (!gameId || rowSeason === undefined || week === undefined || !gameday || !gametime || !home || !away) {
      throw new SchemaDriftError('nflverse games.csv', [
        { path: gameId ?? '<unknown game>', message: 'row is missing season, week, date, time, or teams' }
      ]);
    }
    const game: ScheduledGame = {
      gameId,
      season: rowSeason,
      seasonType: gameType === 'REG' ? 'regular' : 'post',
      week,
      kickoff: easternToUtc(gameday, gametime).toISOString(),
      homeTeam: home,
      awayTeam: away,
      status: 'scheduled'
    };
    const homeScore = csvNumber(row, 'home_score');
    const awayScore = csvNumber(row, 'away_score');
    if (homeScore !== undefined && awayScore !== undefined) {
      game.status = 'final';
      game.homeScore = homeScore;
      game.awayScore = awayScore;
    }
    games.push(game);
  }
  return games.sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.gameId.localeCompare(b.gameId));
}

/** Each team's regular-season bye: the first week in the season's range it has no game. */
export function computeByeWeeks(schedule: readonly ScheduledGame[]): ByeWeeks {
  const regular = schedule.filter((g) => g.seasonType === 'regular');
  const played = new Map<string, Set<number>>();
  let maxWeek = 0;
  for (const g of regular) {
    maxWeek = Math.max(maxWeek, g.week);
    for (const team of [g.homeTeam, g.awayTeam]) {
      const weeks = played.get(team) ?? new Set<number>();
      weeks.add(g.week);
      played.set(team, weeks);
    }
  }
  const byes: ByeWeeks = {};
  for (const [team, weeks] of [...played.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    for (let w = 1; w <= maxWeek; w++) {
      if (!weeks.has(w)) {
        byes[team] = w;
        break;
      }
    }
  }
  return byes;
}
