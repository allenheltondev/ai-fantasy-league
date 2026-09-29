import { describe, expect, it } from 'vitest';
import { yahooDefaultSettings } from '../rules/settings.js';
import {
  forecastPlayer,
  forecastTeam,
  lineupInsights,
  normalCdf,
  opponentWeakSpots,
  winProbability,
  type OutlookPlayer
} from './outlook.js';

const settings = yahooDefaultSettings();

const player = (
  playerId: string,
  slot: OutlookPlayer['slot'],
  extra: Partial<OutlookPlayer> = {}
): OutlookPlayer => ({
  playerId,
  slot,
  positions: [slot === 'BN' || slot === 'IR' || slot === 'W/R/T' ? 'WR' : (slot as 'QB')],
  status: 'active',
  game: 'upcoming',
  projected: 10,
  actual: null,
  ...extra
});

describe('forecastPlayer', () => {
  it('uses the projection with a proportional spread before kickoff', () => {
    expect(forecastPlayer(player('a', 'WR', { projected: 20 }))).toEqual({
      mean: 20,
      variance: 81,
      current: 0,
      remaining: 20
    });
    expect(forecastPlayer(player('a', 'WR', { projected: 1 })).variance).toBe(4);
    expect(forecastPlayer(player('a', 'WR', { projected: null }))).toMatchObject({ mean: 0, variance: 0 });
  });

  it('scales the unmet projection by the share of a live game left', () => {
    // Q3 8:42: about 60% played, so 40% of the 12 unmet points remain.
    expect(
      forecastPlayer(player('a', 'WR', { game: 'live', progress: 0.6, projected: 20, actual: 8 }))
    ).toMatchObject({ current: 8, mean: 12.8 });
    expect(
      forecastPlayer(player('a', 'WR', { game: 'live', progress: 0.6, projected: 20, actual: 8 })).remaining
    ).toBeCloseTo(4.8, 9);
    // Overtime or the final whistle: nothing left.
    expect(
      forecastPlayer(player('a', 'WR', { game: 'live', progress: 1, projected: 20, actual: 8 }))
    ).toMatchObject({ remaining: 0, variance: 0 });
    // Out-of-range progress is clamped.
    expect(
      forecastPlayer(player('a', 'WR', { game: 'live', progress: -1, projected: 20, actual: 8 })).remaining
    ).toBe(12);
  });

  it('keeps half the unmet projection when progress is unknown, and none for a final game', () => {
    expect(forecastPlayer(player('a', 'WR', { game: 'live', projected: 20, actual: 8 }))).toMatchObject({
      mean: 14,
      current: 8,
      remaining: 6
    });
    expect(forecastPlayer(player('a', 'WR', { game: 'live', projected: 5, actual: 8 }))).toMatchObject({
      mean: 8,
      variance: 0
    });
    expect(forecastPlayer(player('a', 'WR', { game: 'final', projected: 20, actual: 3 }))).toEqual({
      mean: 3,
      variance: 0,
      current: 3,
      remaining: 0
    });
  });

  it('expects nothing from players on bye or ruled out', () => {
    expect(forecastPlayer(player('a', 'WR', { game: 'bye' })).mean).toBe(0);
    expect(forecastPlayer(player('a', 'WR', { status: 'out' })).mean).toBe(0);
  });
});

describe('forecastTeam and winProbability', () => {
  it('sums the starters only and counts who is left to play', () => {
    const team = forecastTeam([
      player('qb', 'QB', { projected: 20 }),
      player('wr', 'WR', { game: 'live', projected: 12, actual: 4 }),
      player('te', 'TE', { game: 'final', actual: 7 }),
      player('rb', 'RB', { game: 'bye' }),
      player('bn', 'BN', { projected: 30 })
    ]);
    expect(team).toMatchObject({
      current: 11,
      projected: 35,
      remaining: 24,
      yetToPlay: 1,
      inProgress: 1,
      done: 1,
      notPlaying: 1
    });
    expect(team.stdDev).toBeCloseTo(Math.sqrt(81 + 1.8 * 1.8), 2);
  });

  it('is a coin flip for equal teams and certain when nothing is left', () => {
    const a = { projected: 100, stdDev: 10 };
    expect(winProbability(a, a)).toBe(0.5);
    expect(winProbability({ projected: 90, stdDev: 0 }, { projected: 80, stdDev: 0 })).toBe(1);
    expect(winProbability({ projected: 80, stdDev: 0 }, { projected: 90, stdDev: 0 })).toBe(0);
    expect(winProbability({ projected: 80, stdDev: 0 }, { projected: 80, stdDev: 0 })).toBe(0.5);
    expect(winProbability({ projected: 110, stdDev: 10 }, { projected: 100, stdDev: 0 })).toBe(0.841);
  });

  it('matches the normal CDF', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1)).toBeCloseTo(0.1587, 4);
  });
});

describe('lineupInsights', () => {
  it('flags empty slots, starters out, bench upgrades, and locked players', () => {
    const insights = lineupInsights(settings, [
      player('qb', 'QB', { game: 'final', actual: 20 }),
      player('wr1', 'WR', { projected: 8 }),
      player('wr2', 'WR', { game: 'bye' }),
      player('wr3', 'WR', { status: 'out', game: 'live' }),
      player('rb1', 'RB', { status: 'out' }),
      player('bn-wr', 'BN', { projected: 15 }),
      player('bn-te', 'BN', { positions: ['TE'], projected: 9 }),
      player('bn-rb', 'BN', { positions: ['RB'], projected: 0 }),
      player('bn-hurt', 'BN', { status: 'out', projected: 20 }),
      player('bn-live', 'BN', { game: 'live', projected: 20 })
    ]);
    expect(insights.emptySlots).toEqual([
      { slot: 'RB', missing: 1 },
      { slot: 'TE', missing: 1 },
      { slot: 'W/R/T', missing: 1 },
      { slot: 'K', missing: 1 },
      { slot: 'DEF', missing: 1 }
    ]);
    expect(insights.startersOut).toEqual([
      { playerId: 'wr2', slot: 'WR', reason: 'bye' },
      { playerId: 'rb1', slot: 'RB', reason: 'out' }
    ]);
    expect(insights.benchUpgrades).toEqual([
      { benchPlayerId: 'bn-wr', starterPlayerId: 'wr2', slot: 'WR', gain: 15 },
      { benchPlayerId: 'bn-te', starterPlayerId: null, slot: 'TE', gain: 9 }
    ]);
    expect(insights.locked).toEqual(['qb', 'wr3', 'bn-live']);
  });

  it('suggests nothing for a lineup that is already best', () => {
    const insights = lineupInsights({ roster: { ...settings.roster, slots: { WR: 1, BN: 6 } } }, [
      player('wr1', 'WR', { projected: 20 }),
      player('bn', 'BN', { projected: 5 })
    ]);
    expect(insights.benchUpgrades).toEqual([]);
    expect(insights.startersOut).toEqual([]);
  });
});

describe('opponentWeakSpots', () => {
  it('lists empty, bye, out, and out-projected slots by your edge', () => {
    const spots = opponentWeakSpots(
      { roster: { ...settings.roster, slots: { QB: 1, WR: 2, TE: 1, K: 1, BN: 6 } } },
      [
        player('my-qb', 'QB', { projected: 25 }),
        player('my-wr1', 'WR', { projected: 18 }),
        player('my-wr2', 'WR', { projected: 9 }),
        player('my-te', 'TE', { projected: 5 })
      ],
      [
        player('qb', 'QB', { projected: 20 }),
        player('wr1', 'WR', { projected: 12 }),
        player('wr2', 'WR', { game: 'bye' }),
        player('te', 'TE', { projected: 8 })
      ]
    );
    expect(spots).toEqual([
      expect.objectContaining({
        slot: 'WR',
        playerId: 'wr2',
        reason: 'bye',
        yourPlayerId: 'my-wr2',
        edge: 9
      }),
      expect.objectContaining({ slot: 'WR', playerId: 'wr1', reason: 'outprojected', edge: 6 }),
      expect.objectContaining({ slot: 'QB', reason: 'outprojected', edge: 5 }),
      expect.objectContaining({ slot: 'K', playerId: null, reason: 'empty', yourPlayerId: null, edge: 0 })
    ]);
    expect(spots.map((s) => s.edge)).toEqual([9, 6, 5, 0]);
    expect(spots.some((s) => s.slot === 'TE')).toBe(false);
  });

  it('flags an opponent starter ruled out', () => {
    const spots = opponentWeakSpots(settings, [], [player('qb', 'QB', { status: 'ir' })]);
    expect(spots[0]).toMatchObject({ slot: 'QB', reason: 'out', theirProjected: 0 });
  });
});
