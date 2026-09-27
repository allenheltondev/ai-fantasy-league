import type { Clock } from '@fantasy/core';
import { HttpClient, type FetchLike, type RetryPolicy } from '../http/http-client.js';
import { TokenBucketRateLimiter, type RateLimiter, type Sleep } from '../http/rate-limiter.js';
import type { TrendingType } from '../types.js';
import { parseOrDrift } from '../validation.js';
import {
  sleeperPlayersSchema,
  sleeperStateSchema,
  sleeperTrendingSchema,
  sleeperWeekStatsSchema,
  type SleeperPlayers,
  type SleeperState,
  type SleeperTrending,
  type SleeperWeekStats
} from './schemas.js';

export const SLEEPER_BASE_URL = 'https://api.sleeper.app';

export interface SleeperClientOptions {
  clock: Clock;
  fetch?: FetchLike;
  /** Defaults to the process-wide limiter from `sharedSleeperRateLimiter`. */
  limiter?: RateLimiter;
  retry?: Partial<RetryPolicy>;
  /** Per-request timeout. The players payload (~5 MB) gets `playersTimeoutMs`. */
  timeoutMs?: number;
  playersTimeoutMs?: number;
  sleep?: Sleep;
  random?: () => number;
  baseUrl?: string;
}

let shared: TokenBucketRateLimiter | undefined;

/**
 * One limiter per process (per Lambda container), shared by every Sleeper client so that
 * concurrent jobs together stay under the budget. The first caller's clock wins.
 */
export function sharedSleeperRateLimiter(clock: Clock): TokenBucketRateLimiter {
  shared ??= new TokenBucketRateLimiter({ clock });
  return shared;
}

/** Typed, validated access to the Sleeper endpoints we use. Returns raw (validated) payloads. */
export class SleeperClient {
  readonly #http: HttpClient;
  readonly #baseUrl: string;
  readonly #playersTimeoutMs: number;

  constructor(options: SleeperClientOptions) {
    this.#baseUrl = (options.baseUrl ?? SLEEPER_BASE_URL).replace(/\/$/, '');
    this.#playersTimeoutMs = options.playersTimeoutMs ?? 60_000;
    this.#http = new HttpClient({
      limiter: options.limiter ?? sharedSleeperRateLimiter(options.clock),
      ...(options.fetch && { fetch: options.fetch }),
      ...(options.retry && { retry: options.retry }),
      ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
      ...(options.sleep && { sleep: options.sleep }),
      ...(options.random && { random: options.random })
    });
  }

  async players(): Promise<SleeperPlayers> {
    const body = await this.#http.getJson(`${this.#baseUrl}/v1/players/nfl`, {
      timeoutMs: this.#playersTimeoutMs
    });
    return parseOrDrift(sleeperPlayersSchema, body, 'sleeper /v1/players/nfl');
  }

  async state(): Promise<SleeperState> {
    const body = await this.#http.getJson(`${this.#baseUrl}/v1/state/nfl`);
    return parseOrDrift(sleeperStateSchema, body, 'sleeper /v1/state/nfl');
  }

  async weekStats(season: number, week: number): Promise<SleeperWeekStats> {
    return this.#weekly('stats', season, week);
  }

  async weekProjections(season: number, week: number): Promise<SleeperWeekStats> {
    return this.#weekly('projections', season, week);
  }

  async trending(
    type: TrendingType,
    options: { lookbackHours?: number; limit?: number } = {}
  ): Promise<SleeperTrending> {
    const params = new URLSearchParams();
    if (options.lookbackHours !== undefined) params.set('lookback_hours', String(options.lookbackHours));
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    const qs = params.size > 0 ? `?${params.toString()}` : '';
    const body = await this.#http.getJson(`${this.#baseUrl}/v1/players/nfl/trending/${type}${qs}`);
    return parseOrDrift(sleeperTrendingSchema, body, `sleeper /v1/players/nfl/trending/${type}`);
  }

  async #weekly(kind: 'stats' | 'projections', season: number, week: number): Promise<SleeperWeekStats> {
    assertSeasonWeek(season, week);
    const path = `/v1/${kind}/nfl/regular/${season}/${week}`;
    const body = await this.#http.getJson(`${this.#baseUrl}${path}`);
    // Sleeper answers `null` for weeks it has nothing for yet.
    if (body === null) return {};
    return parseOrDrift(
      sleeperWeekStatsSchema,
      body,
      `sleeper ${path.replace(/\d+\/\d+$/, '{season}/{week}')}`
    );
  }
}

function assertSeasonWeek(season: number, week: number): void {
  if (!Number.isInteger(season) || season < 1999 || !Number.isInteger(week) || week < 1 || week > 22) {
    throw new RangeError(`Invalid season/week: ${season}/${week}`);
  }
}
