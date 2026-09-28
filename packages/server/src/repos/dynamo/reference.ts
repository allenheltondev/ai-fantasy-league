import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type {
  ByeWeeks,
  NflState,
  PlayerSeasonLines,
  ProjectionLine,
  ScheduledGame,
  SeasonLinesKind,
  Player as SourcePlayer,
  TrendingType
} from '@fantasy/data';
import { z } from 'zod';
import { POSITIONS } from '../../players/model.js';
import {
  stateRevision,
  weekKey,
  type NewsItem,
  type NewsQuery,
  type NewsRepository,
  type NflStateRepository,
  type PlayerSyncRepository,
  type ProjectionRepository,
  type ProjectionSnapshot,
  type ReferenceStore,
  type SeasonLinesMeta,
  type SeasonLinesRepository,
  type NflGamesRepository,
  type NflScheduleRepository,
  type StatsRepository,
  type StoredNflWeek,
  type StoredNflState,
  type StoredSeasonSchedule,
  type StoredStatLine,
  type SyncedPlayer,
  type TrendingRepository,
  type TrendingSnapshot
} from '../reference.js';
import { batchDelete, batchGet, batchPut, queryAll } from './batch.js';
import { playerItem } from './players.js';
import { epochSeconds, isConditionalCheckFailure, TABLE_KEYS, type TableContext } from './table.js';

const DAY_MS = 86_400_000;
/** News and trending snapshots expire; stats, projections, and the schedule are kept for replays. */
export const NEWS_TTL_MS = 90 * DAY_MS;
export const TRENDING_TTL_MS = 30 * DAY_MS;
/** A week's live games are only read during and just after that week. */
export const NFL_GAMES_TTL_MS = 14 * DAY_MS;

const statMap = z.record(z.string(), z.number());

const NflStateSchema = z.object({
  season: z.number(),
  seasonType: z.enum(['pre', 'regular', 'post', 'off']),
  week: z.number(),
  displayWeek: z.number(),
  leagueSeason: z.number(),
  previousSeason: z.number(),
  seasonStartDate: z.string().nullable(),
  updatedAt: z.string()
});

const GameSchema = z.object({
  gameId: z.string(),
  season: z.number(),
  seasonType: z.enum(['regular', 'post']),
  week: z.number(),
  kickoff: z.string(),
  homeTeam: z.string(),
  awayTeam: z.string(),
  status: z.enum(['scheduled', 'final']),
  homeScore: z.number().optional(),
  awayScore: z.number().optional()
});

const nullableString = z.string().nullable();
const nullableNumber = z.number().nullable();
const LiveGameSchema = z.object({
  gameKey: nullableString,
  espnId: z.string(),
  homeTeam: nullableString,
  awayTeam: nullableString,
  homeScore: nullableNumber,
  awayScore: nullableNumber,
  kickoff: nullableString,
  state: z.enum(['pre', 'in', 'post']),
  status: nullableString,
  period: nullableNumber,
  clock: nullableString,
  possessionTeam: nullableString,
  isRedZone: z.boolean(),
  downDistance: nullableString,
  fieldPosition: nullableString,
  yardsToGoal: nullableNumber,
  updatedAt: z.string()
});
const NflWeekSchema = z.object({
  season: z.number(),
  week: z.number(),
  games: z.array(LiveGameSchema),
  updatedAt: z.string()
});

const SeasonScheduleSchema = z.object({
  season: z.number(),
  byes: z.record(z.string(), z.number()),
  gameCount: z.number(),
  syncedAt: z.string()
});

const StatLineSchema = z.object({
  playerId: z.string(),
  season: z.number(),
  week: z.number(),
  team: z.string().optional(),
  stats: statMap,
  updatedAt: z.string()
});

const ProjectionLineSchema = z.object({
  playerId: z.string(),
  season: z.number(),
  week: z.number(),
  team: z.string().optional(),
  stats: statMap
});

const ProjectionSnapshotSchema = z.object({
  season: z.number(),
  week: z.number(),
  capturedAt: z.string(),
  hash: z.string(),
  count: z.number()
});

const SeasonLinesSchema = z.object({
  playerId: z.string(),
  season: z.number(),
  team: z.string().optional(),
  weeks: z.array(z.object({ week: z.number(), stats: statMap }))
});

const SeasonLinesMetaSchema = z.object({
  kind: z.enum(['stats', 'projections']),
  season: z.number(),
  updatedAt: z.string(),
  players: z.number(),
  weeks: z.array(z.number()),
  hash: z.string()
});

const TrendingEntrySchema = z.object({ playerId: z.string(), count: z.number() });
const TrendingSnapshotSchema = z.object({
  type: z.enum(['add', 'drop']),
  capturedAt: z.string(),
  lookbacks: z.record(z.string(), z.array(TrendingEntrySchema))
});

const NewsItemSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  source: z.string(),
  publishedAt: z.string(),
  summary: z.string().nullable(),
  playerIds: z.array(z.string()),
  teams: z.array(z.string()),
  ingestedAt: z.string()
});

const SourcePlayerSchema = z.object({
  id: z.string(),
  name: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  team: z.string().nullable(),
  position: z.string().nullable(),
  fantasyPositions: z.array(z.string()),
  status: z.string().nullable(),
  injuryStatus: z
    .enum(['Questionable', 'Doubtful', 'Out', 'IR', 'PUP', 'Suspended', 'NA', 'Other'])
    .nullable(),
  injuryStatusRaw: z.string().optional(),
  depthChartOrder: z.number().nullable(),
  depthChartPosition: z.string().nullable(),
  active: z.boolean(),
  byeWeek: z.number().optional(),
  gsisId: z.string().optional(),
  age: z.number().optional(),
  yearsExp: z.number().optional(),
  number: z.number().optional(),
  searchRank: z.number().optional(),
  searchNames: z.array(z.string())
});

// ---------------------------------------------------------------------------

export const NFL_STATE_KEY = { pk: 'NFLSTATE', sk: 'CURRENT' } as const;

export class DynamoNflStateRepository implements NflStateRepository {
  constructor(private readonly table: TableContext) {}

  async get(): Promise<StoredNflState | null> {
    const result = await this.table.doc.send(
      new GetCommand({ TableName: this.table.tableName, Key: NFL_STATE_KEY })
    );
    return result.Item === undefined ? null : NflStateSchema.parse(result.Item);
  }

  async put(next: StoredNflState, expected: NflState | null): Promise<boolean> {
    try {
      await this.table.doc.send(
        new PutCommand({
          TableName: this.table.tableName,
          Item: { ...NFL_STATE_KEY, ...next, revision: stateRevision(next) },
          ...(expected === null
            ? { ConditionExpression: 'attribute_not_exists(pk)' }
            : {
                ConditionExpression: 'revision = :expected',
                ExpressionAttributeValues: { ':expected': stateRevision(expected) }
              })
        })
      );
      return true;
    } catch (error) {
      if (isConditionalCheckFailure(error)) return false;
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------

export const scheduleWeekPk = (season: number, week: number) => `NFLSCHED#${season}#${weekKey(week)}`;
export const scheduleSeasonKey = (season: number) => ({ pk: `NFLSCHED#${season}`, sk: 'SEASON' });

export class DynamoNflScheduleRepository implements NflScheduleRepository {
  constructor(private readonly table: TableContext) {}

  async putSeason(
    season: number,
    games: readonly ScheduledGame[],
    byes: ByeWeeks,
    syncedAt: Date
  ): Promise<void> {
    // Game items are keyed by kickoff and id, so a re-sync overwrites them in place. A flexed
    // game leaves its old item behind; getWeek keeps only the newest copy of each game id.
    await batchPut(
      this.table,
      games.map((g) => ({
        pk: scheduleWeekPk(season, g.week),
        sk: `GAME#${g.kickoff}#${g.gameId}`,
        ...g,
        syncedAt: syncedAt.toISOString()
      }))
    );
    const record: StoredSeasonSchedule = {
      season,
      byes,
      gameCount: games.length,
      syncedAt: syncedAt.toISOString()
    };
    await this.table.doc.send(
      new PutCommand({ TableName: this.table.tableName, Item: { ...scheduleSeasonKey(season), ...record } })
    );
  }

  async getWeek(season: number, week: number): Promise<ScheduledGame[]> {
    const items = await queryAll(this.table, {
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :game)',
      ExpressionAttributeValues: { ':pk': scheduleWeekPk(season, week), ':game': 'GAME#' }
    });
    const newest = new Map<string, { game: ScheduledGame; syncedAt: string }>();
    for (const item of items) {
      const game: ScheduledGame = GameSchema.parse(item);
      const syncedAt = typeof item.syncedAt === 'string' ? item.syncedAt : '';
      const seen = newest.get(game.gameId);
      if (seen === undefined || syncedAt > seen.syncedAt) newest.set(game.gameId, { game, syncedAt });
    }
    return [...newest.values()]
      .map((e) => e.game)
      .sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.gameId.localeCompare(b.gameId));
  }

  async getSeason(season: number): Promise<StoredSeasonSchedule | null> {
    const result = await this.table.doc.send(
      new GetCommand({ TableName: this.table.tableName, Key: scheduleSeasonKey(season) })
    );
    return result.Item === undefined ? null : SeasonScheduleSchema.parse(result.Item);
  }
}

// ---------------------------------------------------------------------------

export const nflGamesKey = (season: number, week: number) => ({
  pk: `NFLGAMES#${season}`,
  sk: weekKey(week)
});

export class DynamoNflGamesRepository implements NflGamesRepository {
  constructor(private readonly table: TableContext) {}

  async get(season: number, week: number): Promise<StoredNflWeek | null> {
    const result = await this.table.doc.send(
      new GetCommand({ TableName: this.table.tableName, Key: nflGamesKey(season, week) })
    );
    return result.Item === undefined ? null : NflWeekSchema.parse(result.Item);
  }

  async put(week: StoredNflWeek): Promise<void> {
    await this.table.doc.send(
      new PutCommand({
        TableName: this.table.tableName,
        Item: {
          ...nflGamesKey(week.season, week.week),
          ...week,
          ttl: epochSeconds(new Date(Date.parse(week.updatedAt) + NFL_GAMES_TTL_MS))
        }
      })
    );
  }
}

// ---------------------------------------------------------------------------

export const statsPk = (season: number, week: number) => `STATS#${season}#${weekKey(week)}`;

export class DynamoStatsRepository implements StatsRepository {
  constructor(private readonly table: TableContext) {}

  async getWeek(season: number, week: number): Promise<StoredStatLine[]> {
    const items = await queryAll(this.table, {
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': statsPk(season, week) }
    });
    return items.map((item) => StatLineSchema.parse(item));
  }

  async putLines(lines: readonly StoredStatLine[]): Promise<void> {
    await batchPut(
      this.table,
      lines.map((line) => ({
        pk: statsPk(line.season, line.week),
        sk: `PLAYER#${line.playerId}`,
        [TABLE_KEYS.gsi2.pk]: `PLAYERSTATS#${line.playerId}`,
        [TABLE_KEYS.gsi2.sk]: `${line.season}#${weekKey(line.week)}`,
        ...line
      }))
    );
  }

  async getPlayerHistory(playerId: string, season?: number): Promise<StoredStatLine[]> {
    const { gsi2 } = TABLE_KEYS;
    const items = await queryAll(this.table, {
      IndexName: gsi2.name,
      KeyConditionExpression: season === undefined ? '#pk = :pk' : '#pk = :pk AND begins_with(#sk, :season)',
      ExpressionAttributeNames:
        season === undefined ? { '#pk': gsi2.pk } : { '#pk': gsi2.pk, '#sk': gsi2.sk },
      ExpressionAttributeValues:
        season === undefined
          ? { ':pk': `PLAYERSTATS#${playerId}` }
          : { ':pk': `PLAYERSTATS#${playerId}`, ':season': `${season}#` }
    });
    return items.map((item) => StatLineSchema.parse(item));
  }
}

// ---------------------------------------------------------------------------

export const projectionPointerPk = (season: number, week: number) => `PROJ#${season}#${weekKey(week)}`;
export const projectionSnapshotPk = (s: Pick<ProjectionSnapshot, 'season' | 'week' | 'capturedAt'>) =>
  `${projectionPointerPk(s.season, s.week)}#${s.capturedAt}`;

export class DynamoProjectionRepository implements ProjectionRepository {
  constructor(private readonly table: TableContext) {}

  async latestSnapshot(season: number, week: number, asOf: Date): Promise<ProjectionSnapshot | null> {
    const items = await queryAll(
      this.table,
      {
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':pk': projectionPointerPk(season, week),
          ':from': 'ASOF#',
          ':to': `ASOF#${asOf.toISOString()}`
        },
        ScanIndexForward: false
      },
      1
    );
    const item = items[0];
    return item === undefined ? null : ProjectionSnapshotSchema.parse(item);
  }

  async putSnapshot(snapshot: ProjectionSnapshot, lines: readonly ProjectionLine[]): Promise<void> {
    const pk = projectionSnapshotPk(snapshot);
    await batchPut(
      this.table,
      lines.map((line) => ({ pk, sk: `PLAYER#${line.playerId}`, ...line }))
    );
    await this.table.doc.send(
      new PutCommand({
        TableName: this.table.tableName,
        Item: {
          pk: projectionPointerPk(snapshot.season, snapshot.week),
          sk: `ASOF#${snapshot.capturedAt}`,
          ...snapshot
        }
      })
    );
  }

  async getLines(snapshot: ProjectionSnapshot, playerIds?: readonly string[]): Promise<ProjectionLine[]> {
    const pk = projectionSnapshotPk(snapshot);
    const items =
      playerIds === undefined
        ? await queryAll(this.table, {
            KeyConditionExpression: 'pk = :pk',
            ExpressionAttributeValues: { ':pk': pk }
          })
        : await batchGet(
            this.table,
            [...new Set(playerIds)].map((id) => ({ pk, sk: `PLAYER#${id}` }))
          );
    return items
      .map((item) => ProjectionLineSchema.parse(item))
      .sort((a, b) => a.playerId.localeCompare(b.playerId));
  }
}

// ---------------------------------------------------------------------------

/** `SEASON#stats#2025`: one item per player (`PLAYER#<id>`) plus the set's `META`. */
export const seasonLinesPk = (kind: SeasonLinesKind, season: number) => `SEASON#${kind}#${season}`;
const SEASON_META_SK = 'META';

export class DynamoSeasonLinesRepository implements SeasonLinesRepository {
  constructor(private readonly table: TableContext) {}

  async getMeta(kind: SeasonLinesKind, season: number): Promise<SeasonLinesMeta | null> {
    const result = await this.table.doc.send(
      new GetCommand({
        TableName: this.table.tableName,
        Key: { pk: seasonLinesPk(kind, season), sk: SEASON_META_SK }
      })
    );
    return result.Item === undefined ? null : SeasonLinesMetaSchema.parse(result.Item);
  }

  async put(meta: SeasonLinesMeta, lines: readonly PlayerSeasonLines[]): Promise<void> {
    const pk = seasonLinesPk(meta.kind, meta.season);
    const keep = new Set(lines.map((l) => `PLAYER#${l.playerId}`));
    const existing = await queryAll(this.table, {
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :player)',
      ExpressionAttributeValues: { ':pk': pk, ':player': 'PLAYER#' },
      ProjectionExpression: 'pk, sk'
    });
    await batchPut(
      this.table,
      lines.map((line) => ({ pk, sk: `PLAYER#${line.playerId}`, ...line }))
    );
    await batchDelete(
      this.table,
      existing.filter((item) => !keep.has(String(item.sk))).map((item) => ({ pk, sk: item.sk }))
    );
    await this.table.doc.send(
      new PutCommand({ TableName: this.table.tableName, Item: { pk, sk: SEASON_META_SK, ...meta } })
    );
  }

  async get(
    kind: SeasonLinesKind,
    season: number,
    playerIds?: readonly string[]
  ): Promise<PlayerSeasonLines[]> {
    const pk = seasonLinesPk(kind, season);
    const items =
      playerIds === undefined
        ? await queryAll(this.table, {
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :player)',
            ExpressionAttributeValues: { ':pk': pk, ':player': 'PLAYER#' }
          })
        : await batchGet(
            this.table,
            [...new Set(playerIds)].map((id) => ({ pk, sk: `PLAYER#${id}` }))
          );
    return items
      .map((item) => SeasonLinesSchema.parse(item))
      .sort((a, b) => a.playerId.localeCompare(b.playerId));
  }
}

// ---------------------------------------------------------------------------

export const trendingPk = (type: TrendingType) => `TRENDING#${type}`;

export class DynamoTrendingRepository implements TrendingRepository {
  constructor(private readonly table: TableContext) {}

  async put(snapshot: TrendingSnapshot): Promise<void> {
    const captured = new Date(snapshot.capturedAt);
    await this.table.doc.send(
      new PutCommand({
        TableName: this.table.tableName,
        Item: {
          pk: trendingPk(snapshot.type),
          sk: `ASOF#${snapshot.capturedAt}`,
          ...snapshot,
          ttl: epochSeconds(new Date(captured.getTime() + TRENDING_TTL_MS))
        }
      })
    );
  }

  async latest(type: TrendingType, asOf: Date): Promise<TrendingSnapshot | null> {
    const items = await queryAll(
      this.table,
      {
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':pk': trendingPk(type),
          ':from': 'ASOF#',
          ':to': `ASOF#${asOf.toISOString()}`
        },
        ScanIndexForward: false
      },
      1
    );
    const item = items[0];
    return item === undefined ? null : TrendingSnapshotSchema.parse(item);
  }
}

// ---------------------------------------------------------------------------

export const newsKey = (id: string) => ({ pk: `NEWS#${id}`, sk: 'ITEM' });
export const NEWS_FEED_PK = 'NEWS';
export const teamNewsPk = (team: string) => `TEAMNEWS#${team}`;

/** Sort-key bounds for a time window over `<prefix><iso time>...` keys. */
function window(prefix: string, query: NewsQuery): { from: string; to: string } {
  return {
    from: `${prefix}${query.since?.toISOString() ?? ''}`,
    // `~` sorts after every character used in ISO times and ids.
    to: `${prefix}${query.until?.toISOString() ?? ''}~`
  };
}

export class DynamoNewsRepository implements NewsRepository {
  constructor(private readonly table: TableContext) {}

  async add(item: NewsItem): Promise<boolean> {
    const ttl = epochSeconds(new Date(Date.parse(item.ingestedAt) + NEWS_TTL_MS));
    const { gsi2 } = TABLE_KEYS;
    try {
      // The canonical item is the dedupe gate: the URL hash can be written only once.
      await this.table.doc.send(
        new PutCommand({
          TableName: this.table.tableName,
          Item: {
            ...newsKey(item.id),
            [gsi2.pk]: NEWS_FEED_PK,
            [gsi2.sk]: `${item.publishedAt}#${item.id}`,
            ...item,
            ttl
          },
          ConditionExpression: 'attribute_not_exists(pk)'
        })
      );
    } catch (error) {
      if (isConditionalCheckFailure(error)) return false;
      throw error;
    }
    // Copies in each tagged player's and team's partition make those feeds one query each.
    const sk = `NEWS#${item.publishedAt}#${item.id}`;
    await batchPut(this.table, [
      ...item.playerIds.map((id) => ({ pk: `PLAYER#${id}`, sk, ...item, ttl })),
      ...item.teams.map((team) => ({ pk: teamNewsPk(team), sk, ...item, ttl }))
    ]);
    return true;
  }

  async listRecent(query: NewsQuery): Promise<NewsItem[]> {
    const { gsi2 } = TABLE_KEYS;
    const { from, to } = window('', query);
    const items = await queryAll(
      this.table,
      {
        IndexName: gsi2.name,
        KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :from AND :to',
        ExpressionAttributeNames: { '#pk': gsi2.pk, '#sk': gsi2.sk },
        ExpressionAttributeValues: { ':pk': NEWS_FEED_PK, ':from': from, ':to': to },
        ScanIndexForward: false
      },
      query.limit
    );
    return items.map((item) => NewsItemSchema.parse(item));
  }

  listByPlayer(playerId: string, query: NewsQuery): Promise<NewsItem[]> {
    return this.#partition(`PLAYER#${playerId}`, query);
  }

  listByTeam(team: string, query: NewsQuery): Promise<NewsItem[]> {
    return this.#partition(teamNewsPk(team), query);
  }

  async #partition(pk: string, query: NewsQuery): Promise<NewsItem[]> {
    const { from, to } = window('NEWS#', query);
    const items = await queryAll(
      this.table,
      {
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
        ExpressionAttributeValues: { ':pk': pk, ':from': from, ':to': to },
        ScanIndexForward: false
      },
      query.limit
    );
    return items.map((item) => NewsItemSchema.parse(item));
  }
}

// ---------------------------------------------------------------------------

export class DynamoPlayerSyncRepository implements PlayerSyncRepository {
  constructor(private readonly table: TableContext) {}

  async listSources(): Promise<SourcePlayer[]> {
    const { gsi1 } = TABLE_KEYS;
    const shards = await Promise.all(
      POSITIONS.map((position) =>
        queryAll(this.table, {
          IndexName: gsi1.name,
          KeyConditionExpression: '#pk = :pk',
          ExpressionAttributeNames: { '#pk': gsi1.pk },
          ExpressionAttributeValues: { ':pk': `PLAYERIDX#${position}` }
        })
      )
    );
    return shards.flat().flatMap((item) => {
      const parsed = SourcePlayerSchema.safeParse(item.source);
      return parsed.success ? [parsed.data] : [];
    });
  }

  async upsert(records: readonly SyncedPlayer[]): Promise<void> {
    await batchPut(
      this.table,
      records.map((r) => ({ ...playerItem(r.player), source: r.source }))
    );
  }
}

export function createDynamoReferenceStore(table: TableContext): ReferenceStore {
  return {
    nflState: new DynamoNflStateRepository(table),
    schedule: new DynamoNflScheduleRepository(table),
    nflGames: new DynamoNflGamesRepository(table),
    stats: new DynamoStatsRepository(table),
    projections: new DynamoProjectionRepository(table),
    seasons: new DynamoSeasonLinesRepository(table),
    trending: new DynamoTrendingRepository(table),
    news: new DynamoNewsRepository(table),
    playerSync: new DynamoPlayerSyncRepository(table)
  };
}
