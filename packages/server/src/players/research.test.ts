import { scoringPreset } from '@fantasy/core';
import { describe, expect, it } from 'vitest';
import { nflState } from '../../test/support/jobs.js';
import { sortAvailable } from '../operations/draft/board.js';
import { createInMemoryReferenceStore } from '../repos/memory-reference.js';
import { InMemoryPlayerRepository } from '../repos/memory.js';
import type { Ctx } from '../context.js';
import type { Player } from './model.js';
import { cardTotals, loadResearch } from './research.js';

const scoring = scoringPreset('yahoo_standard');

function ctx() {
  const reference = createInMemoryReferenceStore(new InMemoryPlayerRepository());
  return { reference, ctx: { data: { reference } } as unknown as Pick<Ctx, 'data'> };
}

const player = (id: string, rank: number | null): Player => ({
  id,
  name: id,
  firstName: '',
  lastName: id,
  team: 'KC',
  position: 'WR',
  status: 'active',
  injuryStatus: null,
  aliases: [],
  rank,
  updatedAt: 'x'
});

describe('loadResearch', () => {
  it('has nothing before the NFL state is known', async () => {
    const research = await loadResearch(ctx().ctx, scoring, ['a']);
    expect([research.season, research.lastSeason('a'), research.projection('a'), research.bye('KC')]).toEqual(
      [null, null, null, null]
    );
  });

  it('reads nothing for no players, and the whole set for many', async () => {
    const { reference, ctx: c } = ctx();
    await reference.nflState.put(
      { ...nflState({ season: 2026, previousSeason: 2025, leagueSeason: 2026 }), updatedAt: 'x' },
      null
    );
    const empty = await loadResearch(c, scoring, []);
    expect(empty.lastSeasonYear).toBe(2025);
    expect(empty.lastSeason('a')).toBeNull();

    const ids = Array.from({ length: 150 }, (_, i) => `p${i}`);
    await reference.seasons.put(
      { kind: 'stats', season: 2025, updatedAt: 'x', players: 150, weeks: [1], hash: 'h' },
      ids.map((playerId) => ({ playerId, season: 2025, weeks: [{ week: 1, stats: { gp: 1, rec: 2 } }] }))
    );
    const many = await loadResearch(c, scoring, ids);
    expect(many.lastSeason('p149')).toMatchObject({ points: 1, games: 1, ppg: 1 });
    // Memoized: the same object comes back.
    expect(many.lastSeason('p149')).toBe(many.lastSeason('p149'));
    expect(many.bye(null)).toBeNull();
    expect(many.bye('KC')).toBeNull();
  });
});

describe('cardTotals', () => {
  it('totals the position’s stats, 0 for ones never recorded', () => {
    const totals = cardTotals(
      {
        playerId: 'k',
        season: 2025,
        weeks: [
          { week: 1, stats: { fgm: 2, fga: 3, xpm: 1 } },
          { week: 2, stats: { fgm: 1, fga: 1 } }
        ]
      },
      'K'
    );
    expect(totals).toEqual({ fgm: 3, fga: 4, fgm_50p: 0, xpm: 1, xpa: 0 });
  });
});

describe('sortAvailable', () => {
  it('keeps rank order for ties and for players without a value', async () => {
    const { reference, ctx: c } = ctx();
    await reference.nflState.put(
      { ...nflState({ season: 2026, previousSeason: 2025, leagueSeason: 2026 }), updatedAt: 'x' },
      null
    );
    const line = (playerId: string, rec: number) => ({
      playerId,
      season: 2025,
      weeks: [{ week: 1, stats: { gp: 1, rec } }]
    });
    await reference.seasons.put(
      { kind: 'stats', season: 2025, updatedAt: 'x', players: 3, weeks: [1], hash: 'h' },
      [line('b', 4), line('c', 4), line('e', 8)]
    );
    const players = ['a', 'b', 'c', 'd', 'e'].map((id, i) => player(id, i + 1));
    const research = await loadResearch(
      c,
      scoring,
      players.map((p) => p.id)
    );
    expect(sortAvailable(players, research, 'lastSeasonPoints').map((p) => p.id)).toEqual([
      'e',
      'b',
      'c',
      'a',
      'd'
    ]);
    expect(sortAvailable(players, research, 'rank').map((p) => p.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(sortAvailable(players, research, 'projection').map((p) => p.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e'
    ]);
  });
});
