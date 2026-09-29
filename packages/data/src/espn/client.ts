import { HttpClient, type FetchLike, type RetryPolicy } from '../http/http-client.js';
import type { Sleep } from '../http/rate-limiter.js';
import { parseOrDrift } from '../validation.js';
import {
  espnInjuriesSchema,
  espnScoreboardSchema,
  espnSummarySchema,
  type EspnInjuries,
  type EspnScoreboard,
  type EspnSummary
} from './schemas.js';

export const ESPN_SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
export const ESPN_SUMMARY_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary';
export const ESPN_INJURIES_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries';

export interface EspnClientOptions {
  fetch?: FetchLike;
  /** Defaults to one quick retry: the live job runs again in two minutes anyway. */
  retry?: Partial<RetryPolicy>;
  /** Per-request timeout. Default 5s, so a slow ESPN never holds up live scoring. */
  timeoutMs?: number;
  sleep?: Sleep;
  random?: () => number;
  /** The scoreboard URL (tests and a proxy). */
  scoreboardUrl?: string;
  /** The game summary URL (tests and a proxy). */
  summaryUrl?: string;
  /** The injury report URL (tests and a proxy). */
  injuriesUrl?: string;
}

/** ESPN's season type ids on the scoreboard's `seasontype` parameter. */
const SEASON_TYPE = { regular: 2, post: 3 } as const;

/**
 * ESPN's public NFL scoreboard: the live situation of every game in a week (possession, down and
 * distance, red zone), and a game's summary for its scoring plays (#164). Unauthenticated and undocumented, so it is best-effort: callers treat a
 * failure as "no situation", never as an error that stops their job.
 */
export class EspnClient {
  readonly #http: HttpClient;
  readonly #url: string;
  readonly #summaryUrl: string;
  readonly #injuriesUrl: string;

  constructor(options: EspnClientOptions = {}) {
    this.#url = options.scoreboardUrl ?? ESPN_SCOREBOARD_URL;
    this.#summaryUrl = options.summaryUrl ?? ESPN_SUMMARY_URL;
    this.#injuriesUrl = options.injuriesUrl ?? ESPN_INJURIES_URL;
    this.#http = new HttpClient({
      retry: { maxRetries: 1, baseDelayMs: 250, maxDelayMs: 1_000, ...options.retry },
      timeoutMs: options.timeoutMs ?? 5_000,
      ...(options.fetch && { fetch: options.fetch }),
      ...(options.sleep && { sleep: options.sleep }),
      ...(options.random && { random: options.random })
    });
  }

  /** One week's scoreboard: `?dates=<season>&seasontype=2&week=<week>`. */
  async scoreboard(
    season: number,
    week: number,
    seasonType: keyof typeof SEASON_TYPE = 'regular'
  ): Promise<EspnScoreboard> {
    if (!Number.isInteger(season) || season < 2000 || !Number.isInteger(week) || week < 1 || week > 22) {
      throw new RangeError(`Invalid season/week: ${season}/${week}`);
    }
    const params = new URLSearchParams({
      dates: String(season),
      seasontype: String(SEASON_TYPE[seasonType]),
      week: String(week)
    });
    const body = await this.#http.getJson(`${this.#url}?${params.toString()}`);
    return parseOrDrift(espnScoreboardSchema, body, 'espn /scoreboard');
  }

  /** One game's summary (`?event=<id>`), for its scoring plays (#164). */
  async summary(eventId: string): Promise<EspnSummary> {
    if (!/^\d{1,15}$/.test(eventId)) throw new RangeError(`Invalid ESPN event id: ${eventId}`);
    const params = new URLSearchParams({ event: eventId });
    const body = await this.#http.getJson(`${this.#summaryUrl}?${params.toString()}`);
    return parseOrDrift(espnSummarySchema, body, 'espn /summary');
  }

  /** The league-wide injury report (#200): every team's designations and game-day inactives. */
  async injuries(): Promise<EspnInjuries> {
    const body = await this.#http.getJson(this.#injuriesUrl);
    return parseOrDrift(espnInjuriesSchema, body, 'espn /injuries');
  }
}
