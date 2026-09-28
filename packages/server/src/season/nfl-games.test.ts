import type { ScheduledGame } from '@fantasy/data';
import { describe, expect, it } from 'vitest';
import { liveGame, redZoneGame } from '../../test/support/season.js';
import type { StoredNflWeek } from '../repos/reference.js';
import {
  awaitingFinals,
  FINALS_GRACE_MS,
  gamesChanged,
  NFL_GAMES_FRESH_MS,
  nflWeekView,
  redZoneTeams
} from './nfl-games.js';
import { STATS_GAME_DURATION_MS } from './window.js';

const KICKOFF = '2026-09-13T17:00:00.000Z';
const LATE = '2026-09-13T20:25:00.000Z';
const scheduled = (gameId: string, kickoff: string, extra: Partial<ScheduledGame> = {}): ScheduledGame => {
  const [, , awayTeam = '', homeTeam = ''] = gameId.split('_');
  return {
    gameId,
    season: 2026,
    seasonType: 'regular',
    week: 1,
    kickoff,
    homeTeam,
    awayTeam,
    status: 'scheduled',
    ...extra
  };
};
const SCHEDULE = [
  scheduled('2026_01_BAL_KC', '2026-09-11T00:20:00.000Z', { status: 'final', homeScore: 24, awayScore: 20 }),
  scheduled('2026_01_DAL_PHI', KICKOFF),
  scheduled('2026_01_GB_MIN', LATE)
];
const stored = (games: StoredNflWeek['games'], updatedAt = '2026-09-13T18:00:00.000Z'): StoredNflWeek => ({
  season: 2026,
  week: 1,
  games,
  updatedAt
});
const at = (iso: string, plusMs = 0) => new Date(Date.parse(iso) + plusMs);

describe('nflWeekView', () => {
  it('shows the schedule before any read, finals with their scores', () => {
    const view = nflWeekView(2026, 1, SCHEDULE, null, at(KICKOFF));
    expect(view.updatedAt).toBeNull();
    expect(view.redZone).toEqual([]);
    expect(view.games.map((g) => [g.gameId, g.state, g.status, g.homeScore])).toEqual([
      ['2026_01_BAL_KC', 'post', 'Final', 24],
      ['2026_01_DAL_PHI', 'pre', null, null],
      ['2026_01_GB_MIN', 'pre', null, null]
    ]);
  });

  it('overlays a fresh read, keeping our kickoff, and lists games only ESPN knows', () => {
    const week = stored([
      redZoneGame('2026_01_DAL_PHI'),
      liveGame('2026_01_LAR_SF', { gameKey: null, state: 'pre', homeScore: null, awayScore: null })
    ]);
    const view = nflWeekView(2026, 1, SCHEDULE, week, at(week.updatedAt, NFL_GAMES_FRESH_MS));
    expect(view.games[1]).toMatchObject({
      gameId: '2026_01_DAL_PHI',
      kickoff: KICKOFF,
      possessionTeam: 'PHI',
      isRedZone: true,
      downDistance: '2nd & 4 at DAL 7',
      yardsToGoal: 7,
      clock: '8:32'
    });
    expect(view.games.at(-1)).toMatchObject({ gameId: null, homeTeam: 'SF', state: 'pre' });
    expect(view.redZone).toEqual([{ team: 'PHI', downDistance: '2nd & 4 at DAL 7', fieldPosition: 'DAL 7' }]);
    expect(view.updatedAt).toBe(week.updatedAt);
  });

  it('drops possession and the red zone from a stale read, keeping the score', () => {
    const week = stored([redZoneGame('2026_01_DAL_PHI', { homeScore: 14 })]);
    const view = nflWeekView(2026, 1, SCHEDULE, week, at(week.updatedAt, NFL_GAMES_FRESH_MS + 1));
    expect(view.games[1]).toMatchObject({
      state: 'in',
      homeScore: 14,
      possessionTeam: null,
      isRedZone: false,
      downDistance: null,
      clock: null
    });
    expect(view.redZone).toEqual([]);
  });

  it('lists only red-zone games with a known possession', () => {
    const view = nflWeekView(2026, 1, SCHEDULE, null, at(KICKOFF));
    expect(redZoneTeams([{ ...view.games[1]!, isRedZone: true }])).toEqual([]);
  });
});

describe('gamesChanged', () => {
  const base = [liveGame('2026_01_DAL_PHI'), liveGame('2026_01_GB_MIN', { gameKey: null })];

  it('ignores the clock and the read time', () => {
    const later = base.map((g) => ({ ...g, clock: '7:01', status: '7:01 - 2nd', updatedAt: 'later' }));
    expect(gamesChanged(base, later)).toBe(false);
  });

  it('sees a score, possession, situation, state, or game list change', () => {
    const edit = (patch: Partial<(typeof base)[number]>) => [{ ...base[0]!, ...patch }, base[1]!];
    expect(gamesChanged(base, edit({ homeScore: 14 }))).toBe(true);
    expect(gamesChanged(base, edit({ possessionTeam: 'PHI' }))).toBe(true);
    expect(gamesChanged(base, edit({ downDistance: '3rd & 2 at DAL 5' }))).toBe(true);
    expect(gamesChanged(base, edit({ isRedZone: true }))).toBe(true);
    expect(gamesChanged(base, edit({ state: 'post' }))).toBe(true);
    expect(gamesChanged(base, edit({ period: 3 }))).toBe(true);
    expect(gamesChanged(base, base.slice(1))).toBe(true);
  });
});

describe('awaitingFinals', () => {
  const lastWindowEnds = Date.parse(LATE) + STATS_GAME_DURATION_MS;
  const after = (ms: number) => new Date(lastWindowEnds + ms);
  const unfinished = stored([
    liveGame('2026_01_DAL_PHI', { state: 'post' }),
    liveGame('2026_01_GB_MIN', { state: 'in' })
  ]);

  it('reads until every started game is final, within the grace period', () => {
    expect(awaitingFinals(unfinished, SCHEDULE, after(60_000))).toBe(true);
    expect(awaitingFinals(unfinished, SCHEDULE, after(FINALS_GRACE_MS))).toBe(false);
    const done = stored(unfinished.games.map((g) => ({ ...g, state: 'post' as const })));
    expect(awaitingFinals(done, SCHEDULE, after(60_000))).toBe(false);
  });

  it('never reads before a first read, before kickoff, or for games not yet started', () => {
    expect(awaitingFinals(null, SCHEDULE, after(60_000))).toBe(false);
    expect(awaitingFinals(unfinished, SCHEDULE, new Date('2026-09-01T00:00:00.000Z'))).toBe(false);
    // Only the late game is unfinished, and at 2pm it has not kicked off.
    const early = stored([liveGame('2026_01_GB_MIN', { state: 'pre' })]);
    expect(awaitingFinals(early, SCHEDULE, at(KICKOFF, 3_600_000))).toBe(false);
    const unmatched = stored([liveGame('2026_01_GB_MIN', { gameKey: null })]);
    expect(awaitingFinals(unmatched, SCHEDULE, after(60_000))).toBe(false);
  });
});
