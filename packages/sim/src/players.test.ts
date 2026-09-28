import type { Player } from '@fantasy/data';
import { describe, expect, it } from 'vitest';
import { game } from '../test/helpers.js';
import { byId, toRosterPlayer, weekGames } from './players.js';

const base: Player = {
  id: '1',
  name: 'A B',
  firstName: 'A',
  lastName: 'B',
  team: 'KC',
  position: 'FB',
  fantasyPositions: ['RB', 'FB'],
  status: 'Injured Reserve',
  injuryStatus: null,
  depthChartOrder: null,
  depthChartPosition: null,
  active: true,
  searchNames: []
};

describe('players helpers', () => {
  it('normalizes positions (deduplicated) and statuses', () => {
    expect(toRosterPlayer(base)).toEqual({
      playerId: '1',
      name: 'A B',
      positions: ['RB'],
      status: 'ir',
      nflTeam: 'KC'
    });
    expect(
      toRosterPlayer({ ...base, position: null, fantasyPositions: ['XX'], injuryStatus: 'Questionable' })
    ).toMatchObject({ positions: [], status: 'questionable' });
  });

  it('keys a week of regular-season games by team', () => {
    const post = { ...game(1, '2025-09-07T17:00:00.000Z', 'X', 'Y'), seasonType: 'post' as const };
    const games = weekGames(
      [
        game(1, '2025-09-07T17:00:00.000Z', 'KC', 'LAC'),
        game(2, '2025-09-14T17:00:00.000Z', 'KC', 'BUF'),
        post
      ],
      1
    );
    expect(games).toEqual({
      KC: { kickoff: '2025-09-07T17:00:00.000Z' },
      LAC: { kickoff: '2025-09-07T17:00:00.000Z' }
    });
  });

  it('sorts ids by code unit', () => {
    expect(['b', 'B', 'a', 'a'].sort(byId)).toEqual(['B', 'a', 'a', 'b']);
  });
});
