import { buildBracket, seedPlayoffs, yahooDefaultSettings, type Bracket } from '@fantasy/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLocalTable, type LocalTable } from '../../src/dev/local-table.js';
import { createDynamoRepos } from '../../src/repos/dynamo/index.js';
import type { AchievementRecord, OfficialWeekRecord, SeasonHistoryRecord } from '../../src/repos/history.js';
import { createInMemoryRepos } from '../../src/repos/memory.js';
import type { Repos } from '../../src/repos/types.js';

let table: LocalTable;
beforeAll(async () => {
  table = await startLocalTable();
});
afterAll(() => table.close());

/** The history repository's behavioral contract, run against both implementations. */
const backends: [string, () => Repos][] = [
  ['in-memory', () => createInMemoryRepos()],
  ['DynamoDB (DynamoDB Local)', () => createDynamoRepos(table)]
];

let counter = 0;
const unique = (prefix: string) => `${prefix}-${++counter}`;

function bracket(): Bracket {
  const settings = yahooDefaultSettings(8);
  settings.playoffs.reseed = true;
  const seeding = seedPlayoffs(
    settings,
    Array.from({ length: 8 }, (_, i) => ({ teamId: `team-${i + 1}`, rank: i + 1 }))
  );
  if (!seeding.ok) throw new Error('seeding');
  const built = buildBracket(settings, seeding.value.seeds, {
    consolation: true,
    nonPlayoff: seeding.value.nonPlayoff
  });
  if (!built.ok) throw new Error('bracket');
  return built.value;
}

const official = (leagueId: string, startedAt: string): OfficialWeekRecord => ({
  leagueId,
  week: 4,
  status: 'running',
  startedAt,
  completedAt: null,
  provisional: [
    { matchupId: 'W04-M1', homeTeamId: 'team-1', awayTeamId: 'team-2', homeScore: 10, awayScore: null }
  ],
  corrections: 0,
  flipped: 0
});

describe.each(backends)('history repository (%s)', (_name, makeRepos) => {
  it('stores the playoff bracket', async () => {
    const repos = makeRepos();
    const leagueId = unique('lg-hist');
    expect(await repos.history.getPlayoffs(leagueId)).toBeNull();
    const record = {
      leagueId,
      season: 2026,
      seedingWeek: 14,
      bracket: bracket(),
      championTeamId: null,
      consolationChampionTeamId: null,
      updatedAt: '2026-12-15T00:00:00.000Z'
    };
    await repos.history.putPlayoffs(record);
    expect(await repos.history.getPlayoffs(leagueId)).toEqual(record);
  });

  it('claims an official week once, and lets a stale claim be taken over', async () => {
    const repos = makeRepos();
    const leagueId = unique('lg-hist');
    const first = official(leagueId, '2026-10-01T15:00:00.000Z');
    expect(await repos.history.beginOfficialWeek(first, '2026-10-01T14:45:00.000Z')).toEqual(first);
    expect(await repos.history.beginOfficialWeek(first, '2026-10-01T14:45:00.000Z')).toBeNull();
    const retry = official(leagueId, '2026-10-01T16:00:00.000Z');
    const takeover = await repos.history.beginOfficialWeek(retry, '2026-10-01T15:45:00.000Z');
    expect(takeover).toEqual({ ...first, startedAt: retry.startedAt });
    const done = { ...first, status: 'complete' as const, completedAt: '2026-10-01T16:01:00.000Z' };
    await repos.history.completeOfficialWeek(done);
    expect(await repos.history.getOfficialWeek(leagueId, 4)).toEqual(done);
    expect(await repos.history.beginOfficialWeek(retry, '2026-10-09T00:00:00.000Z')).toBeNull();
    expect(await repos.history.getOfficialWeek(leagueId, 5)).toBeNull();
  });

  it('archives seasons newest first and stores each achievement once', async () => {
    const repos = makeRepos();
    const leagueId = unique('lg-hist');
    const season = (year: number): SeasonHistoryRecord => ({
      leagueId,
      season: year,
      leagueName: 'History',
      championTeamId: 'team-1',
      runnerUpTeamId: 'team-2',
      consolationChampionTeamId: null,
      finalStandings: [
        {
          rank: 1,
          teamId: 'team-1',
          teamName: 'One',
          wins: 9,
          losses: 5,
          ties: 0,
          pointsFor: 1500,
          pointsAgainst: 1400
        }
      ],
      playoffResults: [
        {
          gameId: 'championship-r1-g1',
          bracket: 'championship',
          round: 1,
          week: 17,
          homeTeamId: 'team-1',
          awayTeamId: 'team-2',
          homeSeed: 1,
          awaySeed: 2,
          homeScore: 120,
          awayScore: 100,
          winnerTeamId: 'team-1'
        }
      ],
      records: {
        highestScore: { teamId: 'team-1', week: 3, points: 160 },
        lowestScore: null,
        biggestBlowout: {
          week: 3,
          kind: 'regular',
          winnerTeamId: 'team-1',
          loserTeamId: 'team-2',
          winnerScore: 160,
          loserScore: 60,
          margin: 100
        },
        closestGame: null
      },
      headToHead: [
        {
          teamId: 'team-1',
          opponentId: 'team-2',
          wins: 2,
          losses: 0,
          ties: 0,
          pointsFor: 280,
          pointsAgainst: 160
        }
      ],
      completedAt: `${year}-12-29T00:00:00.000Z`,
      updatedAt: `${year}-12-29T00:00:00.000Z`
    });
    await repos.history.putSeason(season(2025));
    await repos.history.putSeason(season(2026));
    expect((await repos.history.listSeasons(leagueId)).map((s) => s.season)).toEqual([2026, 2025]);
    expect((await repos.history.listSeasons(leagueId))[0]).toEqual(season(2026));

    const award = (id: string, awardedAt: string): AchievementRecord => ({
      id,
      leagueId,
      season: 2026,
      achievementId: 'weekly-high-score',
      teamId: 'team-1',
      week: 3,
      reason: '160 points',
      awardedAt
    });
    const a = award('weekly-high-score#2026#W03#team-1', '2026-09-24T15:00:00.000Z');
    const b = award('weekly-high-score#2026#W04#team-1', '2026-10-01T15:00:00.000Z');
    expect(await repos.history.addAchievements([b, a])).toEqual([b, a]);
    expect(await repos.history.addAchievements([a])).toEqual([]);
    expect(await repos.history.listAchievements(leagueId)).toEqual([a, b]);
  });
});
