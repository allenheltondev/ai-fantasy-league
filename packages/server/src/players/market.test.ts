import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fixturePlayers } from './fixtures.js';
import { MARKET_SORTS, marketPool, sortMarket, sortValue, type MarketRow } from './market.js';

const BYE = {
  state: 'bye' as const,
  opponent: null,
  home: null,
  kickoff: null,
  period: null,
  clock: null,
  teamScore: null,
  opponentScore: null,
  possession: false,
  redZone: false,
  progress: null
};

function row(id: string, values: Partial<MarketRow> = {}, rank: number | null = null): MarketRow {
  const player = { ...(fixturePlayers[0] as MarketRow['player']), id, rank };
  return {
    player,
    standing: { status: 'free_agent' },
    status: 'active',
    byeWeek: null,
    game: BYE,
    projectedPoints: null,
    projectedRos: null,
    seasonPoints: null,
    average: null,
    games: 0,
    trend: null,
    ...values
  };
}

describe('marketPool', () => {
  it('browses players on NFL teams, but a name finds anyone', () => {
    expect(marketPool(fixturePlayers, {}).some((p) => p.team === null)).toBe(false);
    expect(marketPool(fixturePlayers, { q: 'tucker' }).map((p) => p.id)).toEqual(['fx-tucker']);
  });

  it('filters FLEX to running backs, receivers, and tight ends', () => {
    const flex = marketPool(fixturePlayers, { position: 'FLEX', team: 'DET' });
    expect(flex.map((p) => p.id).sort()).toEqual(['fx-arsb', 'fx-jamesonw', 'fx-laporta']);
  });
});

describe('sortMarket', () => {
  it('puts rows without a value last, then breaks ties by rank and id', () => {
    const rows = [
      row('a', { projectedPoints: null }, 1),
      row('b', { projectedPoints: 10 }, 9),
      row('c', { projectedPoints: 10 }, 3),
      row('d', { projectedPoints: 12 }, null),
      row('e', { projectedPoints: null }, null)
    ];
    expect(sortMarket(rows, 'projected_week').map((r) => r.player.id)).toEqual(['d', 'c', 'b', 'a', 'e']);
  });

  it('ranks trends by net adds, and rank by the best consensus rank', () => {
    expect(sortValue(row('x', { trend: { adds: 10, drops: 4 } }), 'trending')).toBe(6);
    expect(sortValue(row('x'), 'trending')).toBeNull();
    expect(sortValue(row('x', {}, 7), 'rank')).toBe(-7);
    expect(sortValue(row('x'), 'rank')).toBeNull();
  });

  it('is a total order: any input order gives the same result', () => {
    const value = fc.option(fc.integer({ min: 0, max: 5 }), { nil: null });
    const rows = fc.uniqueArray(
      fc.record({ id: fc.string({ minLength: 1, maxLength: 4 }), v: value, rank: value }),
      { selector: (r) => r.id, maxLength: 12 }
    );
    fc.assert(
      fc.property(rows, fc.constantFrom(...MARKET_SORTS), (input, sort) => {
        const built = input.map((r) =>
          row(
            r.id,
            {
              projectedPoints: r.v,
              projectedRos: r.v,
              seasonPoints: r.v,
              average: r.v,
              trend: r.v === null ? null : { adds: r.v, drops: 0 }
            },
            r.rank
          )
        );
        const once = sortMarket(built, sort).map((r) => r.player.id);
        expect(sortMarket([...built].reverse(), sort).map((r) => r.player.id)).toEqual(once);
      })
    );
  });
});
