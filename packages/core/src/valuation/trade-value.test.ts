import { describe, expect, it } from 'vitest';
import { yahooDefaultSettings, type LeagueSettings } from '../rules/settings.js';
import { rp } from '../trades/fixtures.test-helpers.js';
import type { TradeSide } from '../trades/trade.js';
import { tradeValue } from './trade-value.js';
import { replacementLevels } from './value.js';

const base = yahooDefaultSettings(4);
const settings: LeagueSettings = {
  ...base,
  teamCount: 2,
  roster: { ...base.roster, slots: { QB: 1, RB: 1, WR: 1, BN: 3, IR: 1 } }
};

const rosters = {
  A: [
    rp('aq', 'QB', 'KC', { slot: 'QB' }),
    rp('ar1', 'RB', 'KC', { slot: 'RB' }),
    rp('ar2', 'RB'),
    rp('aw', 'WR', 'KC', { slot: 'WR' })
  ],
  B: [
    rp('bq', 'QB', 'BUF', { slot: 'QB' }),
    rp('br', 'RB', 'BUF', { slot: 'RB' }),
    rp('bw1', 'WR', 'BUF', { slot: 'WR' }),
    rp('bw2', 'WR', 'BUF'),
    rp('bir', 'WR', 'BUF', { slot: 'IR', status: 'ir' })
  ]
};

const weekly = { aq: 20, ar1: 15, ar2: 12, aw: 6, bq: 18, br: 7, bw1: 14, bw2: 11, bir: 0 };
const projections = Object.fromEntries(
  Object.entries(weekly).map(([id, pts]) => [id, { 5: pts, 6: pts, 7: pts }])
);
const options = { fromWeek: 5, toWeek: 7 };
const side = (teamId: string, sends: string[], drops: string[] = []): TradeSide => ({ teamId, sends, drops });

describe('tradeValue', () => {
  it('scores a fair depth-for-need swap as balanced', () => {
    // A's backup RB (12) for B's backup WR (11): each fills the other's weakest starter.
    const r = tradeValue(
      settings,
      rosters,
      { sides: [side('A', ['ar2']), side('B', ['bw2'])] },
      projections,
      options
    );
    expect(r.sides[0]).toMatchObject({ teamId: 'A', lineupBefore: 123, lineupAfter: 138, lineupDelta: 15 });
    expect(r.sides[1]).toMatchObject({ teamId: 'B', lineupBefore: 117, lineupAfter: 132, lineupDelta: 15 });
    expect(r.lineupGap).toBe(0);
    expect(r.lopsided).toBe(false);
  });

  it('flags a lopsided trade and names the side it favours', () => {
    // A gives its QB for B's injured, zero-projection WR.
    const r = tradeValue(
      settings,
      rosters,
      { sides: [side('A', ['aq']), side('B', ['bir'])] },
      projections,
      options
    );
    expect(r.sides[0].lineupDelta).toBe(-60);
    expect(r.sides[1].lineupDelta).toBe(6);
    expect(r.lineupGap).toBe(66);
    expect(r.favors).toBe('B');
    expect(r.lopsided).toBe(true);
    const lenient = tradeValue(
      settings,
      rosters,
      { sides: [side('A', ['aq']), side('B', ['bir'])] },
      projections,
      { ...options, threshold: { lineupPoints: 1000, value: 1000 } }
    );
    expect(lenient.lopsided).toBe(false);
  });

  it('counts drops, supplied replacement levels, and reports no favourite for an even swap', () => {
    const replacement = replacementLevels(settings, [], projections, options);
    const r = tradeValue(
      settings,
      rosters,
      { sides: [side('A', [], ['ar2']), side('B', [], ['bw2'])] },
      projections,
      { ...options, replacement }
    );
    expect(r.sides[0].valueDelta).toBe(-36);
    expect(r.sides[1].valueDelta).toBe(-33);
    expect(r.favors).toBe('B');
    const even = tradeValue(
      settings,
      rosters,
      { sides: [side('A', []), side('B', [])] },
      projections,
      options
    );
    expect(even.favors).toBeNull();
    const ghost = tradeValue(
      settings,
      rosters,
      { sides: [side('A', []), side('Z', [])] },
      projections,
      options
    );
    expect(ghost.sides[1]).toMatchObject({ teamId: 'Z', lineupBefore: 0, valueBefore: 0 });
  });
});
