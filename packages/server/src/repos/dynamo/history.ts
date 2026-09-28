import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ACHIEVEMENT_IDS } from '@fantasy/core';
import { z } from 'zod';
import type {
  AchievementRecord,
  HistoryRepository,
  OfficialWeekRecord,
  PlayoffRecord,
  SeasonHistoryRecord
} from '../history.js';
import { leaguePk } from './league-records.js';
import { queryAll, weekKey } from './query.js';
import { isConditionalCheckFailure, type TableContext } from './table.js';

/** Key layout: see `repos/history.ts`. */
const playoffsKey = (leagueId: string) => ({ pk: leaguePk(leagueId), sk: 'PLAYOFFS' });
const officialKey = (leagueId: string, week: number) => ({
  pk: leaguePk(leagueId),
  sk: `OFFICIAL#${weekKey(week)}`
});
const seasonKey = (leagueId: string, season: number) => ({ pk: leaguePk(leagueId), sk: `HISTORY#${season}` });
const achievementKey = (leagueId: string, id: string) => ({
  pk: leaguePk(leagueId),
  sk: `ACHIEVEMENT#${id}`
});

const num = z.number().nullable();
const SourceSchema = z.union([
  z.object({ type: z.literal('seed'), seed: z.number() }),
  z.object({ type: z.literal('winner'), gameId: z.string() }),
  z.object({ type: z.literal('reseed'), round: z.number() })
]);
const SideSchema = z.object({ source: SourceSchema, teamId: z.string().nullable(), seed: num, score: num });
const SeedSchema = z.object({ seed: z.number(), teamId: z.string() });
const BracketKindSchema = z.enum(['championship', 'consolation']);
const BracketSchema = z.object({
  seeds: z.array(SeedSchema),
  consolationSeeds: z.array(SeedSchema),
  reseed: z.boolean(),
  weeks: z.array(z.number()),
  games: z.array(
    z.object({
      id: z.string(),
      bracket: BracketKindSchema,
      round: z.number(),
      week: z.number(),
      home: SideSchema,
      away: SideSchema,
      winnerTeamId: z.string().nullable(),
      decidedBySeed: z.boolean()
    })
  ),
  finalGameId: z.string(),
  consolationFinalGameId: z.string().nullable()
});

const PlayoffSchema = z.object({
  leagueId: z.string(),
  season: z.number(),
  seedingWeek: z.number(),
  bracket: BracketSchema,
  championTeamId: z.string().nullable(),
  consolationChampionTeamId: z.string().nullable(),
  updatedAt: z.string()
});

const OfficialSchema = z.object({
  leagueId: z.string(),
  week: z.number(),
  status: z.enum(['running', 'complete']),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  provisional: z.array(
    z.object({
      matchupId: z.string(),
      homeTeamId: z.string(),
      awayTeamId: z.string(),
      homeScore: num,
      awayScore: num
    })
  ),
  corrections: z.number(),
  flipped: z.number()
});

const ScoreRecordSchema = z.object({ teamId: z.string(), week: z.number(), points: z.number() }).nullable();
const MarginSchema = z
  .object({
    week: z.number(),
    kind: z.enum(['regular', 'playoff']),
    winnerTeamId: z.string(),
    loserTeamId: z.string(),
    winnerScore: z.number(),
    loserScore: z.number(),
    margin: z.number()
  })
  .nullable();

const SeasonSchema = z.object({
  leagueId: z.string(),
  season: z.number(),
  leagueName: z.string(),
  championTeamId: z.string().nullable(),
  runnerUpTeamId: z.string().nullable(),
  consolationChampionTeamId: z.string().nullable(),
  finalStandings: z.array(
    z.object({
      rank: z.number(),
      teamId: z.string(),
      teamName: z.string(),
      wins: z.number(),
      losses: z.number(),
      ties: z.number(),
      pointsFor: z.number(),
      pointsAgainst: z.number()
    })
  ),
  playoffResults: z.array(
    z.object({
      gameId: z.string(),
      bracket: BracketKindSchema,
      round: z.number(),
      week: z.number(),
      homeTeamId: z.string().nullable(),
      awayTeamId: z.string().nullable(),
      homeSeed: num,
      awaySeed: num,
      homeScore: num,
      awayScore: num,
      winnerTeamId: z.string().nullable()
    })
  ),
  records: z.object({
    highestScore: ScoreRecordSchema,
    lowestScore: ScoreRecordSchema,
    biggestBlowout: MarginSchema,
    closestGame: MarginSchema
  }),
  headToHead: z.array(
    z.object({
      teamId: z.string(),
      opponentId: z.string(),
      wins: z.number(),
      losses: z.number(),
      ties: z.number(),
      pointsFor: z.number(),
      pointsAgainst: z.number()
    })
  ),
  completedAt: z.string(),
  updatedAt: z.string()
});

const AchievementSchema = z.object({
  id: z.string(),
  leagueId: z.string(),
  season: z.number(),
  achievementId: z.enum(ACHIEVEMENT_IDS),
  teamId: z.string(),
  week: z.number().nullable(),
  reason: z.string(),
  awardedAt: z.string()
});

export class DynamoHistoryRepository implements HistoryRepository {
  constructor(private readonly table: TableContext) {}

  async #put(
    item: Record<string, unknown>,
    condition: {
      ConditionExpression?: string;
      ExpressionAttributeNames?: Record<string, string>;
      ExpressionAttributeValues?: Record<string, unknown>;
    } = {}
  ): Promise<void> {
    await this.table.doc.send(new PutCommand({ TableName: this.table.tableName, Item: item, ...condition }));
  }

  async #get(key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> {
    const result = await this.table.doc.send(
      new GetCommand({ TableName: this.table.tableName, Key: key, ConsistentRead: true })
    );
    return result.Item;
  }

  async #prefix(leagueId: string, prefix: string): Promise<Record<string, unknown>[]> {
    return queryAll(this.table, {
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': leaguePk(leagueId), ':prefix': prefix },
      ConsistentRead: true
    });
  }

  async getPlayoffs(leagueId: string): Promise<PlayoffRecord | null> {
    const item = await this.#get(playoffsKey(leagueId));
    return item === undefined ? null : PlayoffSchema.parse(item);
  }

  async putPlayoffs(record: PlayoffRecord): Promise<void> {
    await this.#put({ ...playoffsKey(record.leagueId), entity: 'playoffs', ...record });
  }

  async beginOfficialWeek(
    record: OfficialWeekRecord,
    staleBefore: string
  ): Promise<OfficialWeekRecord | null> {
    const key = officialKey(record.leagueId, record.week);
    try {
      await this.#put(
        { ...key, entity: 'official_week', ...record },
        { ConditionExpression: 'attribute_not_exists(pk)' }
      );
      return record;
    } catch (error) {
      if (!isConditionalCheckFailure(error)) throw error;
    }
    const existing = await this.getOfficialWeek(record.leagueId, record.week);
    if (existing === null || existing.status !== 'running' || existing.startedAt >= staleBefore) return null;
    const takeover = { ...existing, startedAt: record.startedAt };
    try {
      await this.#put(
        { ...key, entity: 'official_week', ...takeover },
        {
          ConditionExpression: '#status = :running AND startedAt = :seen',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':running': 'running', ':seen': existing.startedAt }
        }
      );
      return takeover;
    } catch (error) {
      if (isConditionalCheckFailure(error)) return null;
      throw error;
    }
  }

  async completeOfficialWeek(record: OfficialWeekRecord): Promise<void> {
    await this.#put({ ...officialKey(record.leagueId, record.week), entity: 'official_week', ...record });
  }

  async getOfficialWeek(leagueId: string, week: number): Promise<OfficialWeekRecord | null> {
    const item = await this.#get(officialKey(leagueId, week));
    return item === undefined ? null : OfficialSchema.parse(item);
  }

  async putSeason(record: SeasonHistoryRecord): Promise<void> {
    await this.#put({ ...seasonKey(record.leagueId, record.season), entity: 'season_history', ...record });
  }

  async listSeasons(leagueId: string): Promise<SeasonHistoryRecord[]> {
    const items = await this.#prefix(leagueId, 'HISTORY#');
    return items.map((item) => SeasonSchema.parse(item)).sort((a, b) => b.season - a.season);
  }

  async addAchievements(records: readonly AchievementRecord[]): Promise<AchievementRecord[]> {
    const added: AchievementRecord[] = [];
    for (const record of records) {
      try {
        await this.#put(
          { ...achievementKey(record.leagueId, record.id), entity: 'achievement', ...record },
          { ConditionExpression: 'attribute_not_exists(pk)' }
        );
        added.push(record);
      } catch (error) {
        if (!isConditionalCheckFailure(error)) throw error;
      }
    }
    return added;
  }

  async listAchievements(leagueId: string): Promise<AchievementRecord[]> {
    const items = await this.#prefix(leagueId, 'ACHIEVEMENT#');
    return items
      .map((item) => AchievementSchema.parse(item))
      .sort((a, b) => a.awardedAt.localeCompare(b.awardedAt) || a.id.localeCompare(b.id));
  }
}
