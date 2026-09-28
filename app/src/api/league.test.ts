import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiFetch } from './client';
import { createLeagueApi, useLeagueApi } from './league';

function setup() {
  const fetch = vi.fn(async (path: string, _init?: unknown) => ({
    data:
      path === '/leagues' ? { leagues: ['L'] } : path.endsWith('/invites') ? { invites: ['I'] } : { path },
    league: null,
    warnings: []
  }));
  return { fetch, api: createLeagueApi(fetch as unknown as ApiFetch) };
}

describe('createLeagueApi', () => {
  it('maps every call to its operation path, method, and body', async () => {
    const { fetch, api } = setup();
    expect(await api.listMyLeagues()).toEqual(['L']);
    expect(await api.listInvites('L 1')).toEqual(['I']);
    await api.createLeague({ name: 'N', teamCount: 8, preset: 'full_ppr' });
    await api.getLeague('L1');
    await api.getLeagueState('L1');
    await api.updateSettings('L1', { teamCount: 10 }, 3);
    await api.getDefaultSettings({ teamCount: 8, preset: 'standard', startWeek: 2 });
    await api.createInvite('L1');
    await api.revokeInvite('L1', 'i/1');
    await api.getInvite('t k');
    await api.joinLeague('tok');
    await api.joinLeague('tok', 'Champs');
    await api.setSeatType('L1', 'team-2', 'human');
    await api.renameTeam('L1', 'team-2', 'New');
    await api.removeMember('L1', 'bob');
    await api.transferCommissioner('L1', 'bob');
    await api.getAgentCatalog();
    await api.getAgentCatalog({ suggest: 3 });
    await api.getAgentSeat('L1', 'team-4');
    await api.configureAgentSeat('L1', 'team-4', {
      personalityId: 'p',
      difficulty: 'pro',
      archetype: 'balanced'
    });
    await api.randomizeAgentSeats('L1', ['team-4']);
    const calls = fetch.mock.calls.map(([path, init]) => [
      path,
      (init as { method?: string } | undefined)?.method
    ]);
    expect(calls).toEqual([
      ['/leagues', undefined],
      ['/leagues/L%201/invites', undefined],
      ['/leagues', 'POST'],
      ['/leagues/L1', undefined],
      ['/leagues/L1/state', undefined],
      ['/leagues/L1/settings', 'PATCH'],
      ['/settings/defaults', undefined],
      ['/leagues/L1/invites', 'POST'],
      ['/leagues/L1/invites/i%2F1', 'DELETE'],
      ['/invites/t%20k', undefined],
      ['/invites/tok/join', 'POST'],
      ['/invites/tok/join', 'POST'],
      ['/leagues/L1/teams/team-2/seat-type', 'PUT'],
      ['/leagues/L1/teams/team-2/name', 'PUT'],
      ['/leagues/L1/members/bob', 'DELETE'],
      ['/leagues/L1/commissioner', 'POST'],
      ['/agents/catalog', undefined],
      ['/agents/catalog', undefined],
      ['/leagues/L1/agents/team-4', undefined],
      ['/leagues/L1/agents/team-4', 'PUT'],
      ['/leagues/L1/agents/randomize', 'POST']
    ]);
    const bodies = fetch.mock.calls.map(([, init]) => (init as { body?: unknown } | undefined)?.body);
    expect(bodies[5]).toEqual({ changes: { teamCount: 10 }, expectedVersion: 3 });
    expect(bodies[10]).toEqual({});
    expect(bodies[11]).toEqual({ teamName: 'Champs' });
    expect(fetch.mock.calls[17]?.[1]).toEqual({ query: { suggest: 3 } });
  });

  it('maps the season calls and keeps set_lineup warnings', async () => {
    const { fetch, api } = setup();
    await api.getRoster('L1', 'team-1');
    await api.getMatchup('L1');
    await api.getStandings('L1');
    await api.getRealtime('L1');
    await api.getMatchupOutlook('L1');
    const moves = [{ playerId: 'p1', slot: 'WR' }];
    expect(await api.setLineup('L1', 'team-1', 3, moves)).toEqual({
      roster: { path: '/leagues/L1/teams/team-1/lineup' },
      warnings: []
    });
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      '/leagues/L1/teams/team-1/roster',
      '/leagues/L1/matchup',
      '/leagues/L1/standings',
      '/leagues/L1/realtime',
      '/leagues/L1/matchup/outlook',
      '/leagues/L1/teams/team-1/lineup'
    ]);
    expect(fetch.mock.calls[5]?.[1]).toEqual({ method: 'PUT', body: { week: 3, moves } });
  });

  it('maps the playoff bracket and history reads', async () => {
    const { fetch, api } = setup();
    await api.getPlayoffBracket('L1');
    await api.getLeagueHistory('L1');
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/leagues/L1/playoffs', '/leagues/L1/history']);
  });

  it('useLeagueApi needs a provider', () => {
    expect(() => renderHook(() => useLeagueApi())).toThrow(/LeagueApiContext/);
  });
});
