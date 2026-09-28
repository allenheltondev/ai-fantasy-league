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
import {
  stateRevision,
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
} from './reference.js';
import type { PlayerRepository } from './types.js';

const clone = <T>(value: T): T => structuredClone(value);

export class InMemoryNflStateRepository implements NflStateRepository {
  #state: StoredNflState | null = null;

  async get(): Promise<StoredNflState | null> {
    return this.#state === null ? null : clone(this.#state);
  }

  async put(next: StoredNflState, expected: NflState | null): Promise<boolean> {
    const current = this.#state === null ? null : stateRevision(this.#state);
    const wanted = expected === null ? null : stateRevision(expected);
    if (current !== wanted) return false;
    this.#state = clone(next);
    return true;
  }
}

export class InMemoryNflScheduleRepository implements NflScheduleRepository {
  readonly #games = new Map<number, ScheduledGame[]>();
  readonly #seasons = new Map<number, StoredSeasonSchedule>();

  async putSeason(
    season: number,
    games: readonly ScheduledGame[],
    byes: ByeWeeks,
    syncedAt: Date
  ): Promise<void> {
    this.#games.set(season, clone([...games]));
    this.#seasons.set(season, {
      season,
      byes: clone(byes),
      gameCount: games.length,
      syncedAt: syncedAt.toISOString()
    });
  }

  async getWeek(season: number, week: number): Promise<ScheduledGame[]> {
    return (this.#games.get(season) ?? [])
      .filter((g) => g.week === week)
      .sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.gameId.localeCompare(b.gameId))
      .map(clone);
  }

  async getSeason(season: number): Promise<StoredSeasonSchedule | null> {
    const stored = this.#seasons.get(season);
    return stored === undefined ? null : clone(stored);
  }
}

export class InMemoryNflGamesRepository implements NflGamesRepository {
  readonly #weeks = new Map<string, StoredNflWeek>();

  async get(season: number, week: number): Promise<StoredNflWeek | null> {
    const stored = this.#weeks.get(`${season}:${week}`);
    return stored === undefined ? null : clone(stored);
  }

  async put(week: StoredNflWeek): Promise<void> {
    this.#weeks.set(`${week.season}:${week.week}`, clone(week));
  }
}

const lineKey = (season: number, week: number, playerId: string) => `${season}:${week}:${playerId}`;

export class InMemoryStatsRepository implements StatsRepository {
  readonly #lines = new Map<string, StoredStatLine>();

  async getWeek(season: number, week: number): Promise<StoredStatLine[]> {
    return [...this.#lines.values()]
      .filter((l) => l.season === season && l.week === week)
      .sort((a, b) => a.playerId.localeCompare(b.playerId))
      .map(clone);
  }

  async putLines(lines: readonly StoredStatLine[]): Promise<void> {
    for (const line of lines) this.#lines.set(lineKey(line.season, line.week, line.playerId), clone(line));
  }

  async getPlayerHistory(playerId: string, season?: number): Promise<StoredStatLine[]> {
    return [...this.#lines.values()]
      .filter((l) => l.playerId === playerId && (season === undefined || l.season === season))
      .sort((a, b) => a.season - b.season || a.week - b.week)
      .map(clone);
  }
}

export class InMemoryProjectionRepository implements ProjectionRepository {
  readonly #snapshots: ProjectionSnapshot[] = [];
  readonly #lines = new Map<string, ProjectionLine[]>();

  async latestSnapshot(season: number, week: number, asOf: Date): Promise<ProjectionSnapshot | null> {
    const at = asOf.toISOString();
    const found = this.#snapshots
      .filter((s) => s.season === season && s.week === week && s.capturedAt <= at)
      .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0];
    return found === undefined ? null : clone(found);
  }

  async putSnapshot(snapshot: ProjectionSnapshot, lines: readonly ProjectionLine[]): Promise<void> {
    this.#lines.set(snapshotId(snapshot), clone([...lines]));
    this.#snapshots.push(clone(snapshot));
  }

  async getLines(snapshot: ProjectionSnapshot, playerIds?: readonly string[]): Promise<ProjectionLine[]> {
    const lines = this.#lines.get(snapshotId(snapshot)) ?? [];
    const wanted = playerIds === undefined ? null : new Set(playerIds);
    return lines.filter((l) => wanted === null || wanted.has(l.playerId)).map(clone);
  }
}

const snapshotId = (s: ProjectionSnapshot) => `${s.season}:${s.week}:${s.capturedAt}`;

export class InMemorySeasonLinesRepository implements SeasonLinesRepository {
  readonly #meta = new Map<string, SeasonLinesMeta>();
  readonly #lines = new Map<string, PlayerSeasonLines[]>();

  async getMeta(kind: SeasonLinesKind, season: number): Promise<SeasonLinesMeta | null> {
    const meta = this.#meta.get(`${kind}:${season}`);
    return meta === undefined ? null : clone(meta);
  }

  async put(meta: SeasonLinesMeta, lines: readonly PlayerSeasonLines[]): Promise<void> {
    this.#lines.set(`${meta.kind}:${meta.season}`, clone([...lines]));
    this.#meta.set(`${meta.kind}:${meta.season}`, clone(meta));
  }

  async get(
    kind: SeasonLinesKind,
    season: number,
    playerIds?: readonly string[]
  ): Promise<PlayerSeasonLines[]> {
    const wanted = playerIds === undefined ? null : new Set(playerIds);
    return (this.#lines.get(`${kind}:${season}`) ?? [])
      .filter((l) => wanted === null || wanted.has(l.playerId))
      .sort((a, b) => a.playerId.localeCompare(b.playerId))
      .map(clone);
  }
}

export class InMemoryTrendingRepository implements TrendingRepository {
  readonly #snapshots: TrendingSnapshot[] = [];

  async put(snapshot: TrendingSnapshot): Promise<void> {
    this.#snapshots.push(clone(snapshot));
  }

  async latest(type: TrendingType, asOf: Date): Promise<TrendingSnapshot | null> {
    const at = asOf.toISOString();
    const found = this.#snapshots
      .filter((s) => s.type === type && s.capturedAt <= at)
      .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0];
    return found === undefined ? null : clone(found);
  }
}

export class InMemoryNewsRepository implements NewsRepository {
  readonly #items = new Map<string, NewsItem>();

  async add(item: NewsItem): Promise<boolean> {
    if (this.#items.has(item.id)) return false;
    this.#items.set(item.id, clone(item));
    return true;
  }

  async listRecent(query: NewsQuery): Promise<NewsItem[]> {
    return this.#list(() => true, query);
  }

  async listByPlayer(playerId: string, query: NewsQuery): Promise<NewsItem[]> {
    return this.#list((i) => i.playerIds.includes(playerId), query);
  }

  async listByTeam(team: string, query: NewsQuery): Promise<NewsItem[]> {
    return this.#list((i) => i.teams.includes(team), query);
  }

  #list(predicate: (item: NewsItem) => boolean, query: NewsQuery): NewsItem[] {
    const since = query.since?.toISOString();
    const until = query.until?.toISOString();
    return [...this.#items.values()]
      .filter(predicate)
      .filter(
        (i) =>
          (since === undefined || i.publishedAt >= since) && (until === undefined || i.publishedAt <= until)
      )
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.id.localeCompare(a.id))
      .slice(0, query.limit)
      .map(clone);
  }
}

/** Keeps sources beside the profiles, which go to the shared in-memory player repository. */
export class InMemoryPlayerSyncRepository implements PlayerSyncRepository {
  readonly #sources = new Map<string, SourcePlayer>();

  constructor(private readonly players: PlayerRepository) {}

  async listSources(): Promise<SourcePlayer[]> {
    return [...this.#sources.values()].map(clone);
  }

  async upsert(records: readonly SyncedPlayer[]): Promise<void> {
    await this.players.putMany(records.map((r) => r.player));
    for (const record of records) this.#sources.set(record.source.id, clone(record.source));
  }
}

export function createInMemoryReferenceStore(players: PlayerRepository): ReferenceStore {
  return {
    nflState: new InMemoryNflStateRepository(),
    schedule: new InMemoryNflScheduleRepository(),
    nflGames: new InMemoryNflGamesRepository(),
    stats: new InMemoryStatsRepository(),
    projections: new InMemoryProjectionRepository(),
    seasons: new InMemorySeasonLinesRepository(),
    trending: new InMemoryTrendingRepository(),
    news: new InMemoryNewsRepository(),
    playerSync: new InMemoryPlayerSyncRepository(players)
  };
}
