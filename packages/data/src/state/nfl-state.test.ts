import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fixtureText } from '../../test/helpers.js';
import { parseNflverseSchedule } from '../nflverse/schedule.js';
import type { NflState, SeasonType } from '../types.js';
import {
  deriveNflState,
  detectWeekRollover,
  isInGameWindow,
  liveGames,
  lockTimeFor,
  nextKickoff,
  weekBounds
} from './nfl-state.js';

const schedule = parseNflverseSchedule(fixtureText('nflverse/games_2025.csv'), 2025);
const at = (iso: string): Date => new Date(iso);

function state(season: number, seasonType: SeasonType, week: number): NflState {
  return {
    season,
    seasonType,
    week,
    displayWeek: week,
    leagueSeason: season,
    previousSeason: season - 1,
    seasonStartDate: null
  };
}

describe('detectWeekRollover', () => {
  it('detects week, season-type, and season rollovers', () => {
    expect(detectWeekRollover(state(2025, 'regular', 4), state(2025, 'regular', 5))).toEqual({
      kind: 'week',
      from: { season: 2025, seasonType: 'regular', week: 4 },
      to: { season: 2025, seasonType: 'regular', week: 5 }
    });
    expect(detectWeekRollover(state(2025, 'regular', 18), state(2025, 'post', 19))?.kind).toBe('season_type');
    expect(detectWeekRollover(state(2025, 'off', 22), state(2026, 'pre', 0))?.kind).toBe('season');
  });

  it('ignores the first observation, no-ops, and backwards glitches', () => {
    expect(detectWeekRollover(null, state(2025, 'regular', 1))).toBeNull();
    expect(detectWeekRollover(undefined, state(2025, 'regular', 1))).toBeNull();
    expect(detectWeekRollover(state(2025, 'regular', 5), state(2025, 'regular', 5))).toBeNull();
    expect(detectWeekRollover(state(2025, 'regular', 5), state(2025, 'regular', 4))).toBeNull();
    expect(detectWeekRollover(state(2025, 'post', 19), state(2025, 'regular', 18))).toBeNull();
    expect(detectWeekRollover(state(2026, 'pre', 0), state(2025, 'off', 22))).toBeNull();
  });

  it('property: a rollover is reported iff the state moved forward', () => {
    const types: SeasonType[] = ['pre', 'regular', 'post', 'off'];
    const arb = fc.record({
      season: fc.integer({ min: 2024, max: 2026 }),
      seasonType: fc.constantFrom(...types),
      week: fc.integer({ min: 0, max: 22 })
    });
    fc.assert(
      fc.property(arb, arb, (a, b) => {
        const key = (s: typeof a): [number, number, number] => [
          s.season,
          types.indexOf(s.seasonType),
          s.week
        ];
        const [ka, kb] = [key(a), key(b)];
        const forward = kb[0] !== ka[0] ? kb[0] > ka[0] : kb[1] !== ka[1] ? kb[1] > ka[1] : kb[2] > ka[2];
        const r = detectWeekRollover(
          state(a.season, a.seasonType, a.week),
          state(b.season, b.seasonType, b.week)
        );
        expect(r !== null).toBe(forward);
      })
    );
  });
});

describe('game windows (2025 schedule)', () => {
  it('is live from kickoff for four hours', () => {
    // Week 1 TNF: DAL @ PHI kicked off 2025-09-05T00:20Z
    expect(isInGameWindow(at('2025-09-05T00:19:59Z'), schedule)).toBe(false);
    expect(isInGameWindow(at('2025-09-05T00:20:00Z'), schedule)).toBe(true);
    expect(isInGameWindow(at('2025-09-05T04:19:59Z'), schedule)).toBe(true);
    expect(isInGameWindow(at('2025-09-05T04:20:00Z'), schedule)).toBe(false);
    // A Wednesday
    expect(isInGameWindow(at('2025-09-10T18:00:00Z'), schedule)).toBe(false);
  });

  it('supports a pre-kickoff lead and custom duration', () => {
    const opts = { leadMs: 30 * 60_000, gameDurationMs: 60 * 60_000 };
    expect(isInGameWindow(at('2025-09-04T23:55:00Z'), schedule, opts)).toBe(true);
    expect(isInGameWindow(at('2025-09-05T01:25:00Z'), schedule, opts)).toBe(false);
  });

  it('lists every game live in the Sunday early window', () => {
    const live = liveGames(at('2025-09-07T18:00:00Z'), schedule);
    expect(live).toHaveLength(8);
    expect(live.every((g) => g.kickoff === '2025-09-07T17:00:00.000Z')).toBe(true);
  });

  it('nextKickoff finds the next game and returns null after the Super Bowl', () => {
    expect(nextKickoff(at('2025-09-05T00:20:00Z'), schedule)?.gameId).toBe('2025_01_KC_LAC');
    expect(nextKickoff(at('2026-03-01T00:00:00Z'), schedule)).toBeNull();
  });
});

describe('lockTimeFor', () => {
  it('locks at the team’s kickoff that week', () => {
    expect(lockTimeFor('PHI', 1, schedule)?.toISOString()).toBe('2025-09-05T00:20:00.000Z');
    expect(lockTimeFor('LAR', 1, schedule)?.toISOString()).toBe('2025-09-07T20:25:00.000Z');
    expect(lockTimeFor('SEA', 22, schedule, 'post')?.toISOString()).toBe('2026-02-08T23:30:00.000Z');
  });

  it('is null on a bye, for free agents, or with no game', () => {
    expect(lockTimeFor('GB', 5, schedule)).toBeNull();
    expect(lockTimeFor(null, 1, schedule)).toBeNull();
    expect(lockTimeFor('KC', 30, schedule)).toBeNull();
  });
});

describe('weekBounds / deriveNflState', () => {
  it('computes each week’s first and last kickoff', () => {
    const bounds = weekBounds(schedule);
    expect(bounds).toHaveLength(22);
    expect(bounds[0]).toEqual({
      seasonType: 'regular',
      week: 1,
      firstKickoff: Date.parse('2025-09-05T00:20:00Z'),
      lastKickoff: Date.parse('2025-09-09T00:15:00Z')
    });
  });

  it('derives the state Sleeper would report', () => {
    const s = (iso: string): Pick<NflState, 'seasonType' | 'week'> => {
      const d = deriveNflState(2025, schedule, at(iso));
      return { seasonType: d.seasonType, week: d.week };
    };
    expect(s('2025-07-01T00:00:00Z')).toEqual({ seasonType: 'pre', week: 0 });
    expect(s('2025-09-01T00:00:00Z')).toEqual({ seasonType: 'regular', week: 1 });
    // Week 1's MNF kicked off 2025-09-09T00:15Z; rollover 36h later.
    expect(s('2025-09-10T12:14:59Z')).toEqual({ seasonType: 'regular', week: 1 });
    expect(s('2025-09-10T12:15:00Z')).toEqual({ seasonType: 'regular', week: 2 });
    expect(s('2026-01-12T00:00:00Z')).toEqual({ seasonType: 'post', week: 19 });
    expect(s('2026-03-01T00:00:00Z')).toEqual({ seasonType: 'off', week: 22 });
    expect(deriveNflState(2025, schedule, at('2025-10-01T00:00:00Z'))).toMatchObject({
      season: 2025,
      leagueSeason: 2025,
      previousSeason: 2024,
      seasonStartDate: '2025-09-05'
    });
  });

  it('reads pre with no schedule and honors custom delays', () => {
    expect(deriveNflState(2030, schedule, at('2030-10-01T00:00:00Z'))).toMatchObject({
      seasonType: 'pre',
      week: 0,
      seasonStartDate: null
    });
    expect(deriveNflState(2025, schedule, at('2025-09-09T12:00:00Z'), { rolloverDelayMs: 0 }).week).toBe(2);
    expect(
      deriveNflState(2025, schedule, at('2025-09-01T00:00:00Z'), { preseasonLeadMs: 0 }).seasonType
    ).toBe('pre');
  });
});
