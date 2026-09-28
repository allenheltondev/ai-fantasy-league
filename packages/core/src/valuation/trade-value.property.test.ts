import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { yahooDefaultSettings, type LeagueSettings } from '../rules/settings.js';
import { rp } from '../trades/fixtures.test-helpers.js';
import type { RosteredPlayer, TradeSide } from '../trades/trade.js';
import { tradePlayersValue, tradeValue } from './trade-value.js';
import { replacementLevels } from './value.js';

/**
 * A trade's value can be computed from its players alone (`tradePlayersValue`, used by league
 * history and the model leaderboard once the rosters of the day are gone) and still agree with the
 * full roster math (`tradeValue`) for the same replacement levels.
 */

const base = yahooDefaultSettings(4);
const settings: LeagueSettings = {
  ...base,
  teamCount: 2,
  roster: { ...base.roster, slots: { QB: 1, RB: 1, WR: 1, BN: 3 } }
};
const POSITIONS = ['QB', 'RB', 'WR'] as const;
const options = { fromWeek: 5, toWeek: 6 };

interface Row {
  player: RosteredPlayer;
  pts: number;
}

const team = (prefix: string) =>
  fc
    .array(fc.tuple(fc.constantFrom(...POSITIONS), fc.integer({ min: 0, max: 30 })), {
      minLength: 1,
      maxLength: 6
    })
    .map((rows): Row[] => rows.map(([pos, pts], i) => ({ player: rp(`${prefix}${i}`, pos), pts })));

const scenario = fc.record({
  a: team('a'),
  b: team('b'),
  aSends: fc.array(fc.nat(), { maxLength: 3 }),
  bSends: fc.array(fc.nat(), { maxLength: 3 }),
  aDrops: fc.array(fc.nat(), { maxLength: 2 })
});

function pick(roster: readonly Row[], idx: readonly number[], skip = new Set<string>()): string[] {
  const ids = idx.map((i) => (roster[i % roster.length] as Row).player.playerId);
  return [...new Set(ids)].filter((id) => !skip.has(id));
}

describe('trade value from the players alone', () => {
  it('agrees with the roster math, and is zero-sum without drops', () => {
    fc.assert(
      fc.property(scenario, ({ a, b, aSends, bSends, aDrops }) => {
        const rosters = { A: a.map((r) => r.player), B: b.map((r) => r.player) };
        const projections = Object.fromEntries(
          [...a, ...b].map((r) => [r.player.playerId, { 5: r.pts, 6: r.pts }])
        );
        const sends = pick(a, aSends);
        const trade = {
          sides: [
            { teamId: 'A', sends, drops: pick(a, aDrops, new Set(sends)) },
            { teamId: 'B', sends: pick(b, bSends), drops: [] }
          ] as [TradeSide, TradeSide]
        };
        const all = [...rosters.A, ...rosters.B];
        const replacement = replacementLevels(settings, all, projections, options);
        const players = Object.fromEntries(all.map((p) => [p.playerId, p]));
        const quick = tradePlayersValue(trade, players, projections, { ...options, replacement });
        const full = tradeValue(settings, rosters, trade, projections, { ...options, replacement });
        expect(Math.abs(quick[0].valueDelta - full.sides[0].valueDelta)).toBeLessThan(0.05);
        expect(Math.abs(quick[1].valueDelta - full.sides[1].valueDelta)).toBeLessThan(0.05);
        // What one side sends the other receives.
        expect(quick[0].received).toBe(quick[1].given);
        if (trade.sides[0].drops.length === 0) {
          expect(Math.abs(quick[0].valueDelta + quick[1].valueDelta)).toBeLessThan(0.05);
        }
      })
    );
  });
});
