import { FixtureDataProvider } from '@fantasy/data';
import { describe, expect, it } from 'vitest';
import { createTestJobDeps, sourcePlayer, StubProvider } from '../../test/support/jobs.js';
import { syncPlayers } from './sync-players.js';

describe('syncPlayers with the recorded fixtures', () => {
  it('stores the fantasy universe on the first sync and emits nothing', async () => {
    const deps = createTestJobDeps({ provider: new FixtureDataProvider() });
    const result = await syncPlayers(deps, deps.clock);

    expect(result).toMatchObject({ status: 'ok', statusChanges: 0, removed: 0 });
    expect(deps.events.events).toEqual([]);
    // IDP players (CB, LB) and the retired, team-less, inactive player are out of scope.
    const ids = (await deps.playerRepo.listIndex()).map((p) => p.id).sort();
    expect(ids).not.toContain('6994');
    expect(ids).not.toContain('7640');
    expect(ids).not.toContain('90004');
    expect(ids).toContain('90003');
    expect(result.upserted).toBe(ids.length);

    expect(await deps.playerRepo.get('4046')).toMatchObject({
      name: 'Patrick Mahomes',
      team: 'KC',
      position: 'QB',
      status: 'active',
      injuryStatus: null,
      updatedAt: '2025-09-04T12:00:00.000Z'
    });
    expect(await deps.playerRepo.get('6794')).toMatchObject({ injuryStatus: 'Questionable' });
    expect((await deps.playerRepo.get('KC'))?.aliases).toEqual(['KC', 'Chiefs', 'Kansas City D/ST']);
    expect(await deps.playerRepo.get('90002')).toMatchObject({ status: 'inactive' });
  });

  it('serves synced players through search and name resolution', async () => {
    const deps = createTestJobDeps({ provider: new FixtureDataProvider() });
    expect(await deps.directory.search({ query: 'mahomes', limit: 5 })).toEqual([]);
    await syncPlayers(deps, deps.clock);
    const found = await deps.directory.search({ query: 'mahomes', limit: 5 });
    expect(found.map((p) => p.id)).toEqual(['4046']);
    // Two fixture Lamar Jacksons, but the CB is outside the synced universe.
    expect((await deps.directory.resolve({ player: 'lamar jackson' })).id).toBe('4881');
  });

  it('is a no-op when nothing changed', async () => {
    const deps = createTestJobDeps({ provider: new FixtureDataProvider() });
    await syncPlayers(deps, deps.clock);
    deps.clock.advance(12 * 3_600_000);
    const again = await syncPlayers(deps, deps.clock);
    expect(again).toMatchObject({ upserted: 0, statusChanges: 0 });
    expect(deps.events.events).toEqual([]);
  });
});

describe('syncPlayers diffs', () => {
  const base = [
    sourcePlayer({ id: '1', name: 'Alpha One', position: 'RB', searchRank: 12 }),
    sourcePlayer({ id: '2', name: 'Bravo Two', position: 'WR' }),
    sourcePlayer({ id: '3', name: 'Charlie Three', position: 'TE' }),
    sourcePlayer({ id: 'LB1', name: 'Idp Guy', position: 'LB' })
  ];

  async function synced() {
    const provider = new StubProvider();
    provider.players = base;
    const deps = createTestJobDeps({ provider });
    await syncPlayers(deps, deps.clock);
    return { provider, deps };
  }

  it('upserts only changed players and emits one status event per changed player', async () => {
    const { provider, deps } = await synced();
    expect((await deps.playerRepo.get('1'))?.rank).toBe(12);
    // Warm the directory cache so the sync has to invalidate it.
    expect(await deps.directory.search({ query: 'delta', limit: 5 })).toEqual([]);

    provider.players = [
      { ...base[0]!, injuryStatus: 'Out', depthChartOrder: 2 },
      { ...base[1]!, team: 'BUF' },
      { ...base[2]!, age: 30 },
      base[3]!,
      sourcePlayer({ id: '4', name: 'Delta Four', position: 'QB' })
    ];
    deps.clock.advance(3_600_000);
    const result = await syncPlayers(deps, deps.clock);

    expect(result).toMatchObject({ upserted: 4, statusChanges: 2 });
    expect(deps.events.events).toEqual([
      {
        source: 'fantasy',
        detailType: 'Player Status Changed',
        detail: {
          playerId: '1',
          name: 'Alpha One',
          team: 'KC',
          position: 'RB',
          changes: [
            { field: 'injuryStatus', from: null, to: 'Out' },
            { field: 'depthChartOrder', from: 1, to: 2 }
          ],
          changedAt: '2025-09-04T13:00:00.000Z',
          source: 'sleeper'
        }
      },
      {
        source: 'fantasy',
        detailType: 'Player Status Changed',
        detail: {
          playerId: '2',
          name: 'Bravo Two',
          team: 'BUF',
          position: 'WR',
          changes: [{ field: 'team', from: 'KC', to: 'BUF' }],
          changedAt: '2025-09-04T13:00:00.000Z',
          source: 'sleeper'
        }
      }
    ]);
    expect(await deps.playerRepo.get('1')).toMatchObject({ injuryStatus: 'Out' });
    expect((await deps.playerRepo.get('3'))?.updatedAt).toBe('2025-09-04T13:00:00.000Z');
    expect((await deps.directory.search({ query: 'delta', limit: 5 })).map((p) => p.id)).toEqual(['4']);
  });

  it('keeps following a stored player who is released or leaves the fantasy positions', async () => {
    const { provider, deps } = await synced();
    provider.players = [
      { ...base[0]!, team: null, active: false, status: 'Inactive' },
      { ...base[1]!, position: 'LB' },
      base[2]!
    ];
    const result = await syncPlayers(deps, deps.clock);
    expect(result).toMatchObject({ upserted: 1, statusChanges: 1, removed: 1 });
    expect(await deps.playerRepo.get('1')).toMatchObject({ team: null, status: 'inactive' });
    expect(deps.events.events[0]?.detail).toMatchObject({
      playerId: '1',
      changes: [
        { field: 'status', from: 'Active', to: 'Inactive' },
        { field: 'team', from: 'KC', to: null }
      ]
    });
  });

  it('maps injured reserve and unknown teams', async () => {
    const provider = new StubProvider();
    provider.players = [
      sourcePlayer({ id: '9', status: 'Injured Reserve', injuryStatus: 'Other', injuryStatusRaw: 'COV' }),
      sourcePlayer({ id: '10', team: 'XYZ' }),
      sourcePlayer({ id: '11', position: null })
    ];
    const deps = createTestJobDeps({ provider });
    await syncPlayers(deps, deps.clock);
    expect(await deps.playerRepo.get('9')).toMatchObject({ status: 'injured_reserve', injuryStatus: 'COV' });
    expect(await deps.playerRepo.get('10')).toMatchObject({ team: null });
    expect(await deps.playerRepo.get('11')).toBeNull();
  });
});
