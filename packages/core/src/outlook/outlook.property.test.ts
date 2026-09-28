import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PLAYER_STATUSES, ROSTER_SLOTS, isEligibleForSlot, isStarterSlot } from '../rules/positions.js';
import { yahooDefaultSettings } from '../rules/settings.js';
import {
  forecastPlayer,
  forecastTeam,
  isLocked,
  lineupInsights,
  normalCdf,
  opponentWeakSpots,
  willNotPlay,
  winProbability,
  type OutlookPlayer
} from './outlook.js';

const settings = yahooDefaultSettings();
const points = fc.double({ min: 0, max: 60, noNaN: true, noDefaultInfinity: true });

const playerArb = (id: string) =>
  fc.record({
    playerId: fc.constant(id),
    slot: fc.constantFrom(
      ...ROSTER_SLOTS.filter((s) => s !== 'IDP' && s !== 'DL' && s !== 'LB' && s !== 'DB')
    ),
    positions: fc.constantFrom(['QB'], ['RB'], ['WR'], ['TE'], ['K'], ['DEF'], ['RB', 'WR']),
    status: fc.constantFrom(...PLAYER_STATUSES),
    game: fc.constantFrom('bye', 'pending', 'live', 'final'),
    projected: fc.option(points, { nil: null }),
    actual: fc.option(points, { nil: null })
  }) as fc.Arbitrary<OutlookPlayer>;

const teamArb = (prefix: string) =>
  fc
    .integer({ min: 0, max: 16 })
    .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => playerArb(`${prefix}${i}`))));

const forecast = fc.record({
  projected: fc.double({ min: 0, max: 250, noNaN: true, noDefaultInfinity: true }),
  stdDev: fc.double({ min: 0, max: 60, noNaN: true, noDefaultInfinity: true })
});

describe('outlook properties', () => {
  it('win probabilities are in [0, 1] and the two sides sum to 1', () => {
    fc.assert(
      fc.property(forecast, forecast, (a, b) => {
        const p = winProbability(a, b);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
        expect(p + winProbability(b, a)).toBeCloseTo(1, 10);
      })
    );
  });

  it('a higher projection never lowers the win probability', () => {
    fc.assert(
      fc.property(forecast, forecast, fc.double({ min: 0, max: 50, noNaN: true }), (a, b, bump) => {
        expect(winProbability({ ...a, projected: a.projected + bump }, b)).toBeGreaterThanOrEqual(
          winProbability(a, b)
        );
      })
    );
  });

  it('the normal CDF is monotonic and symmetric', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -8, max: 8, noNaN: true }),
        fc.double({ min: 0, max: 4, noNaN: true }),
        (z, d) => {
          expect(normalCdf(z + d)).toBeGreaterThanOrEqual(normalCdf(z) - 1e-12);
          expect(normalCdf(z) + normalCdf(-z)).toBeCloseTo(1, 12);
        }
      )
    );
  });

  it('a player forecast never drops below his points so far, and finished players carry no risk', () => {
    fc.assert(
      fc.property(playerArb('p'), (p) => {
        const f = forecastPlayer(p);
        expect(f.mean).toBeGreaterThanOrEqual(f.current);
        expect(f.remaining).toBeGreaterThanOrEqual(0);
        expect(f.variance).toBeGreaterThanOrEqual(0);
        if (p.game === 'final' || p.game === 'bye') expect(f.variance).toBe(0);
      })
    );
  });

  it('a team projection is at least its current score and counts only starters', () => {
    fc.assert(
      fc.property(teamArb('t'), (team) => {
        const f = forecastTeam(team);
        expect(f.projected).toBeGreaterThanOrEqual(f.current - 0.01);
        expect(f.yetToPlay + f.inProgress).toBeLessThanOrEqual(
          team.filter((p) => isStarterSlot(p.slot)).length
        );
        expect(forecastTeam(team.filter((p) => isStarterSlot(p.slot)))).toEqual(f);
      })
    );
  });

  it('bench upgrades are legal, positive, and never touch a locked or unavailable player', () => {
    fc.assert(
      fc.property(teamArb('t'), (team) => {
        const byId = new Map(team.map((p) => [p.playerId, p]));
        const insights = lineupInsights(settings, team);
        for (const up of insights.benchUpgrades) {
          const bench = byId.get(up.benchPlayerId) as OutlookPlayer;
          expect(up.gain).toBeGreaterThan(0);
          expect(bench.slot).toBe('BN');
          expect(isLocked(bench) || willNotPlay(bench)).toBe(false);
          expect(isEligibleForSlot(up.slot, bench.positions)).toBe(true);
          if (up.starterPlayerId !== null) {
            const starter = byId.get(up.starterPlayerId) as OutlookPlayer;
            expect(starter.slot).toBe(up.slot);
            expect(isLocked(starter)).toBe(false);
          }
        }
        expect(insights.locked).toEqual(team.filter(isLocked).map((p) => p.playerId));
      })
    );
  });

  it('weak spots are sorted by edge and name only opponent starters', () => {
    fc.assert(
      fc.property(teamArb('a'), teamArb('b'), (mine, theirs) => {
        const spots = opponentWeakSpots(settings, mine, theirs);
        for (let i = 1; i < spots.length; i++) {
          expect(spots[i - 1]?.edge).toBeGreaterThanOrEqual(spots[i]?.edge ?? 0);
        }
        for (const spot of spots) {
          expect(isStarterSlot(spot.slot)).toBe(true);
          if (spot.playerId !== null)
            expect(theirs.find((p) => p.playerId === spot.playerId)?.slot).toBe(spot.slot);
          if (spot.reason === 'outprojected') expect(spot.edge).toBeGreaterThan(0);
        }
      })
    );
  });
});
