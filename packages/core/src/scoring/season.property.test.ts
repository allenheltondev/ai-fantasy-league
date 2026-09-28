import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { roundPoints, scorePlayer } from './engine.js';
import { playedWeek, seasonPoints, sumStatLines, type WeekStatLine } from './season.js';
import { YAHOO_POINTS_ALLOWED_TIERS, scoringPreset } from './settings.js';

const STAT_KEYS = ['pass_yd', 'pass_td', 'pass_int', 'rush_yd', 'rush_td', 'rec', 'rec_yd', 'fum_lost'];

const statValue = fc.integer({ min: 0, max: 400 });
const lineArb = fc.dictionary(fc.constantFrom(...STAT_KEYS), statValue);
const weekArb = fc.record({
  week: fc.integer({ min: 1, max: 18 }),
  gp: fc.constantFrom(0, 1, undefined),
  stats: lineArb
});
const seasonArb = fc
  .uniqueArray(weekArb, { selector: (w) => w.week, maxLength: 18 })
  .map((weeks): WeekStatLine[] =>
    weeks.map((w) => ({ week: w.week, stats: w.gp === undefined ? w.stats : { ...w.stats, gp: w.gp } }))
  );
const presetArb = fc.constantFrom(
  scoringPreset('yahoo_standard'),
  scoringPreset('full_ppr'),
  scoringPreset('standard')
);

describe('seasonPoints properties', () => {
  it('points equal the sum of the weekly points', () => {
    fc.assert(
      fc.property(presetArb, seasonArb, (scoring, weeks) => {
        const season = seasonPoints(scoring, weeks);
        const sum = season.weekly.reduce((s, w) => s + w.points, 0);
        expect(season.points).toBe(roundPoints(sum));
        expect(season.weekly.map((w) => w.week)).toEqual(weeks.map((w) => w.week).sort((a, b) => a - b));
        for (const w of season.weekly) {
          const line = weeks.find((x) => x.week === w.week);
          expect(w.points).toBe(scorePlayer(scoring, line?.stats ?? {}).points);
        }
      })
    );
  });

  it('PPG is points over games played, and 0 with no games', () => {
    fc.assert(
      fc.property(presetArb, seasonArb, (scoring, weeks) => {
        const season = seasonPoints(scoring, weeks);
        const games = weeks.filter((w) => playedWeek(w.stats)).length;
        expect(season.games).toBe(games);
        if (games === 0) expect(season.ppg).toBe(0);
        else expect(Math.abs(season.ppg - season.points / games)).toBeLessThanOrEqual(0.005 + 1e-9);
      })
    );
  });

  it('season totals add every week key by key', () => {
    fc.assert(
      fc.property(fc.array(lineArb, { maxLength: 18 }), (lines) => {
        const total = sumStatLines(lines);
        for (const key of STAT_KEYS) {
          const expected = lines.reduce((s, l) => s + (l[key] ?? 0), 0);
          expect(total[key] ?? 0).toBe(expected);
        }
      })
    );
  });
});

describe('seasonPoints', () => {
  it('scores tiers per game, not on the season total', () => {
    const scoring = { perStat: {}, tiers: [YAHOO_POINTS_ALLOWED_TIERS] };
    const season = seasonPoints(scoring, [
      { week: 1, stats: { gp: 1, pts_allow: 0 } },
      { week: 2, stats: { gp: 1, pts_allow: 0 } }
    ]);
    expect(season).toMatchObject({ points: 20, games: 2, ppg: 10 });
  });

  it('counts a week without gp as played when it has stats, and handles an empty season', () => {
    expect(playedWeek({ rec: 2 })).toBe(true);
    expect(playedWeek({ rec: 0, gp: null })).toBe(false);
    expect(playedWeek({ gp: 0, rec: 3 })).toBe(false);
    expect(seasonPoints(scoringPreset(), [])).toEqual({ points: 0, games: 0, ppg: 0, weekly: [] });
  });

  it('skips nulls when summing and rounds float noise', () => {
    expect(sumStatLines([{ rec: 0.1, x: null }, { rec: 0.2 }])).toEqual({ rec: 0.3 });
  });
});
