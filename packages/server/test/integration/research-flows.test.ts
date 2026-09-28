import { scorePlayer, scoringPreset, yahooDefaultSettings } from '@fantasy/core';
import { FixtureDataProvider } from '@fantasy/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JobDeps } from '../../src/jobs/deps.js';
import { ingestProjections } from '../../src/jobs/ingest-projections.js';
import { ingestTrending } from '../../src/jobs/ingest-trending.js';
import { syncNflState } from '../../src/jobs/sync-nfl-state.js';
import { syncPlayers } from '../../src/jobs/sync-players.js';
import { syncSchedule } from '../../src/jobs/sync-schedule.js';
import { silentLogger } from '../../src/log.js';
import { registry } from '../../src/operations/index.js';
import { createHarness, league, type Harness } from '../support/harness.js';
import { FakeNewsSource } from '../support/jobs.js';
import { RESEARCH_LEAGUE_ID, seedReferenceData } from '../support/reference-seed.js';

type Body = { data: Record<string, unknown>; warnings: { code: string }[]; error?: { code: string } };
const get = async (h: Harness, path: string) => {
  const res = await h.request(path);
  return { status: res.status, body: res.body as Body };
};

describe('research operations over seeded reference data', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ registry });
    await seedReferenceData(h.services, h.repos);
  });

  it('get_projections scores one player with default half-PPR and returns compact key stats', async () => {
    const { status, body } = await get(h, '/api/v1/projections?player=cmc');
    expect(status).toBe(200);
    const stats = { rush_att: 18, rush_yd: 85, rush_td: 0.8, rec: 5, rec_yd: 40, rec_td: 0.2 };
    expect(body.data).toEqual({
      season: 2026,
      week: 1,
      capturedAt: '2026-09-09T12:00:00.000Z',
      scoring: { source: 'default' },
      projections: [
        {
          player: { id: 'fx-cmc', name: 'Christian McCaffrey', team: 'SF', position: 'RB' },
          points: scorePlayer(scoringPreset('yahoo_standard'), stats).points,
          stats
        }
      ]
    });
    expect(body.warnings).toEqual([]);
  });

  it('get_projections ranks a position, filters by team, and returns every stat with detail', async () => {
    const wr = await get(h, '/api/v1/projections?position=WR');
    const rows = wr.body.data.projections as { player: { id: string }; points: number; stats: object }[];
    expect(rows.map((r) => r.player.id)).toEqual(['fx-chase', 'fx-lamb']);
    expect(rows[0]!.points).toBeGreaterThan(rows[1]!.points);
    expect(Object.keys(rows[1]!.stats)).toEqual(['rec_tgt', 'rec', 'rec_yd', 'rec_td', 'rush_yd']);

    const kc = await get(h, '/api/v1/projections?team=KC&detail=true');
    expect(kc.body.data.projections).toEqual([
      expect.objectContaining({
        player: expect.objectContaining({ id: 'fx-butker' }),
        stats: { fga: 2.1, fgm: 1.8, xpm: 2.6 }
      })
    ]);

    const all = await get(h, '/api/v1/projections?limit=2');
    expect((all.body.data.projections as unknown[]).length).toBe(2);
  });

  it('get_projections uses a league’s own scoring', async () => {
    await h.repos.leagues.create(
      league({ id: 'lg-ppr', settings: yahooDefaultSettings(8, { scoring: 'full_ppr' }) })
    );
    const ppr = await get(h, '/api/v1/projections?playerIds=fx-chase&leagueId=lg-ppr');
    const half = await get(h, `/api/v1/projections?playerIds=fx-chase&leagueId=${RESEARCH_LEAGUE_ID}`);
    const none = await get(h, '/api/v1/projections?playerIds=fx-chase');
    expect(ppr.body.data.scoring).toEqual({ source: 'league' });
    expect(half.body.data.scoring).toEqual({ source: 'league' });
    expect(none.body.data.scoring).toEqual({ source: 'default' });
    const points = (b: Body) => (b.data.projections as { points: number }[])[0]!.points;
    expect(points(ppr.body) - points(half.body)).toBeCloseTo(3.5);
    expect(points(half.body)).toBeCloseTo(points(none.body));
  });

  it('get_projections refuses league scoring to non-members', async () => {
    await h.repos.leagues.create(
      league({ id: 'lg-private', commissionerId: 'someone-else', createdBy: 'someone-else' })
    );
    const res = await get(h, '/api/v1/projections?playerIds=fx-chase&leagueId=lg-private');
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });

  it('get_projections warns about requested players with no projection', async () => {
    const { body } = await get(h, '/api/v1/projections?playerIds=fx-chase&playerIds=fx-bijan');
    expect((body.data.projections as unknown[]).length).toBe(1);
    expect(body.warnings.map((w) => w.code)).toEqual(['NO_PROJECTION_FOR_PLAYER']);
    const none = await get(h, '/api/v1/projections?season=2026&week=2&player=cmc');
    expect(none.body.warnings.map((w) => w.code)).toEqual(['NO_PROJECTIONS']);
  });

  it('get_trending_players serves the closest cached window and skips unknown players', async () => {
    const day = await get(h, '/api/v1/players/trending');
    expect(day.body.data).toEqual({
      type: 'add',
      lookbackHours: 24,
      capturedAt: '2026-09-10T11:00:00.000Z',
      players: [
        { player: { id: 'fx-swift', name: "D'Andre Swift", team: 'CHI', position: 'RB' }, count: 4200 },
        { player: { id: 'fx-jamesonw', name: 'Jameson Williams', team: 'DET', position: 'WR' }, count: 3100 }
      ]
    });
    const wr = await get(h, '/api/v1/players/trending?position=WR&limit=1');
    expect((wr.body.data.players as { player: { id: string } }[]).map((p) => p.player.id)).toEqual([
      'fx-jamesonw'
    ]);
    const week = await get(h, '/api/v1/players/trending?lookbackHours=200');
    expect(week.status).toBe(400);
    const longest = await get(h, '/api/v1/players/trending?lookbackHours=100');
    expect(longest.body.data.lookbackHours).toBe(168);
    const drops = await get(h, '/api/v1/players/trending?type=drop');
    expect(drops.body.warnings.map((w) => w.code)).toEqual(['NO_TRENDING_DATA']);
  });

  it('get_news filters by player, team, and time window', async () => {
    const all = await get(h, '/api/v1/news');
    expect((all.body.data.items as { id: string }[]).map((i) => i.id)).toEqual(['news-1', 'news-2']);
    expect(all.body.data.items).toContainEqual(expect.not.objectContaining({ summary: expect.anything() }));

    const cmc = await get(h, '/api/v1/news?player=cmc&detail=true');
    expect(cmc.body.data.items).toEqual([
      {
        id: 'news-1',
        title: 'Christian McCaffrey limited at practice',
        url: 'https://example.com/cmc-limited',
        source: 'Example Sports',
        publishedAt: '2026-09-10T08:00:00.000Z',
        players: [{ id: 'fx-cmc', name: 'Christian McCaffrey', team: 'SF', position: 'RB' }],
        teams: ['SF'],
        summary: 'The 49ers running back was limited on Wednesday.'
      }
    ]);
    const buf = await get(h, '/api/v1/news?team=BUF');
    expect((buf.body.data.items as { id: string }[]).map((i) => i.id)).toEqual(['news-2']);
    const recent = await get(h, '/api/v1/news?since=2026-09-10T00:00:00Z');
    expect((recent.body.data.items as { id: string }[]).map((i) => i.id)).toEqual(['news-1']);
    const older = await get(h, '/api/v1/news?until=2026-09-10T00:00:00Z&since=2026-09-01T00:00:00Z');
    expect((older.body.data.items as { id: string }[]).map((i) => i.id)).toEqual(['news-2']);
  });

  it('search_players accepts an availability filter that is not applied until rosters exist', async () => {
    const res = await get(
      h,
      `/api/v1/players?q=williams&leagueId=${RESEARCH_LEAGUE_ID}&availability=free_agent`
    );
    expect(res.status).toBe(200);
    expect((res.body.data.players as unknown[]).length).toBe(4);
    expect(res.body.warnings.map((w) => w.code)).toEqual(['AVAILABILITY_NOT_APPLIED']);
    const noLeague = await get(h, '/api/v1/players?q=williams&availability=rostered');
    expect(noLeague.status).toBe(400);
  });
});

describe('research operations before any data is synced', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ registry });
  });

  it('asks for an explicit week when the NFL state is unknown', async () => {
    const res = await get(h, '/api/v1/projections?position=QB');
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
    const explicit = await get(h, '/api/v1/projections?position=QB&season=2026&week=3');
    expect(explicit.body.data).toMatchObject({ season: 2026, week: 3, capturedAt: null, projections: [] });
  });

  it('defaults to week 1 of the coming season during the preseason', async () => {
    await h.services.data.reference.nflState.put(
      {
        season: 2026,
        seasonType: 'pre',
        week: 3,
        displayWeek: 3,
        leagueSeason: 2026,
        previousSeason: 2025,
        seasonStartDate: null,
        updatedAt: 'x'
      },
      null
    );
    const res = await get(h, '/api/v1/projections');
    expect(res.body.data).toMatchObject({ season: 2026, week: 1 });
  });

  it('rejects since after until', async () => {
    const res = await get(h, '/api/v1/news?since=2026-09-10T00:00:00Z&until=2026-09-09T00:00:00Z');
    expect(res.body.error?.code).toBe('INVALID_INPUT');
  });
});

describe('jobs feeding the API (DynamoDB)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ backend: 'dynamo', registry });
  });
  afterAll(() => h.close());

  it('serves synced Sleeper players and their fixture projections and trending', async () => {
    h.clock.set('2025-09-09T12:00:00.000Z');
    const deps: JobDeps = {
      provider: new FixtureDataProvider(),
      reference: h.services.data.reference,
      events: h.events,
      directory: h.services.data.players,
      log: silentLogger,
      news: new FakeNewsSource()
    };
    await syncNflState(deps, h.clock);
    await syncSchedule(deps, h.clock);
    await syncPlayers(deps, h.clock);
    await ingestTrending(deps, h.clock);
    h.clock.set('2025-09-04T12:00:00.000Z');
    await ingestProjections(deps, h.clock);

    const search = await get(h, '/api/v1/players?q=puka');
    expect(search.body.data.players).toEqual([
      { id: '9493', name: 'Puka Nacua', team: 'LAR', position: 'WR' }
    ]);
    const player = await get(h, '/api/v1/players/lookup?playerId=4881&detail=true');
    expect(player.body.data.player).toMatchObject({ id: '4881', team: 'BAL', status: 'active' });

    const proj = await get(h, '/api/v1/projections?season=2025&week=1&position=QB&limit=3');
    const rows = proj.body.data.projections as { player: { id: string }; points: number }[];
    expect(rows).toHaveLength(3);
    expect(rows[0]!.points).toBeGreaterThanOrEqual(rows[2]!.points);
    expect(proj.body.data.capturedAt).toBe('2025-09-04T12:00:00.000Z');

    h.clock.set('2025-09-09T13:00:00.000Z');
    const trending = await get(h, '/api/v1/players/trending');
    expect((trending.body.data.players as { player: { id: string } }[])[0]?.player.id).toBe('90001');
  });
});
