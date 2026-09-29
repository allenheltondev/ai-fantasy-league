import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { forecastPlayer } from './outlook.js';
import { gameProgress, PLAYER_GAME_STATES, playerGame, type NflGameRead } from './game-state.js';

const KICKOFF = Date.parse('2026-10-04T17:00:00.000Z');
const HOUR = 3_600_000;

const clock = fc
  .tuple(fc.integer({ min: 0, max: 15 }), fc.integer({ min: 0, max: 59 }))
  .map(([m, s]) => `${m}:${String(s).padStart(2, '0')}`);

const readArb: fc.Arbitrary<NflGameRead> = fc.record({
  homeTeam: fc.constant('PHI'),
  awayTeam: fc.constant('DAL'),
  kickoff: fc.option(fc.constant(new Date(KICKOFF).toISOString()), { nil: null }),
  state: fc.constantFrom('pre', 'in', 'post'),
  homeScore: fc.option(fc.integer({ min: 0, max: 60 }), { nil: null }),
  awayScore: fc.option(fc.integer({ min: 0, max: 60 }), { nil: null }),
  period: fc.option(fc.integer({ min: -1, max: 7 }), { nil: null }),
  clock: fc.option(fc.oneof(clock, fc.string()), { nil: null }),
  possessionTeam: fc.constantFrom(null, 'PHI', 'DAL'),
  isRedZone: fc.boolean()
});

const offset = fc.integer({ min: -48 * HOUR, max: 48 * HOUR });
const rank = (state: string) => PLAYER_GAME_STATES.indexOf(state as never);

describe('player game state properties', () => {
  it('only moves forward as time passes, for any fixed read', () => {
    fc.assert(
      fc.property(
        readArb,
        offset,
        offset,
        fc.constantFrom('PHI', 'DAL'),
        fc.option(fc.integer({ min: HOUR, max: 12 * HOUR }), { nil: undefined }),
        (read, a, b, team, finalAfterMs) => {
          const [early, late] = a <= b ? [a, b] : [b, a];
          const options = finalAfterMs === undefined ? {} : { finalAfterMs };
          const before = playerGame(team, [read], new Date(KICKOFF + early), options);
          const after = playerGame(team, [read], new Date(KICKOFF + late), options);
          expect(rank(after.state)).toBeGreaterThanOrEqual(rank(before.state));
        }
      )
    );
  });

  it('progress is null or within 0-1, and matches the state', () => {
    fc.assert(
      fc.property(readArb, offset, (read, t) => {
        const g = playerGame('PHI', [read], new Date(KICKOFF + t));
        if (g.progress !== null) {
          expect(g.progress).toBeGreaterThanOrEqual(0);
          expect(g.progress).toBeLessThanOrEqual(1);
        }
        if (g.state === 'final') expect(g.progress).toBe(1);
        if (g.state === 'upcoming') expect(g.progress).toBe(0);
        if (g.state !== 'live') expect(g.possession || g.redZone || g.clock !== null).toBe(false);
      })
    );
  });

  it('game progress never leaves 0-1 and never goes back within regulation', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 0, max: 900 }),
        fc.integer({ min: 0, max: 900 }),
        (q, x, y) => {
          const [more, less] = x >= y ? [x, y] : [y, x];
          const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
          const earlier = gameProgress(q, fmt(more)) as number;
          const later = gameProgress(q, fmt(less)) as number;
          expect(earlier).toBeGreaterThanOrEqual(0);
          expect(later).toBeLessThanOrEqual(1);
          expect(later).toBeGreaterThanOrEqual(earlier);
        }
      )
    );
  });

  it('a player whose game is final has no remaining projection', () => {
    fc.assert(
      fc.property(readArb, offset, fc.double({ min: 0, max: 50, noNaN: true }), (read, t, projected) => {
        const g = playerGame('PHI', [read], new Date(KICKOFF + t));
        const f = forecastPlayer({
          playerId: 'p',
          slot: 'QB',
          positions: ['QB'],
          status: 'active',
          game: g.state,
          progress: g.progress,
          projected,
          actual: null
        });
        if (g.state === 'final' || g.state === 'bye') expect(f.remaining).toBe(0);
      })
    );
  });
});
