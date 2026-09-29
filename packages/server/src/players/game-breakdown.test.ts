import type { ScoreBreakdownItem } from '@fantasy/core';
import { describe, expect, it } from 'vitest';
import { gameBreakdown } from './current-form.js';

describe('gameBreakdown', () => {
  it('lists the biggest earners first and penalties last, skipping what scored nothing', () => {
    expect(
      gameBreakdown([
        { stat: 'fum_lost', value: 1, points: -2 },
        { stat: 'rec', value: 4, points: 2 },
        { stat: 'rec_td', value: 1, points: 6 },
        { stat: 'rush_yd', value: 0, points: 0 },
        { stat: 'rec_yd', value: 82.5, points: 8.25 }
      ])
    ).toEqual([
      { stat: 'rec_yd', text: '82.5 rec yds', points: 8.25 },
      { stat: 'rec_td', text: '1 rec TD', points: 6 },
      { stat: 'rec', text: '4 rec', points: 2 },
      { stat: 'fum_lost', text: '1 fumble lost', points: -2 }
    ]);
  });

  it('names a tier bonus, and folds what does not fit into other', () => {
    const items: ScoreBreakdownItem[] = [
      { stat: 'rec_yd', value: 112, points: 8, tier: { min: 100, max: null } },
      ...['rec', 'rec_td', 'rush_yd', 'rush_td', 'pass_yd', 'pass_td'].map((stat, i) => ({
        stat,
        value: 1,
        points: 6 - i
      }))
    ];
    const lines = gameBreakdown(items);
    expect(lines[0]).toEqual({ stat: 'rec_yd', text: 'rec yds bonus', points: 8 });
    expect(lines).toHaveLength(6);
    // 8, 6, 5, 4, 3 are shown; the 2 and the 1 fold together.
    expect(lines.at(-1)).toEqual({ stat: 'other', text: 'other', points: 3 });
  });

  it('is empty for a game that scored nothing', () => {
    expect(gameBreakdown([])).toEqual([]);
  });
});
