import { FixedClock } from '@fantasy/core';
import { FixtureDataProvider, LiveDataProvider, NflverseClient, SleeperClient } from '@fantasy/data';
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
      weeks: [
        { week: 1, stored: true, count: 1 },
        { week: 2, stored: false, reason: 'no_projections' }
      ]
    });
    deps.clock.advance(3_600_000);
    expect(await ingestProjections(deps, deps.clock)).toMatchObject({
      weeks: [{ week: 1, stored: false, reason: 'unchanged' }, { week: 2 }]
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

  it('projects next week before the current week has kicked off (#181)', async () => {
    // Monday of week 1 before its last game: Sleeper still says week 1, but a league drafted this
    // week already plays week 2, so its projections must be stored now.
    const { provider, deps } = await setup('2025-09-08T20:00:00.000Z');
    provider.projections[2] = [line('1', 2, { rec: 4 })];
    expect(await ingestProjections(deps, deps.clock)).toMatchObject({
      weeks: [
        { week: 1, stored: false, reason: 'no_projections' },
        { week: 2, stored: true }
      ]
    });
    expect(await deps.reference.projections.latestSnapshot(2025, 2, deps.clock.now())).toMatchObject({
      count: 1
    });
  });

  it('projects nothing past the last regular-season week', async () => {
    const { provider, deps } = await setup('2026-01-04T12:00:00.000Z', nflState({ week: 18 }));
    provider.projections[18] = [line('1', 18, { rec: 4 })];
    expect(await ingestProjections(deps, deps.clock)).toMatchObject({ weeks: [{ week: 18, stored: true }] });
    expect(provider.calls.filter((c) => c.startsWith('getWeekProjections'))).toEqual([
      'getWeekProjections:2025:18'
    ]);
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
    expect(await ingestProjections(deps, deps.clock)).toMatchObject({ weeks: [{ count: 1 }, { week: 2 }] });
  });

  it('records which Sleeper endpoint served each week (#184)', async () => {
    const { provider, deps } = await setup('2025-09-03T12:00:00.000Z');
    provider.projections[1] = [line('1', 1, { rec: 5 })];
    provider.projectionSources = { 1: 'app', 2: 'v1' };
    expect(await ingestProjections(deps, deps.clock)).toMatchObject({
      weeks: [
        { week: 1, stored: true, count: 1, source: 'app' },
        { week: 2, stored: false, reason: 'no_projections', source: 'v1' }
      ]
    });
    expect(await deps.reference.projections.latestSnapshot(2025, 1, deps.clock.now())).toMatchObject({
      source: 'app'
    });
    deps.clock.advance(3_600_000);
    expect(await ingestProjections(deps, deps.clock)).toMatchObject({
      weeks: [{ week: 1, reason: 'unchanged', source: 'app' }, { week: 2 }]
    });
  });

  it('stores a snapshot from the app endpoint when Sleeper v1 has only empty entries (#184)', async () => {
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      const body = url.startsWith('https://api.sleeper.com/projections/nfl/2025/1?')
        ? [
            {
              player_id: '4046',
              week: 1,
              team: 'KC',
              stats: { pass_yd: 262.3, pass_td: 1.86, adp_dd_ppr: 24 }
            },
            { player_id: '96', week: 1, team: null, stats: { adp_dd_ppr: 1000 } }
          ]
        : url.startsWith('https://api.sleeper.com/')
          ? []
          : { '4046': {}, '96': {} };
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    };
    const clock = new FixedClock('2025-09-03T12:00:00.000Z');
    const live = new LiveDataProvider({
      sleeper: new SleeperClient({ clock, fetch, limiter: { acquire: async () => undefined } }),
      nflverse: new NflverseClient({ fetch })
    });
    const deps = createTestJobDeps({ provider: live, clock });
    await deps.reference.nflState.put({ ...nflState(), updatedAt: 'x' }, null);

    const result = await ingestProjections(deps, deps.clock);
    expect(result).toMatchObject({
      weeks: [
        { week: 1, stored: true, count: 2, source: 'app' },
        { week: 2, stored: false, reason: 'no_projections', source: 'app' }
      ]
    });
    expect(calls.filter((c) => c.startsWith('https://api.sleeper.app/v1/projections/'))).toHaveLength(2);
    const snapshot = await deps.reference.projections.latestSnapshot(2025, 1, deps.clock.now());
    expect(snapshot).toMatchObject({ count: 2, source: 'app' });
    const [mahomes] = await deps.reference.projections.getLines(snapshot!, ['4046']);
    expect(mahomes?.stats).toEqual({ pass_yd: 262.3, pass_td: 1.86, adp_dd_ppr: 24 });
  });

  it('reads the recorded fixture projections', async () => {
    const deps = createTestJobDeps({
      provider: new FixtureDataProvider(),
      clock: new FixedClock('2025-09-04T12:00:00.000Z')
    });
    await deps.reference.nflState.put({ ...nflState(), updatedAt: 'x' }, null);
    const result = await ingestProjections(deps, deps.clock);
    // Week 2's recording was captured after this moment, so the fixture source hides it.
    expect(result).toMatchObject({
      weeks: [
        { week: 1, stored: true },
        { week: 2, stored: false }
      ]
    });
    const snapshot = await deps.reference.projections.latestSnapshot(2025, 1, deps.clock.now());
    const mahomes = await deps.reference.projections.getLines(snapshot!, ['4046']);
    expect(mahomes[0]?.stats.pass_yd).toBeGreaterThan(0);
  });
});
