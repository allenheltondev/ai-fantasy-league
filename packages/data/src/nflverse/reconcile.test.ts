import { describe, expect, it } from 'vitest';
import { reconcileWithNflverse } from './reconcile.js';

const line = (playerId: string, stats: Record<string, number>, week = 3) => ({
  playerId,
  season: 2025,
  week,
  stats
});

describe('reconcileWithNflverse', () => {
  it('takes nflverse for the stats it maps and keeps the rest of the Sleeper line', () => {
    const primary = [
      line('p1', { gp: 1, rec: 5, rec_yd: 60, fum_lost: 1, bonus_rec_te: 5 }),
      line('p2', { gp: 1, rush_yd: 40 }),
      line('DEF-KC', { def_int: 2 })
    ];
    const official = [
      line('p1', { gp: 1, rec: 6, rec_yd: 72 }),
      line('p2', { gp: 1, rush_yd: 12 }, 4),
      line('00-0012345', { rush_yd: 99 })
    ];
    expect(reconcileWithNflverse(primary, official)).toEqual([
      line('p1', { gp: 1, rec: 6, rec_yd: 72, bonus_rec_te: 5 }),
      line('p2', { gp: 1, rush_yd: 40 }),
      line('DEF-KC', { def_int: 2 })
    ]);
  });
});
