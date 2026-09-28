import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROJECTION_OPTIONS,
  averageLines,
  describeProjectionMethod,
  projectLine,
  projectWeek,
  trendingAdds
} from './projections.js';

describe('projectLine', () => {
  it('uses only the prior-season baseline in week 1', () => {
    expect(projectLine(1, [], { rec: 5, rec_yd: 60 })).toEqual({ rec: 5, rec_yd: 60 });
  });

  it('blends the baseline as (4 - week) games in weeks 1-3, then drops it', () => {
    const base = { rec_yd: 100 };
    // week 2: one game (weight 1) + baseline weight 2 → (40 + 200) / 3 = 80
    expect(projectLine(2, [{ rec_yd: 40 }], base)).toEqual({ rec_yd: 80 });
    // week 3: games weigh 1 and 0.8, baseline 1 → (40 + 0.8*70 + 100) / 2.8
    expect(projectLine(3, [{ rec_yd: 40 }, { rec_yd: 70 }], base)).toEqual({
      rec_yd: Math.round(((40 + 56 + 100) / 2.8) * 100) / 100
    });
    // week 4: baseline ignored
    expect(projectLine(4, [{ rec_yd: 40 }, { rec_yd: 70 }, { rec_yd: 10 }], base)).toEqual({
      rec_yd: Math.round(((40 + 56 + 6.4) / 2.44) * 100) / 100
    });
  });

  it('falls back to the baseline when the player has not played yet, and returns null with neither', () => {
    expect(projectLine(9, [], { pass_yd: 250 })).toEqual({ pass_yd: 250 });
    expect(projectLine(9, [], undefined)).toBeNull();
    expect(projectLine(1, [], undefined)).toBeNull();
  });

  it('only counts the last `window` games and never projects gp', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({ gp: 1, rush_yd: i < 6 ? 50 : 1000 }));
    expect(projectLine(12, history, undefined)).toEqual({ rush_yd: 50 });
  });

  it('keeps pts_allow at 0 so the points-allowed tier still applies, and drops other zeros', () => {
    expect(projectLine(5, [{ pts_allow: 0, sack: 0 }], undefined)).toEqual({ pts_allow: 0 });
  });

  it('is a weighted mean: every projected stat lies between the min and max of its inputs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 18 }),
        fc.array(fc.integer({ min: 0, max: 400 }), { minLength: 1, maxLength: 10 }),
        fc.option(fc.integer({ min: 0, max: 400 }), { nil: undefined }),
        (week, games, base) => {
          const line = projectLine(
            week,
            games.map((v) => ({ pass_yd: v })),
            base === undefined ? undefined : { pass_yd: base }
          );
          const used = games.slice(0, DEFAULT_PROJECTION_OPTIONS.window);
          const inputs = week <= 3 && base !== undefined ? [...used, base] : used;
          const value = line?.pass_yd ?? 0;
          expect(value).toBeGreaterThanOrEqual(Math.min(...inputs) - 0.01);
          expect(value).toBeLessThanOrEqual(Math.max(...inputs) + 0.01);
        }
      )
    );
  });
});

describe('averageLines / projectWeek / describeProjectionMethod', () => {
  it('averages lines per game', () => {
    expect(averageLines([])).toBeUndefined();
    expect(averageLines([{ rec: 2 }, { rec: 4, rec_td: 1 }])).toEqual({ rec: 3, rec_td: 0.5 });
  });

  it('projects every eligible player with history or a baseline, sorted by id', () => {
    const out = projectWeek({
      week: 2,
      history: new Map([['b', [{ rec: 4 }]]]),
      baselines: new Map([['a', { rec: 6 }]]),
      eligible: ['c', 'b', 'a']
    });
    expect(Object.keys(out)).toEqual(['a', 'b']);
    expect(out.a).toEqual({ rec: 6 });
    expect(out.b).toEqual({ rec: 4 });
  });

  it('documents the method with its parameters', () => {
    const text = describeProjectionMethod();
    expect(text).toContain('last 6 games');
    expect(text).toContain('0.8^i');
    expect(text).toContain('strictly pre-kickoff');
  });
});

describe('trendingAdds', () => {
  it('ranks the biggest projected-point risers, ignoring players without a previous projection', () => {
    const previous = { a: { rec_yd: 50 }, b: { rec_yd: 50 }, c: { rec_yd: 80 } };
    const current = { a: { rec_yd: 90 }, b: { rec_yd: 60 }, c: { rec_yd: 70 }, d: { rec_yd: 200 } };
    expect(trendingAdds(previous, current)).toEqual([
      { playerId: 'a', count: 400 },
      { playerId: 'b', count: 100 }
    ]);
    expect(trendingAdds(previous, current, 1)).toHaveLength(1);
    expect(trendingAdds(undefined, current)).toEqual([]);
  });

  it('breaks equal rises by player id', () => {
    const previous = { b: { rec_yd: 0 }, a: { rec_yd: 0 } };
    const current = { b: { rec_yd: 10 }, a: { rec_yd: 10 } };
    expect(trendingAdds(previous, current).map((t) => t.playerId)).toEqual(['a', 'b']);
  });
});
