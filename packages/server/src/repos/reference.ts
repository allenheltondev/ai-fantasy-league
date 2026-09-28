import type {
  ByeWeeks,
  NflState,
  ProjectionLine,
  ScheduledGame,
  Player as SourcePlayer,
  StatLine,
  TrendingEntry,
  TrendingType
} from '@fantasy/data';
import type { Player } from '../players/model.js';

/**
 * Reference-data repositories: the NFL state, schedule, stats, projections, trending, news, and
 * the player sync's source snapshots. They are shared by every league and written by the scheduled
 * jobs in `src/jobs/`. Keys are in docs/adr/001-table-design.md ("Stats and projections", "News").
 */

// ---------------------------------------------------------------------------
// NFL state
// ---------------------------------------------------------------------------

export interface StoredNflState extends NflState {
  updatedAt: string;
}

export interface NflStateRepository {
  get(): Promise<StoredNflState | null>;
  /**
   * Writes `next` only if the stored state still matches `expected` (season, season type, and
   * week; null means nothing is stored yet). Returns false when another writer got there first,
   * so a rollover is announced exactly once.
   */
  put(next: StoredNflState, expected: NflState | null): Promise<boolean>;
}

/** The part of a state that identifies a week: concurrent writers compare this. */
export function stateRevision(state: Pick<NflState, 'season' | 'seasonType' | 'week'>): string {
  return `${state.season}:${state.seasonType}:${state.week}`;
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

export interface StoredSeasonSchedule {
  season: number;
  byes: ByeWeeks;
  gameCount: number;
  syncedAt: string;
}

export interface ScheduleRepository {
  /** Replaces the season's games (per week) and bye weeks. */
  putSeason(season: number, games: readonly ScheduledGame[], byes: ByeWeeks, syncedAt: Date): Promise<void>;
  /** One week's games, ordered by kickoff. */
  getWeek(season: number, week: number): Promise<ScheduledGame[]>;
  getSeason(season: number): Promise<StoredSeasonSchedule | null>;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface StoredStatLine extends StatLine {
  /** When this version of the line was stored. */
  updatedAt: string;
}

export interface StatsRepository {
  /** Every stored line for a week (the scoring job's single-partition read). */
  getWeek(season: number, week: number): Promise<StoredStatLine[]>;
  /** Upserts lines; each overwrites the player's line for its season and week. */
  putLines(lines: readonly StoredStatLine[]): Promise<void>;
  /** One player's lines across weeks, oldest first, optionally for one season. */
  getPlayerHistory(playerId: string, season?: number): Promise<StoredStatLine[]>;
}

// ---------------------------------------------------------------------------
// Projections (immutable snapshots, read "as of" a time)
// ---------------------------------------------------------------------------

export interface ProjectionSnapshot {
  season: number;
  week: number;
  /** ISO time the snapshot was captured; also its identity. */
  capturedAt: string;
  /** Content hash, so an unchanged hourly pull does not write a new snapshot. */
  hash: string;
  count: number;
}

export interface ProjectionRepository {
  /** The latest snapshot captured at or before `asOf`, or null. */
  latestSnapshot(season: number, week: number, asOf: Date): Promise<ProjectionSnapshot | null>;
  /** Writes the lines, then the pointer, so readers never see a partial snapshot. */
  putSnapshot(snapshot: ProjectionSnapshot, lines: readonly ProjectionLine[]): Promise<void>;
  /** A snapshot's lines: all of them, or only `playerIds`. */
  getLines(snapshot: ProjectionSnapshot, playerIds?: readonly string[]): Promise<ProjectionLine[]>;
}

// ---------------------------------------------------------------------------
// Trending
// ---------------------------------------------------------------------------

export interface TrendingSnapshot {
  type: TrendingType;
  capturedAt: string;
  /** Lookback window in hours (as a string key) → entries, most added or dropped first. */
  lookbacks: Record<string, TrendingEntry[]>;
}

export interface TrendingRepository {
  put(snapshot: TrendingSnapshot): Promise<void>;
  /** The latest snapshot captured at or before `asOf`, or null. */
  latest(type: TrendingType, asOf: Date): Promise<TrendingSnapshot | null>;
}

// ---------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------

export interface NewsItem {
  /** Hash of the normalized article URL: the dedupe key. */
  id: string;
  url: string;
  title: string;
  /** The outlet, from the feed config. */
  source: string;
  publishedAt: string;
  /** Plain-text description from the feed (no LLM summary), or null. */
  summary: string | null;
  playerIds: string[];
  teams: string[];
  ingestedAt: string;
}

export interface NewsQuery {
  since?: Date | undefined;
  until?: Date | undefined;
  limit: number;
}

export interface NewsRepository {
  /** Stores the item unless its id is already stored. Returns false for a duplicate. */
  add(item: NewsItem): Promise<boolean>;
  /** Newest first. */
  listRecent(query: NewsQuery): Promise<NewsItem[]>;
  listByPlayer(playerId: string, query: NewsQuery): Promise<NewsItem[]>;
  listByTeam(team: string, query: NewsQuery): Promise<NewsItem[]>;
}

// ---------------------------------------------------------------------------
// Player sync
// ---------------------------------------------------------------------------

export interface SyncedPlayer {
  /** The profile served by search_players and get_player. */
  player: Player;
  /** The normalized Sleeper record it came from; the next sync diffs against it. */
  source: SourcePlayer;
}

export interface PlayerSyncRepository {
  /** Source records of every stored player (the previous side of `diffPlayers`). */
  listSources(): Promise<SourcePlayer[]>;
  /** Upserts profiles (PLAYER# partition and GSI1 name index) with their sources. */
  upsert(records: readonly SyncedPlayer[]): Promise<void>;
}

export interface ReferenceStore {
  nflState: NflStateRepository;
  schedule: ScheduleRepository;
  stats: StatsRepository;
  projections: ProjectionRepository;
  trending: TrendingRepository;
  news: NewsRepository;
  playerSync: PlayerSyncRepository;
}

/** `W05`: zero-padded so sort keys order chronologically. */
export function weekKey(week: number): string {
  return `W${String(week).padStart(2, '0')}`;
}
