import { FixedClock } from '@fantasy/core';
import { FixtureDataProvider } from '@fantasy/data';
import { describe, expect, it } from 'vitest';
import { createTestJobDeps, game, nflState, sourcePlayer, StubProvider } from '../../test/support/jobs.js';
import { ingestProjections, projectionHash } from './ingest-projections.js';
import { syncPlayers } from './sync-players.js';

const line = (playerId: string, week: number, stats: Record<string, number>) => ({
  playerId,
  season: 2025,
  week,
  stats
});

async function setup(at: string, state = nflState()) {
  const provider = new StubProvider();
  const deps = createTestJobDeps({ provider, clock: new FixedClock(at) });
  await deps.reference.nflState.put({ ...state, updatedAt: at }, null);
  await deps.reference.schedule.putSeason(
    2025,
    [
      game({ gameId: 'a', kickoff: '2025-09-05T00:20:00.000Z' }),
      game({ gameId: 'b', kickoff: '2025-09-09T00:15:00.000Z' })
    ],
    {},
    new Date(at)
  );
  return { provider, deps };
}

describe('projectionHash', () => {
  it('ignores line and stat order but not values', () => {
    const a = [line('1', 1, { rec: 1, rec_yd: 10 }), line('2', 1, { pass_yd: 200 })];
    const b = [line('2', 1, { pass_yd: 200 }), line('1', 1, { rec_yd: 10, rec: 1 })];
    expect(projectionHash(a)).toBe(projectionHash(b));
    expect(projectionHash(a)).not.toBe(projectionHash([line('1', 1, { rec: 2, rec_yd: 10 })]));
  });
});

describe('ingestProjections', () => {
  it('stores a snapshot with capturedAt and skips an unchanged pull', async () => {
    const { provider, deps } = await setup('2025-09-03T12:00:00.000Z');
    provider.projections[1] = [line('1', 1, { rec: 5 })];
    expect(await ingestProjections(deps, deps.clock)).toMatchObject({
      status: 'ok',
      season: 2025,
      weeks: [{ week: 1, stored: true, count: 1 }]
    });
    deps.clock.advance(3_600_000);
    expect(await ingestProjections(deps, deps.clock)).toMatchObject({
      weeks: [{ week: 1, stored: false, reason: 'unchanged' }]
    });
    deps.clock.advance(3_600_000);
    provider.projections[1] = [line('1', 1, { rec: 6 })];
    await ingestProjections(deps, deps.clock);

    const projections = deps.reference.projections;
    const at = (iso: string) => projections.latestSnapshot(2025, 1, new Date(iso));
    expect(await at('2025-09-03T11:59:59.000Z')).toBeNull();
    const first = await at('2025-09-03T13:30:00.000Z');
    expect(first?.capturedAt).toBe('2025-09-03T12:00:00.000Z');
    expect((await projections.getLines(first!))[0]?.stats).toEqual({ rec: 5 });
    const second = await at('2025-09-03T14:00:00.000Z');
    expect(second?.capturedAt).toBe('2025-09-03T14:00:00.000Z');
    expect((await projections.getLines(second!, ['1']))[0]?.stats).toEqual({ rec: 6 });
  });

  it('adds next week once every game this week has kicked off', async () => {
    const { provider, deps } = await setup('2025-09-09T01:00:00.000Z');
    provider.projections[2] = [line('1', 2, { rec: 4 })];
    expect(await ingestProjections(deps, deps.clock)).toMatchObject({
      weeks: [
        { week: 1, stored: false, reason: 'no_projections' },
        { week: 2, stored: true }
      ]
    });
  });

  it('projects week 1 in the preseason and nothing in the off-season', async () => {
    const pre = await setup('2025-08-20T12:00:00.000Z', nflState({ seasonType: 'pre', week: 2 }));
    pre.provider.projections[1] = [line('1', 1, { rec: 1 })];
    expect(await ingestProjections(pre.deps, pre.deps.clock)).toMatchObject({
      weeks: [{ week: 1, stored: true }]
    });

    const off = await setup('2026-03-01T12:00:00.000Z', nflState({ seasonType: 'off', week: 18 }));
    expect(await ingestProjections(off.deps, off.deps.clock)).toEqual({
      status: 'skipped',
      reason: 'no_projection_week'
    });
    const none = createTestJobDeps();
    expect(await ingestProjections(none, none.clock)).toMatchObject({ reason: 'no_projection_week' });
  });

  it('keeps only synced players once the universe exists', async () => {
    const { provider, deps } = await setup('2025-09-03T12:00:00.000Z');
    provider.players = [sourcePlayer({ id: '1' })];
    await syncPlayers(deps, deps.clock);
    provider.projections[1] = [line('1', 1, { rec: 5 }), line('IDP', 1, { idp_tkl_solo: 4 })];
    expect(await ingestProjections(deps, deps.clock)).toMatchObject({ weeks: [{ count: 1 }] });
  });

  it('reads the recorded fixture projections', async () => {
    const deps = createTestJobDeps({
      provider: new FixtureDataProvider(),
      clock: new FixedClock('2025-09-04T12:00:00.000Z')
    });
    await deps.reference.nflState.put({ ...nflState(), updatedAt: 'x' }, null);
    const result = await ingestProjections(deps, deps.clock);
    expect(result).toMatchObject({ weeks: [{ week: 1, stored: true }] });
    const snapshot = await deps.reference.projections.latestSnapshot(2025, 1, deps.clock.now());
    const mahomes = await deps.reference.projections.getLines(snapshot!, ['4046']);
    expect(mahomes[0]?.stats.pass_yd).toBeGreaterThan(0);
  });
});
