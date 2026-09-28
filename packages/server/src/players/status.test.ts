import { normalizePlayer } from '@fantasy/data';
import { describe, expect, it } from 'vitest';
import { draftPool, type DraftDeps } from '../league/draft.js';
import { playerStatus } from '../season/lineups.js';
import { rosterStatus, toPlayerDetail, type Player } from './model.js';
import { toProfile } from './profile.js';

/** Sleeper's team defense record: no roster status, no search rank. */
const sleeperDefense = normalizePlayer({
  player_id: 'KC',
  first_name: 'Kansas City',
  last_name: 'Chiefs',
  position: 'DEF',
  team: 'KC',
  status: null,
  active: true,
  fantasy_positions: ['DEF'],
  search_rank: null
} as unknown as Parameters<typeof normalizePlayer>[0]);

const stored = (overrides: Partial<Player>): Player => ({
  id: 'KC',
  name: 'Kansas City Chiefs',
  firstName: 'Kansas City',
  lastName: 'Chiefs',
  team: 'KC',
  position: 'DEF',
  status: 'inactive',
  injuryStatus: null,
  aliases: [],
  rank: null,
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...overrides
});

describe('team defense status', () => {
  it('syncs a team defense on an NFL team as active, though Sleeper leaves its status empty', () => {
    expect(toProfile(sleeperDefense, '2026-09-01T00:00:00.000Z')?.status).toBe('active');
    expect(toProfile({ ...sleeperDefense, team: null }, '2026-09-01T00:00:00.000Z')?.status).toBe('inactive');
  });

  it('treats a defense stored as inactive by an older sync as active; other players keep theirs', () => {
    expect(rosterStatus(stored({}))).toBe('active');
    expect(rosterStatus(stored({ team: null }))).toBe('inactive');
    expect(rosterStatus(stored({ position: 'WR' }))).toBe('inactive');
    expect(rosterStatus(stored({ position: 'RB', status: 'injured_reserve' }))).toBe('injured_reserve');
    expect(toPlayerDetail(stored({}), true)).toMatchObject({ status: 'active' });
    expect(playerStatus(stored({}))).toBe(playerStatus(stored({ status: 'active' })));
  });

  it('puts every team defense in the draft pool, and still leaves out inactive players', async () => {
    const players = [
      stored({}),
      stored({ id: 'PHI', name: 'Philadelphia Eagles', team: 'PHI' }),
      stored({ id: 'wr-1', name: 'Retired Receiver', position: 'WR' }),
      stored({ id: 'wr-2', name: 'Active Receiver', position: 'WR', status: 'active', rank: 5 })
    ];
    const deps = { data: { players: { all: async () => players } } } as unknown as DraftDeps;
    expect((await draftPool(deps)).map((p) => p.id)).toEqual(['wr-2', 'KC', 'PHI']);
  });
});
