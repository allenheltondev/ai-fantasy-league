import { FixedClock } from '@fantasy/core';
import { FixtureDataProvider } from '@fantasy/data';
import { describe, expect, it } from 'vitest';
import { createTestJobDeps, game, nflState, sourcePlayer, StubProvider } from '../../test/support/jobs.js';
import { ingestStats } from './ingest-stats.js';
import { syncNflState } from './sync-nfl-state.js';
import { syncPlayers } from './sync-players.js';
import { syncSchedule } from './sync-schedule.js';

const SUNDAY_1PM_KICKOFF = '2025-09-07T17:00:00.000Z';

async function stubbed(at: string) {
  const provider = new StubProvider();
  const deps = createTestJobDeps({ provider, clock: new FixedClock(at) });
  await deps.reference.nflState.put({ ...nflState(), updatedAt: at }, null);
  await deps.reference.schedule.putSeason(
    2025,
    [
      game({ gameId: '2025_01_DAL_PHI', kickoff: '2025-09-05T00:20:00.000Z' }),
      game({ gameId: '2025_01_KC_LAC', kickoff: SUNDAY_1PM_KICKOFF, homeTeam: 'LAC', awayTeam: 'KC' })
    ],
    {},
    new Date(at)
  );
  return { provider, deps };
}

describe('ingestStats gating', () => {
  it('skips without an NFL state, outside the regular season, or without a schedule', async () => {
    const provider = new StubProvider();
    const deps = createTestJobDeps({ provider });
    expect(await ingestStats(deps, deps.clock)).toEqual({ status: 'skipped', reason: 'no_nfl_state' });

    await deps.reference.nflState.put({ ...nflState({ seasonType: 'pre' }), updatedAt: 'x' }, null);
    expect(await ingestStats(deps, deps.clock)).toMatchObject({
      reason: 'not_regular_season',
      seasonType: 'pre'
    });

    await deps.reference.nflState.put({ ...nflState(), updatedAt: 'x' }, nflState({ seasonType: 'pre' }));
    expect(await ingestStats(deps, deps.clock)).toMatchObject({ reason: 'no_schedule', week: 1 });
    expect(provider.calls).toEqual([]);
  });

  it('is a cheap no-op outside every game window', async () => {
    const { provider, deps } = await stubbed('2025-09-09T15:00:00.000Z'); // Tuesday
    expect(await ingestStats(deps, deps.clock)).toEqual({
      status: 'skipped',
      reason: 'outside_game_window',
      season: 2025,
      week: 1
    });
    expect(provider.calls).toEqual([]);
  });

  it('runs from kickoff until 4.5 hours later', async () => {
    const { provider, deps } = await stubbed(SUNDAY_1PM_KICKOFF);
    provider.stats = [];
    expect(await ingestStats(deps, deps.clock)).toMatchObject({ status: 'ok' });
    deps.clock.advance(4.5 * 3_600_000 - 1);
    expect(await ingestStats(deps, deps.clock)).toMatchObject({ status: 'ok' });
    deps.clock.advance(1);
    expect(await ingestStats(deps, deps.clock)).toMatchObject({ reason: 'outside_game_window' });
  });
});

describe('ingestStats inside a game window', () => {
  it('stores changed lines and emits Scores Updated with only the affected players', async () => {
    const { provider, deps } = await stubbed('2025-09-07T18:00:00.000Z');
    provider.stats = [
      { playerId: '1', season: 2025, week: 1, team: 'KC', stats: { rec: 2, rec_yd: 30 } },
      { playerId: '2', season: 2025, week: 1, stats: { rush_yd: 10 } }
    ];
    expect(await ingestStats(deps, deps.clock)).toMatchObject({ status: 'ok', fetched: 2, changed: 2 });
    expect(await deps.reference.stats.getWeek(2025, 1)).toEqual([
      {
        playerId: '1',
        season: 2025,
        week: 1,
        team: 'KC',
        stats: { rec: 2, rec_yd: 30 },
        updatedAt: '2025-09-07T18:00:00.000Z'
      },
      { playerId: '2', season: 2025, week: 1, stats: { rush_yd: 10 }, updatedAt: '2025-09-07T18:00:00.000Z' }
    ]);

    // Two minutes later only player 2 moved.
    deps.clock.advance(120_000);
    provider.stats = [
      { playerId: '1', season: 2025, week: 1, team: 'KC', stats: { rec_yd: 30, rec: 2 } },
      { playerId: '2', season: 2025, week: 1, stats: { rush_yd: 22, rush_td: 1 } }
    ];
    expect(await ingestStats(deps, deps.clock)).toMatchObject({ changed: 1 });
    // And then nothing moved.
    deps.clock.advance(120_000);
    expect(await ingestStats(deps, deps.clock)).toMatchObject({ changed: 0 });

    expect(deps.events.events.map((e) => [e.detailType, e.detail.playerIds])).toEqual([
      ['Scores Updated', ['1', '2']],
      ['Scores Updated', ['2']]
    ]);
    expect(deps.events.events[1]?.detail).toEqual({
      season: 2025,
      week: 1,
      playerIds: ['2'],
      updatedAt: '2025-09-07T18:02:00.000Z'
    });
    expect((await deps.reference.stats.getPlayerHistory('2'))[0]?.stats).toEqual({ rush_yd: 22, rush_td: 1 });
  });

  it('keeps only players in the synced universe once players are synced', async () => {
    const { provider, deps } = await stubbed('2025-09-07T18:00:00.000Z');
    provider.players = [sourcePlayer({ id: '1' })];
    await syncPlayers(deps, deps.clock);
    provider.stats = [
      { playerId: '1', season: 2025, week: 1, stats: { rec: 1 } },
      { playerId: 'IDP', season: 2025, week: 1, stats: { idp_tkl_solo: 5 } }
    ];
    expect(await ingestStats(deps, deps.clock)).toMatchObject({ fetched: 2, changed: 1 });
    expect((await deps.reference.stats.getWeek(2025, 1)).map((l) => l.playerId)).toEqual(['1']);
  });
});

describe('ingestStats with the recorded fixtures', () => {
  it('ingests the lines final by Sunday afternoon, then the rest', async () => {
    const provider = new FixtureDataProvider();
    const deps = createTestJobDeps({ provider, clock: new FixedClock('2025-09-07T18:00:00.000Z') });
    await syncNflState(deps, deps.clock);
    await syncSchedule(deps, deps.clock);

    const first = await ingestStats(deps, deps.clock);
    expect(first).toMatchObject({ status: 'ok', season: 2025, week: 1 });
    const early = (await deps.reference.stats.getWeek(2025, 1)).map((l) => l.playerId);
    // Thursday's and Friday's games are final (Hurts, Mahomes); Sunday night's BAL at BUF is not.
    expect(early).toEqual(expect.arrayContaining(['6904', '4046']));
    expect(early).not.toContain('4984');

    deps.clock.set('2025-09-08T04:25:00.000Z'); // just after Sunday night's game went final
    const second = await ingestStats(deps, deps.clock);
    expect(second).toMatchObject({ status: 'ok' });
    const updated = deps.events.events.filter((e) => e.detailType === 'Scores Updated');
    expect(updated).toHaveLength(2);
    expect(updated[1]?.detail.playerIds).toContain('4984');
    expect(updated[1]?.detail.playerIds).not.toContain('6904');
  });
});
