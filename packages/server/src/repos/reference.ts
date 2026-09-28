import type {
  ByeWeeks,
  LiveGame,
  NflState,
  PlayerSeasonLines,
  ProjectionLine,
  ProjectionSource,
  ScheduledGame,
  ScoringPlay,
  SeasonLinesKind,
  Player as SourcePlayer,
  StatLine,
  TrendingEntry,
  TrendingType
} from '@fantasy/data';
import type { ScoringEventKind } from '@fantasy/core';
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

export interface NflScheduleRepository {
  /** Replaces the season's games (per week) and bye weeks. */
  putSeason(season: number, games: readonly ScheduledGame[], byes: ByeWeeks, syncedAt: Date): Promise<void>;
  /** One week's games, ordered by kickoff. */
  getWeek(season: number, week: number): Promise<ScheduledGame[]>;
  getSeason(season: number): Promise<StoredSeasonSchedule | null>;
}

// ---------------------------------------------------------------------------
// Live NFL games (ESPN's scoreboard: scores, status, possession, red zone)
// ---------------------------------------------------------------------------

/** The latest read of one week's games, written by live scoring (`refreshNflGames`). */
export interface StoredNflWeek {
  season: number;
  week: number;
  games: LiveGame[];
  /** When the games were last read. Possession and the red zone are only trusted while fresh. */
  updatedAt: string;
}

export interface NflGamesRepository {
  get(season: number, week: number): Promise<StoredNflWeek | null>;
  /** Replaces the week's games. */
  put(week: StoredNflWeek): Promise<void>;
}

// ---------------------------------------------------------------------------
// Scoring plays (#164): ESPN's play descriptions per game, for the scoring log
// ---------------------------------------------------------------------------

export interface StoredScoringPlay extends ScoringPlay {
  /** When a read first had this play (kept across reads); the log matches entries against it. */
  seenAt: string;
}

/** One game's scoring plays, read from ESPN's summary when its score moved (`refreshNflGames`). */
export interface StoredGamePlays {
  season: number;
  week: number;
  /** ESPN's event id (`LiveGame.espnId`). */
  espnId: string;
  gameKey: string | null;
  /** The scoreboard's score when the plays were read. */
  homeScore: number | null;
  awayScore: number | null;
  /** In game order. */
  plays: StoredScoringPlay[];
  updatedAt: string;
}

export interface NflPlaysRepository {
  /** Every game's stored plays for a week (one query). */
  listWeek(season: number, week: number): Promise<StoredGamePlays[]>;
  /** Replaces one game's plays. */
  put(game: StoredGamePlays): Promise<void>;
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
// Scoring log (#162): each change to a player's week line, shared by every league
// ---------------------------------------------------------------------------

/** One scoring event: the player's whole line after a change (core `ScoringEvent`). */
export interface StoredScoringEvent {
  season: number;
  week: number;
  playerId: string;
  /** When the change was seen (the stat line's `updatedAt`). */
  at: string;
  kind: ScoringEventKind;
  stats: Record<string, number>;
}

export interface ScoringLogRepository {
  /** Stores events; an event is keyed by season, week, player, and time, so a rewrite is harmless. */
  put(events: readonly StoredScoringEvent[]): Promise<void>;
  /** Every event of these players in a week, oldest first (one query per player). */
  listPlayers(season: number, week: number, playerIds: readonly string[]): Promise<StoredScoringEvent[]>;
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
  /** Which Sleeper endpoint served the pull (#184); absent on snapshots stored before it. */
  source?: ProjectionSource;
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
// Season research (#136): last season's stats and this season's projections, per player
// ---------------------------------------------------------------------------

export interface SeasonLinesMeta {
  kind: SeasonLinesKind;
  season: number;
  /** When the set was last replaced. */
  updatedAt: string;
  /** When the source was last checked for changes (an unchanged check leaves `updatedAt`). */
  checkedAt?: string;
  players: number;
  /** Weeks the source had lines for. */
  weeks: number[];
  /** Content hash, so an unchanged daily pull writes nothing. */
  hash: string;
}

export interface SeasonLinesRepository {
  getMeta(kind: SeasonLinesKind, season: number): Promise<SeasonLinesMeta | null>;
  /** Replaces the season's set (players missing from `lines` are removed), then writes the meta. */
  put(meta: SeasonLinesMeta, lines: readonly PlayerSeasonLines[]): Promise<void>;
  /** Rewrites only the meta (an unchanged check stamping `checkedAt`). */
  putMeta(meta: SeasonLinesMeta): Promise<void>;
  /** The season's records: all of them, or only `playerIds`. */
  get(kind: SeasonLinesKind, season: number, playerIds?: readonly string[]): Promise<PlayerSeasonLines[]>;
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

// ---------------------------------------------------------------------------
// Data job runs (#181)
// ---------------------------------------------------------------------------

export type JobRunStatus = 'ok' | 'skipped' | 'failed';

/** One data job run's outcome, as the jobs Lambda records it. */
export interface JobRun {
  job: string;
  finishedAt: string;
  status: JobRunStatus;
  /** The skip reason, or the error message of a failed run; null for `ok`. */
  reason: string | null;
  /** The rest of the job's result as short JSON (weeks stored, counts), or null. */
  summary: string | null;
  durationMs: number;
}

export interface JobRunHistory {
  job: string;
  /** The latest run of any status, or null when none is recorded. */
  latest: JobRun | null;
  /** The latest `ok` run: the last time the job did its work. */
  lastOk: JobRun | null;
}

export interface JobRunRepository {
  /** Records the run as the job's latest, and as its last `ok` run when its status is `ok`. */
  put(run: JobRun): Promise<void>;
  /** The latest and last `ok` runs of each named job, in the order given. */
  list(jobs: readonly string[]): Promise<JobRunHistory[]>;
}

export interface ReferenceStore {
  nflState: NflStateRepository;
  schedule: NflScheduleRepository;
  nflGames: NflGamesRepository;
  nflPlays: NflPlaysRepository;
  stats: StatsRepository;
  scoringLog: ScoringLogRepository;
  projections: ProjectionRepository;
  seasons: SeasonLinesRepository;
  trending: TrendingRepository;
  news: NewsRepository;
  playerSync: PlayerSyncRepository;
  jobRuns: JobRunRepository;
}

/** `W05`: zero-padded so sort keys order chronologically. */
export function weekKey(week: number): string {
  return `W${String(week).padStart(2, '0')}`;
}
