import { describe, expect, it, vi } from 'vitest';
import type { ApiFetch, ApiRequest } from '../api/client';
import { createTradesApi } from './api';

function fakeFetch() {
  const calls: { path: string; request: ApiRequest | undefined }[] = [];
  const fetch = vi.fn(async (path: string, request?: ApiRequest) => {
    calls.push({ path, request });
    let data: unknown = { trade: { id: 't1' } };
    if (path.endsWith('/state'))
      data = {
        yourTeam: { id: 'team-1', name: 'A' },
        teams: [{ id: 'team-1', name: 'A', extra: 1 }],
        allowedActions: []
      };
    else if (path.endsWith('/roster'))
      data = { players: [{ player: { id: 'p1', name: 'P', team: null, position: 'QB' } }] };
    else if (path.endsWith('/trades') && request?.method === undefined) data = { trades: [{ id: 't1' }] };
    else if (path.endsWith('/preview')) data = { valid: true };
    return { data, league: null, warnings: [] };
  });
  return { fetch: fetch as unknown as ApiFetch, calls };
}

describe('trades api', () => {
  it('calls each trade operation with the documented path and body', async () => {
    const { fetch, calls } = fakeFetch();
    const api = createTradesApi(fetch);
    const s = { withTeamId: 'team-2', send: ['a'], receive: ['b'], drops: [], message: 'hi' };
    expect(await api.setup('L 1')).toEqual({
      yourTeam: { id: 'team-1', name: 'A' },
      teams: [{ id: 'team-1', name: 'A' }],
      allowedActions: []
    });
    expect(await api.roster('L1', 'team-2')).toEqual([{ id: 'p1', name: 'P', team: null, position: 'QB' }]);
    expect(await api.list('L1')).toEqual([{ id: 't1' }]);
    expect(await api.preview('L1', s)).toEqual({ valid: true });
    await api.propose('L1', s);
    await api.counter('L1', 't1', { ...s, message: '' });
    await api.respond('L1', 't1', 'accept');
    await api.withdraw('L1', 't1');
    expect(await api.vote('L1', 't1', 'veto')).toEqual({ id: 't1' });
    expect(await api.realtime('L1')).toEqual({ trade: { id: 't1' } });
    expect(calls.map((c) => c.path)).toEqual([
      '/leagues/L%201/state',
      '/leagues/L1/teams/team-2/roster',
      '/leagues/L1/trades',
      '/leagues/L1/trades/preview',
      '/leagues/L1/trades',
      '/leagues/L1/trades/t1/counter',
      '/leagues/L1/trades/t1/respond',
      '/leagues/L1/trades/t1/withdraw',
      '/leagues/L1/trades/t1/votes',
      '/leagues/L1/realtime'
    ]);
    expect(calls[3]?.request?.query).toEqual({
      withTeamId: 'team-2',
      send: ['a'],
      receive: ['b'],
      drops: []
    });
    expect(calls[4]?.request?.body).toEqual({
      withTeamId: 'team-2',
      send: ['a'],
      receive: ['b'],
      drops: [],
      message: 'hi'
    });
    expect(calls[5]?.request?.body).toEqual({ send: ['a'], receive: ['b'], drops: [] });
    expect(calls[6]?.request?.body).toEqual({ response: 'accept', drops: [] });
    expect(calls[8]?.request?.body).toEqual({ decision: 'veto' });
  });
});
