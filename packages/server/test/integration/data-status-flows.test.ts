import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runJob } from '../../src/jobs/lambda.js';
import { registry } from '../../src/operations/index.js';
import type { JobDeps } from '../../src/jobs/deps.js';
import { createHarness, type Harness } from '../support/harness.js';
import { createTestJobDeps, nflState, StubProvider } from '../support/jobs.js';
import { as, data, errorCode, type Caller } from '../support/league-client.js';
import { ALICE, BOB } from '../support/leagues.js';
import { seedNflSchedule, seedSeasonLeague } from '../support/season.js';

/**
 * #181 over HTTP (DynamoDB Local). A league drafted during NFL week 1 plays from week 2 while
 * Sleeper's state still says week 1, so its roster showed no projections until the projections
 * job stored week 2. The commissioner's get_data_status shows what the jobs stored and how each
 * one's latest run went.
 */

const L = '/leagues/lg-data';
let h: Harness;
let alice: Caller;
let bob: Caller;
let provider: StubProvider;
let deps: JobDeps;

interface Status {
  nflState: { season: number; seasonType: string; week: number } | null;
  league: { season: number; week: number | null };
  players: { total: number; byPosition: Record<string, number> };
  weeks: {
    week: number;
    projections: { capturedAt: string; count: number; source: 'v1' | 'app' | null } | null;
    statLines: number;
  }[];
  research: {
    stats: unknown;
    projections: { season: number; players: number } | null;
    currentStats?: unknown;
  };
  jobs: { job: string; latest: { status: string; reason: string | null; summary: string | null } | null }[];
}

const status = async () => data<Status>(await alice.get(`${L}/data-status`));
const job = (s: Status, name: string) => s.jobs.find((j) => j.job === name);

beforeAll(async () => {
  h = await createHarness({ backend: 'dynamo', registry });
  alice = as(h, ALICE);
  bob = as(h, BOB);
  const reference = h.services.data.reference;
  await seedNflSchedule(reference);
  await seedSeasonLeague(
    { repos: h.repos, reference },
    { id: 'lg-data', owners: [ALICE, BOB], overrides: { week: 2 } }
  );
  provider = new StubProvider();
  provider.state = nflState({ season: 2026, leagueSeason: 2026, previousSeason: 2025, week: 1 });
  deps = {
    ...createTestJobDeps({ provider, clock: h.clock }),
    repos: h.repos,
    reference,
    directory: h.services.data.players
  };
});
afterAll(() => h.close());

describe('get_data_status (#181)', () => {
  it('shows nothing stored before the jobs run', async () => {
    const s = await status();
    expect(s.nflState).toBeNull();
    expect(s.league).toEqual({ season: 2026, week: 2 });
    expect(s.players.total).toBeGreaterThan(0);
    expect(s.players.byPosition.DEF).toBeGreaterThan(0);
    expect(s.weeks.map((w) => [w.week, w.projections, w.statLines])).toEqual([
      [2, null, 0],
      [3, null, 0]
    ]);
    expect(s.research).toEqual({ stats: null, projections: null, currentStats: null });
    expect(job(s, 'ingestProjections')).toEqual({ job: 'ingestProjections', latest: null, lastOk: null });
  });

  it('shows why a job skipped', async () => {
    await runJob({ job: 'ingestProjections' }, deps, h.clock);
    expect(job(await status(), 'ingestProjections')?.latest).toMatchObject({
      status: 'skipped',
      reason: 'no_projection_week'
    });
  });

  it("stores the league's week while the NFL is still on the week before, and the roster shows it", async () => {
    await runJob({ job: 'syncNflState' }, deps, h.clock);
    provider.projections[1] = [{ playerId: 'fx-cmc', season: 2026, week: 1, stats: { rush_yd: 80 } }];
    provider.projections[2] = [{ playerId: 'fx-cmc', season: 2026, week: 2, stats: { rush_yd: 100 } }];
    provider.projectionSources = { 1: 'v1', 2: 'app' };
    await runJob({ job: 'ingestProjections' }, deps, h.clock);

    const s = await status();
    expect(s.nflState).toMatchObject({ season: 2026, seasonType: 'regular', week: 1 });
    expect(s.weeks[0]).toMatchObject({
      week: 2,
      // Sleeper's v1 had nothing for week 2, so the app endpoint served it (#184).
      projections: { count: 1, capturedAt: h.clock.now().toISOString(), source: 'app' }
    });
    const run = job(s, 'ingestProjections')?.latest;
    expect(run).toMatchObject({ status: 'ok', reason: null });
    expect(JSON.parse(run?.summary ?? '')).toMatchObject({
      season: 2026,
      weeks: [
        { week: 1, source: 'v1' },
        { week: 2, stored: true, source: 'app' }
      ]
    });

    const roster = data<{
      week: number;
      players: { player: { id: string }; projectedPoints: number | null }[];
    }>(await alice.get(`${L}/teams/team-1/roster`));
    expect(roster.week).toBe(2);
    expect(roster.players.find((p) => p.player.id === 'fx-cmc')?.projectedPoints).toBe(10);
  });

  it('is for the commissioner only', async () => {
    const res = await bob.get(`${L}/data-status`);
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe('FORBIDDEN');
  });
});
