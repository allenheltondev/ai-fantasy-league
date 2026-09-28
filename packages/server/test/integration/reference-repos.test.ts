import type { ProjectionLine } from '@fantasy/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLocalTable, type LocalTable } from '../../src/dev/dynalite.js';
import { toProfile } from '../../src/players/profile.js';
import { createDynamoRepos } from '../../src/repos/dynamo/index.js';
import { createDynamoReferenceStore } from '../../src/repos/dynamo/reference.js';
import { createInMemoryReferenceStore } from '../../src/repos/memory-reference.js';
import type {
  NewsItem,
  ReferenceStore,
  StoredStatLine,
  TrendingSnapshot
} from '../../src/repos/reference.js';
import { createInMemoryRepos } from '../../src/repos/memory.js';
import type { Repos } from '../../src/repos/types.js';
import { game, nflState, sourcePlayer } from '../support/jobs.js';
import { liveGame, redZoneGame } from '../support/season.js';

/**
 * The reference repositories' behavioral contract (stats, projections with as-of reads, trending,
 * news, schedule, NFL state, player sync), run against DynamoDB (dynalite) and in-memory.
 * Each test uses fresh keys (a new season or player ids) so both backends can share one table.
 */

let table: LocalTable;
beforeAll(async () => {
  table = await startLocalTable();
});
afterAll(() => table.close());

type Backend = () => { reference: ReferenceStore; repos: Repos };
const backends: [string, Backend][] = [
  [
    'in-memory',
    () => {
      const repos = createInMemoryRepos();
      return { repos, reference: createInMemoryReferenceStore(repos.players) };
    }
  ],
  [
    'DynamoDB (dynalite)',
    () => ({ repos: createDynamoRepos(table), reference: createDynamoReferenceStore(table) })
  ]
];

let seasonCounter = 2100;
const nextSeason = () => ++seasonCounter;

const stat = (
  season: number,
  week: number,
  playerId: string,
  stats: Record<string, number>
): StoredStatLine => ({
  playerId,
  season,
  week,
  stats,
  updatedAt: '2025-09-07T18:00:00.000Z'
});

describe.each(backends)('%s reference repositories', (_name, make) => {
  it('stores stat lines per week, overwrites corrections, and reads a player’s history', async () => {
    const { reference } = make();
    const season = nextSeason();
    const lines = Array.from({ length: 60 }, (_, i) => stat(season, 1, `p${i}`, { rec: i }));
    await reference.stats.putLines([
      ...lines,
      stat(season, 2, 'p1', { rec: 9 }),
      { ...stat(season, 1, 'p1', { rec: 3 }), team: 'KC' }
    ]);
    const week1 = await reference.stats.getWeek(season, 1);
    expect(week1).toHaveLength(60);
    expect(week1.find((l) => l.playerId === 'p1')).toEqual({
      ...stat(season, 1, 'p1', { rec: 3 }),
      team: 'KC'
    });
    expect(await reference.stats.getWeek(season, 3)).toEqual([]);

    const history = await reference.stats.getPlayerHistory('p1', season);
    expect(history.map((l) => [l.week, l.stats.rec])).toEqual([
      [1, 3],
      [2, 9]
    ]);
    const allSeasons = await reference.stats.getPlayerHistory('p1');
    expect(allSeasons.length).toBeGreaterThanOrEqual(2);
  });

  it('reads projection snapshots as of a time, never a later one', async () => {
    const { reference } = make();
    const season = nextSeason();
    const line = (playerId: string, rec: number): ProjectionLine => ({
      playerId,
      season,
      week: 5,
      stats: { rec }
    });
    const first = { season, week: 5, capturedAt: '2025-10-01T12:00:00.000Z', hash: 'a', count: 2 };
    const second = { season, week: 5, capturedAt: '2025-10-01T13:00:00.000Z', hash: 'b', count: 2 };
    await reference.projections.putSnapshot(first, [line('x', 1), line('y', 2)]);
    await reference.projections.putSnapshot(second, [line('x', 5), line('y', 6)]);

    const at = (iso: string) => reference.projections.latestSnapshot(season, 5, new Date(iso));
    expect(await at('2025-10-01T11:59:59.999Z')).toBeNull();
    expect(await at('2025-10-01T12:00:00.000Z')).toEqual(first);
    expect(await at('2025-10-01T12:59:00.000Z')).toEqual(first);
    expect(await at('2025-10-02T00:00:00.000Z')).toEqual(second);
    expect(await reference.projections.latestSnapshot(season, 6, new Date('2030-01-01'))).toBeNull();

    expect((await reference.projections.getLines(first)).map((l) => [l.playerId, l.stats.rec])).toEqual([
      ['x', 1],
      ['y', 2]
    ]);
    expect(await reference.projections.getLines(second, ['y', 'y', 'zz'])).toEqual([line('y', 6)]);
  });

  it('keeps trending snapshots and serves the latest as of a time', async () => {
    const { reference } = make();
    const type = 'drop';
    const early: TrendingSnapshot = {
      type,
      capturedAt: '2031-01-01T10:00:00.000Z',
      lookbacks: { '24': [{ playerId: 'a', count: 5 }] }
    };
    const late: TrendingSnapshot = {
      type,
      capturedAt: '2031-01-01T11:00:00.000Z',
      lookbacks: { '24': [], '168': [{ playerId: 'b', count: 9 }] }
    };
    await reference.trending.put(early);
    await reference.trending.put(late);
    expect((await reference.trending.latest(type, new Date('2031-01-01T10:30:00.000Z')))?.capturedAt).toBe(
      early.capturedAt
    );
    expect((await reference.trending.latest(type, new Date('2031-01-02')))?.lookbacks).toEqual(
      late.lookbacks
    );
    expect(await reference.trending.latest(type, new Date('2000-01-01'))).toBeNull();
  });

  it('dedupes news by id and lists it by time window, player, and team', async () => {
    const { reference } = make();
    const suffix = nextSeason();
    const item = (n: number, publishedAt: string, extra: Partial<NewsItem> = {}): NewsItem => ({
      id: `n${suffix}-${n}`,
      url: `https://example.com/${suffix}/${n}`,
      title: `Story ${n}`,
      source: 'Example',
      publishedAt,
      summary: null,
      playerIds: [],
      teams: [],
      ingestedAt: publishedAt,
      ...extra
    });
    const player = `pl-${suffix}`;
    const team = 'NYJ';
    expect(
      await reference.news.add(item(1, '2032-01-01T10:00:00.000Z', { playerIds: [player], teams: [team] }))
    ).toBe(true);
    expect(await reference.news.add(item(1, '2032-01-01T10:00:00.000Z'))).toBe(false);
    await reference.news.add(item(2, '2032-01-01T11:00:00.000Z', { playerIds: [player], summary: 'two' }));
    await reference.news.add(item(3, '2032-01-01T12:00:00.000Z', { teams: [team] }));

    const window = {
      since: new Date('2032-01-01T00:00:00.000Z'),
      until: new Date('2032-01-01T23:00:00.000Z'),
      limit: 10
    };
    expect((await reference.news.listRecent(window)).map((i) => i.title)).toEqual([
      'Story 3',
      'Story 2',
      'Story 1'
    ]);
    expect(
      (
        await reference.news.listRecent({ ...window, until: new Date('2032-01-01T11:00:00.000Z'), limit: 1 })
      ).map((i) => i.title)
    ).toEqual(['Story 2']);
    expect((await reference.news.listByPlayer(player, { limit: 10 })).map((i) => i.title)).toEqual([
      'Story 2',
      'Story 1'
    ]);
    expect(
      (
        await reference.news.listByPlayer(player, { since: new Date('2032-01-01T10:30:00.000Z'), limit: 10 })
      )[0]?.summary
    ).toBe('two');
    const teamItems = await reference.news.listByTeam(team, { since: window.since, limit: 10 });
    expect(teamItems.map((i) => i.title)).toEqual(['Story 3', 'Story 1']);
    expect(teamItems[1]).toMatchObject({ playerIds: [player], teams: [team] });
  });

  it('stores the schedule by week and the season record', async () => {
    const { reference } = make();
    const season = nextSeason();
    const games = [
      game({ gameId: 'g2', season, week: 1, kickoff: '2033-09-07T17:00:00.000Z' }),
      game({
        gameId: 'g1',
        season,
        week: 1,
        kickoff: '2033-09-05T00:20:00.000Z',
        status: 'final',
        homeScore: 24,
        awayScore: 20
      }),
      game({ gameId: 'g3', season, week: 2, kickoff: '2033-09-12T00:15:00.000Z' })
    ];
    await reference.schedule.putSeason(season, games, { KC: 10 }, new Date('2033-08-01T00:00:00.000Z'));
    expect((await reference.schedule.getWeek(season, 1)).map((g) => g.gameId)).toEqual(['g1', 'g2']);
    expect((await reference.schedule.getWeek(season, 1))[0]).toEqual(games[1]);
    expect(await reference.schedule.getSeason(season)).toEqual({
      season,
      byes: { KC: 10 },
      gameCount: 3,
      syncedAt: '2033-08-01T00:00:00.000Z'
    });
    expect(await reference.schedule.getSeason(season + 500)).toBeNull();

    // A flexed game moves kickoff: the re-sync wins over the stale copy.
    await reference.schedule.putSeason(
      season,
      [{ ...games[0]!, kickoff: '2033-09-07T20:25:00.000Z' }],
      { KC: 10 },
      new Date('2033-09-01T00:00:00.000Z')
    );
    const week1 = await reference.schedule.getWeek(season, 1);
    expect(week1.find((g) => g.gameId === 'g2')?.kickoff).toBe('2033-09-07T20:25:00.000Z');
    expect(week1.filter((g) => g.gameId === 'g2')).toHaveLength(1);
  });

  it("replaces a week's live NFL games and reads them back", async () => {
    const { reference } = make();
    const season = nextSeason();
    expect(await reference.nflGames.get(season, 4)).toBeNull();
    const first = {
      season,
      week: 4,
      games: [
        redZoneGame('2026_04_DAL_PHI'),
        liveGame('2026_04_LAR_SF', { gameKey: null, state: 'pre' as const })
      ],
      updatedAt: '2026-10-04T18:00:00.000Z'
    };
    await reference.nflGames.put(first);
    expect(await reference.nflGames.get(season, 4)).toEqual(first);
    const next = {
      ...first,
      games: [liveGame('2026_04_DAL_PHI', { state: 'post' })],
      updatedAt: '2026-10-04T21:00:00.000Z'
    };
    await reference.nflGames.put(next);
    expect(await reference.nflGames.get(season, 4)).toEqual(next);
    expect(await reference.nflGames.get(season, 5)).toBeNull();
  });

  it('writes the NFL state only over the state the caller read', async () => {
    const { reference } = make();
    const current = await reference.nflState.get();
    const next = { ...nflState({ season: nextSeason() }), updatedAt: 'now' };
    expect(await reference.nflState.put(next, current)).toBe(true);
    expect(await reference.nflState.get()).toEqual(next);
    expect(await reference.nflState.put({ ...next, week: 2 }, nflState({ season: 1999 }))).toBe(false);
    expect(await reference.nflState.put({ ...next, week: 2 }, null)).toBe(false);
    expect(await reference.nflState.put({ ...next, week: 2 }, next)).toBe(true);
    expect((await reference.nflState.get())?.week).toBe(2);
  });

  it('upserts synced players with their sources and lists the sources back', async () => {
    const { reference, repos } = make();
    const id = `sync-${nextSeason()}`;
    const source = sourcePlayer({ id, name: 'Sync Tester', position: 'TE', gsisId: '00-1', searchRank: 40 });
    const player = toProfile(source, '2025-09-01T00:00:00.000Z')!;
    await reference.playerSync.upsert([{ player, source }]);
    expect(await repos.players.get(id)).toEqual(player);
    expect((await repos.players.listIndex('TE')).map((p) => p.id)).toContain(id);
    expect((await reference.playerSync.listSources()).find((s) => s.id === id)).toEqual(source);
  });
});

describe('DynamoDB player sources', () => {
  it('ignores profiles that were stored without a source (fixtures, older writes)', async () => {
    const repos = createDynamoRepos(table);
    const reference = createDynamoReferenceStore(table);
    const source = sourcePlayer({ id: 'no-source', position: 'K' });
    await repos.players.putMany([toProfile(source, 'x')!]);
    expect((await reference.playerSync.listSources()).some((s) => s.id === 'no-source')).toBe(false);
  });
});
