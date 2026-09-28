import type { Clock } from '@fantasy/core';
import type {
  ByeWeeks,
  DataProvider,
  NflState,
  Player,
  ProjectionLine,
  ScheduledGame,
  StatLine,
  TrendingEntry,
  TrendingOptions,
  TrendingType
} from '@fantasy/data';
import { PlayerAnonymizer } from './anonymize.js';

/** A caller asked for data as of a moment later than the simulated clock's "now". */
export class FutureDataAccessError extends Error {
  readonly method: DataMethod;
  readonly requestedAsOf: string;
  readonly now: string;

  constructor(method: DataMethod, requestedAsOf: Date, now: Date) {
    super(
      `${method} was called with asOf ${requestedAsOf.toISOString()}, after the simulated now ` +
        `(${now.toISOString()}). The replay cannot read the future; pass the clock's now (or omit asOf).`
    );
    this.name = 'FutureDataAccessError';
    this.method = method;
    this.requestedAsOf = requestedAsOf.toISOString();
    this.now = now.toISOString();
  }
}

export const DATA_METHODS = [
  'getPlayers',
  'getNflState',
  'getWeekStats',
  'getWeekProjections',
  'getTrending',
  'getSchedule',
  'getByeWeeks'
] as const;
export type DataMethod = (typeof DATA_METHODS)[number];

/** One data read, as served. */
export interface DataRead {
  method: DataMethod;
  /** ISO time the data was served as of (always the clock's now). */
  asOf: string;
  season?: number;
  week?: number;
  /** For stats and projections: the player ids served. */
  playerIds?: string[];
  /** For the schedule: the games served with scores. */
  finalGameIds?: string[];
}

export interface GuardOptions {
  /** Replace real player names with stable pseudonyms in everything served (see docs/sim.md). */
  anonymizePlayers?: boolean;
  /** Seed for the pseudonyms. */
  anonymizeSeed?: string | number;
  /** Called after every successful read, for auditing (the runner checks invariants with it). */
  onRead?: (read: DataRead) => void;
}

/**
 * Wraps a `DataProvider` (normally `HistoricalDataProvider`) so it can only see the simulated present.
 *
 * Every call is served with `clock.now()` as `asOf`, whatever the caller passes. A caller-supplied
 * `asOf` later than now throws `FutureDataAccessError` (and the attempt is counted); an earlier or equal
 * one is accepted and served as of now. Because the inner provider gates everything by `asOf`, nothing
 * that would not have been known at the simulated moment can reach a caller through this wrapper.
 */
export class AsOfGuardedProvider implements DataProvider {
  readonly #inner: DataProvider;
  readonly #clock: Clock;
  readonly #onRead: ((read: DataRead) => void) | undefined;
  readonly #anonymizer: PlayerAnonymizer | undefined;
  #blocked = 0;

  constructor(inner: DataProvider, clock: Clock, options: GuardOptions = {}) {
    this.#inner = inner;
    this.#clock = clock;
    this.#onRead = options.onRead;
    this.#anonymizer = options.anonymizePlayers ? new PlayerAnonymizer(options.anonymizeSeed) : undefined;
  }

  /** Future reads refused so far. */
  get blockedAttempts(): number {
    return this.#blocked;
  }

  /** The simulated now, after checking a caller's `asOf` against it. */
  #asOf(method: DataMethod, requested: Date | undefined): Date {
    const now = this.#clock.now();
    if (requested !== undefined && requested.getTime() > now.getTime()) {
      this.#blocked++;
      throw new FutureDataAccessError(method, requested, now);
    }
    return now;
  }

  #record(read: DataRead): void {
    this.#onRead?.(read);
  }

  async getPlayers(asOf?: Date): Promise<Player[]> {
    const now = this.#asOf('getPlayers', asOf);
    const players = await this.#inner.getPlayers(now);
    this.#record({ method: 'getPlayers', asOf: now.toISOString() });
    return this.#anonymizer ? this.#anonymizer.anonymizeAll(players) : players;
  }

  async getNflState(asOf?: Date): Promise<NflState> {
    const now = this.#asOf('getNflState', asOf);
    const state = await this.#inner.getNflState(now);
    this.#record({ method: 'getNflState', asOf: now.toISOString() });
    return state;
  }

  async getWeekStats(season: number, week: number, asOf?: Date): Promise<StatLine[]> {
    const now = this.#asOf('getWeekStats', asOf);
    const lines = await this.#inner.getWeekStats(season, week, now);
    this.#record({
      method: 'getWeekStats',
      asOf: now.toISOString(),
      season,
      week,
      playerIds: lines.map((l) => l.playerId)
    });
    return lines;
  }

  async getWeekProjections(season: number, week: number, asOf?: Date): Promise<ProjectionLine[]> {
    const now = this.#asOf('getWeekProjections', asOf);
    const lines = await this.#inner.getWeekProjections(season, week, now);
    this.#record({
      method: 'getWeekProjections',
      asOf: now.toISOString(),
      season,
      week,
      playerIds: lines.map((l) => l.playerId)
    });
    return lines;
  }

  async getTrending(type: TrendingType, asOf?: Date, options?: TrendingOptions): Promise<TrendingEntry[]> {
    const now = this.#asOf('getTrending', asOf);
    const entries = await this.#inner.getTrending(type, now, options);
    this.#record({ method: 'getTrending', asOf: now.toISOString() });
    return entries;
  }

  async getSchedule(season: number, asOf?: Date): Promise<ScheduledGame[]> {
    const now = this.#asOf('getSchedule', asOf);
    const games = await this.#inner.getSchedule(season, now);
    this.#record({
      method: 'getSchedule',
      asOf: now.toISOString(),
      season,
      finalGameIds: games.filter((g) => g.status === 'final').map((g) => g.gameId)
    });
    return games;
  }

  async getByeWeeks(season: number, asOf?: Date): Promise<ByeWeeks> {
    const now = this.#asOf('getByeWeeks', asOf);
    const byes = await this.#inner.getByeWeeks(season, now);
    this.#record({ method: 'getByeWeeks', asOf: now.toISOString(), season });
    return byes;
  }
}
