import { describe, expect, it } from 'vitest';
import { fixtureText } from '../../test/helpers.js';
import { SchemaDriftError } from '../errors.js';
import { SLEEPER_TEAMS } from '../teams.js';
import { computeByeWeeks, easternToUtc, parseNflverseSchedule } from './schedule.js';

const schedule = parseNflverseSchedule(fixtureText('nflverse/games_2025.csv'), 2025);

describe('easternToUtc', () => {
  it('applies EDT in the fall and EST in the winter', () => {
    expect(easternToUtc('2025-09-04', '20:20').toISOString()).toBe('2025-09-05T00:20:00.000Z');
    expect(easternToUtc('2026-02-08', '18:30').toISOString()).toBe('2026-02-08T23:30:00.000Z');
  });

  it('handles the DST switch weekends', () => {
    // Clocks fall back 2025-11-02 at 2:00 EDT; 13:00 that day is EST.
    expect(easternToUtc('2025-11-02', '13:00').toISOString()).toBe('2025-11-02T18:00:00.000Z');
    expect(easternToUtc('2025-11-01', '13:00').toISOString()).toBe('2025-11-01T17:00:00.000Z');
    // Spring forward 2026-03-08: 12:00 is EDT.
    expect(easternToUtc('2026-03-08', '12:00:30').toISOString()).toBe('2026-03-08T16:00:30.000Z');
  });

  it('rejects malformed input', () => {
    expect(() => easternToUtc('9/4/2025', '20:20')).toThrow(RangeError);
    expect(() => easternToUtc('2025-09-04', '8pm')).toThrow(RangeError);
  });
});

describe('parseNflverseSchedule (2025 fixture)', () => {
  it('parses the full 2025 season with UTC kickoffs and Sleeper team codes', () => {
    expect(schedule).toHaveLength(285);
    expect(schedule.filter((g) => g.seasonType === 'regular')).toHaveLength(272);
    expect(schedule[0]).toEqual({
      gameId: '2025_01_DAL_PHI',
      season: 2025,
      seasonType: 'regular',
      week: 1,
      kickoff: '2025-09-05T00:20:00.000Z',
      homeTeam: 'PHI',
      awayTeam: 'DAL',
      status: 'final',
      homeScore: 24,
      awayScore: 20
    });
    // nflverse writes the Rams as LA
    expect(schedule.find((g) => g.gameId === '2025_01_HOU_LA')?.homeTeam).toBe('LAR');
    const superBowl = schedule[schedule.length - 1];
    expect(superBowl).toMatchObject({ week: 22, seasonType: 'post', kickoff: '2026-02-08T23:30:00.000Z' });
  });

  it('sorts by kickoff', () => {
    const kicks = schedule.map((g) => g.kickoff);
    expect([...kicks].sort()).toEqual(kicks);
  });

  it('marks games without scores as scheduled and can return every season', () => {
    const csv = [
      'game_id,season,game_type,week,gameday,gametime,away_team,away_score,home_team,home_score',
      '2026_01_A_B,2026,REG,1,2026-09-10,20:20,KC,NA,LA,NA',
      '2025_01_C_D,2025,REG,1,2025-09-07,13:00,SD,17,OAK,20'
    ].join('\n');
    const all = parseNflverseSchedule(csv);
    expect(all.map((g) => g.gameId)).toEqual(['2025_01_C_D', '2026_01_A_B']);
    expect(all[1]).toMatchObject({ status: 'scheduled', homeTeam: 'LAR', awayTeam: 'KC' });
    expect(all[1]?.homeScore).toBeUndefined();
    expect(all[0]).toMatchObject({ homeTeam: 'LV', awayTeam: 'LAC' });
  });

  it('raises SchemaDriftError on missing columns or unusable rows', () => {
    expect(() => parseNflverseSchedule('game_id,season\n1,2025')).toThrow(SchemaDriftError);
    const bad =
      'game_id,season,game_type,week,gameday,gametime,away_team,away_score,home_team,home_score\nX,2025,REG,1,,,KC,,LA,';
    expect(() => parseNflverseSchedule(bad)).toThrow(/missing season, week, date, time, or teams/);
  });
});

describe('computeByeWeeks', () => {
  const byes = computeByeWeeks(schedule);

  it('gives all 32 teams exactly one bye', () => {
    expect(Object.keys(byes).sort()).toEqual([...SLEEPER_TEAMS].sort());
    for (const [team, week] of Object.entries(byes)) {
      const played = schedule.filter(
        (g) => g.seasonType === 'regular' && g.week === week && (g.homeTeam === team || g.awayTeam === team)
      );
      expect(played, team).toHaveLength(0);
    }
  });

  it('matches the published 2025 week 5 byes', () => {
    const week5 = Object.entries(byes)
      .filter(([, w]) => w === 5)
      .map(([t]) => t)
      .sort();
    expect(week5).toEqual(['ATL', 'CHI', 'GB', 'PIT']);
  });

  it('ignores postseason games', () => {
    expect(computeByeWeeks(schedule.filter((g) => g.seasonType === 'post'))).toEqual({});
  });
});
