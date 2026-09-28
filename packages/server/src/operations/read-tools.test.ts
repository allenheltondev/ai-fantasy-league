import { describe, expect, it } from 'vitest';
import { registry } from './index.js';

/** The read tool surface (SPEC §6, #35 and #36). */
const READ_TOOLS = [
  'get_league_state',
  'get_roster',
  'get_standings',
  'get_matchup',
  'get_matchup_outlook',
  'search_players',
  'get_player',
  'get_projections',
  'get_trending_players',
  'list_transactions',
  'get_news',
  'get_draft_board'
];

describe('read tools', () => {
  it.each(READ_TOOLS)('%s is a read that takes `detail` (compact by default)', (name) => {
    const op = registry.get(name);
    expect(op, name).toBeDefined();
    expect(op?.mutation).toBe(false);
    expect(op?.auth).not.toBe('user');
    expect(op?.input.shape).toHaveProperty('detail');
    expect(op?.input.safeParse({ leagueId: 'x', teamId: 't', q: 'a' }).data?.detail).toBe(false);
  });
});
