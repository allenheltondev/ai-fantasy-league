import { describe, expect, it } from 'vitest';
import { yahooDefaultSettings, type LeagueSettings } from '../rules/settings.js';
import { scoringPreset } from '../scoring/settings.js';
import {
  playerValue,
  projectPoints,
  projectionsFromStatLines,
  recencyWeights,
  replacementLevels,
  restOfSeasonPoints,
  riskMultiplier,
  valuePlayers,
  weekProjections,
  type ValuedPlayer
} from './value.js';

const base = yahooDefaultSettings(4);
/** Two teams, each starting QB, RB and a W/R/T flex. */
const small: LeagueSettings = {
  ...base,
  teamCount: 2,
  roster: { ...base.roster, slots: { QB: 1, RB: 1, 'W/R/T': 1, BN: 2 } }
};

const player = (
  playerId: string,
  pos: ValuedPlayer['positions'][number],
  status: ValuedPlayer['status'] = 'active'
): ValuedPlayer => ({
  playerId,
  positions: [pos],
  status
});

describe('projections', () => {
  it('scores projected stat lines with the league scoring', () => {
    const line = { rec: 5, rec_yd: 60, rec_td: 0.5 };
    expect(projectPoints(scoringPreset('yahoo_standard'), line)).toBe(11.5);
    expect(projectPoints({ scoring: scoringPreset('full_ppr') }, line)).toBe(14);
    const table = projectionsFromStatLines(scoringPreset('full_ppr'), { p: { 3: line, 4: {} } });
    expect(table).toEqual({ p: { 3: 14, 4: 0 } });
    expect(weekProjections(table, 3)).toEqual({ p: 14 });
    expect(weekProjections(table, 9)).toEqual({});
  });
});

describe('rest-of-season points', () => {
  const proj = { a: { 5: 10, 6: 10, 7: 10 } };

  it('sums the weeks, treating missing weeks as 0 and applying the schedule factor', () => {
    expect(restOfSeasonPoints('a', proj, { fromWeek: 5, toWeek: 8 })).toBe(30);
    expect(restOfSeasonPoints('zz', proj, { fromWeek: 5, toWeek: 8 })).toBe(0);
    const factor = (_id: string, week: number) => (week === 6 ? 1.5 : 1);
    expect(restOfSeasonPoints('a', proj, { fromWeek: 5, toWeek: 7, scheduleFactor: factor })).toBe(35);
  });

  it('keeps recency weights on the points scale while favouring near weeks', () => {
    const w = recencyWeights(1, 4, 0.5);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(4);
    expect(w[0]).toBeGreaterThan(w[3] as number);
    expect(recencyWeights(1, 3)).toEqual([1, 1, 1]);
    expect(recencyWeights(5, 4)).toEqual([]);
    const front = { b: { 1: 20, 2: 0 } };
    const back = { b: { 1: 0, 2: 20 } };
    const opts = { fromWeek: 1, toWeek: 2, weights: { recencyBias: 0.8 } };
    expect(restOfSeasonPoints('b', front, opts)).toBeGreaterThan(restOfSeasonPoints('b', back, opts));
  });

  it('discounts injured players by risk tolerance', () => {
    expect(riskMultiplier('active')).toBe(1);
    expect(riskMultiplier('ir', 0)).toBeCloseTo(0.3);
    expect(riskMultiplier('ir', 1)).toBe(1);
    expect(riskMultiplier('questionable')).toBeCloseTo(0.95);
    expect(riskMultiplier('out', 5)).toBe(1);
  });
});

describe('replacement level and value', () => {
  const pool = [
    player('q1', 'QB'),
    player('q2', 'QB'),
    player('q3', 'QB'),
    player('r1', 'RB'),
    player('r2', 'RB'),
    player('r3', 'RB'),
    player('r4', 'RB'),
    player('w1', 'WR'),
    player('w2', 'WR'),
    player('k1', 'K'),
    { playerId: 'none', positions: [], status: 'active' as const }
  ];
  const proj = {
    q1: { 1: 25 },
    q2: { 1: 20 },
    q3: { 1: 15 },
    r1: { 1: 18 },
    r2: { 1: 16 },
    r3: { 1: 14 },
    r4: { 1: 9 },
    w1: { 1: 12 },
    w2: { 1: 11 },
    k1: { 1: 8 }
  };
  const opts = { fromWeek: 1, toWeek: 1 };

  it('fills dedicated slots, then flex, and takes the best player left at each position', () => {
    // QB×2 take q1,q2; RB×2 take r1,r2; flex×2 take r3 (14) and w1 (12).
    const levels = replacementLevels(small, pool, proj, opts);
    expect(levels).toMatchObject({ QB: 15, RB: 9, WR: 11, K: 8, TE: 0, DEF: 0 });
  });

  it('computes VORP with position weights and injury risk', () => {
    const replacement = replacementLevels(small, pool, proj, opts);
    expect(playerValue(player('r1', 'RB'), proj, { ...opts, replacement })).toEqual({
      playerId: 'r1',
      position: 'RB',
      rosPoints: 18,
      adjustedPoints: 18,
      replacementPoints: 9,
      vorp: 9,
      value: 9
    });
    const zeroRb = { ...opts, replacement, weights: { positionWeights: { RB: 0.5 } } };
    expect(playerValue(player('r1', 'RB'), proj, zeroRb).value).toBe(4.5);
    expect(
      playerValue(player('r1', 'RB', 'ir'), proj, { ...opts, replacement, weights: { riskTolerance: 0 } })
        .adjustedPoints
    ).toBe(5.4);
    expect(playerValue(player('r1', 'RB'), proj, opts).vorp).toBe(18);
    expect(
      playerValue({ playerId: 'none', positions: [], status: 'active' }, proj, opts).position
    ).toBeNull();
  });

  it('ranks a pool by value', () => {
    const ranked = valuePlayers(small, pool, proj, opts);
    expect(ranked[0]?.playerId).toBe('q1');
    expect(ranked.map((v) => v.playerId).slice(0, 3)).toEqual(['q1', 'r1', 'r2']);
    expect(ranked).toHaveLength(pool.length);
  });
});
