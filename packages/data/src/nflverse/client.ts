import { gunzipSync } from 'node:zlib';
import { HttpStatusError } from '../errors.js';
import { HttpClient, type HttpClientOptions } from '../http/http-client.js';
import { timerSleep, type Sleep } from '../http/rate-limiter.js';
import type { ScheduledGame } from '../types.js';
import { parseIdMap, type IdCrosswalk, type IdMapRow } from './crosswalk.js';
import { parseNflverseSchedule } from './schedule.js';
import { parseNflverseWeeklyStats, type NflverseStatLine } from './stats.js';

export interface NflverseUrls {
  idMap: string;
  weeklyStats: (season: number) => string;
  schedules: string;
  /** The same schedule gzipped, from the same release; the fallback while `schedules` is missing. */
  schedulesGz: string;
}

/** Release assets verified reachable (HTTP 200) on 2026-09-27. */
export const NFLVERSE_URLS: Readonly<NflverseUrls> = {
  /** dynastyprocess ID map: sleeper_id, gsis_id, espn_id, ... (~2.6 MB). */
  idMap: 'https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv',
  /** Weekly player stats, one file per season (~8.6 MB for 2025). Updated nightly in season. */
  weeklyStats: (season: number): string =>
    `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`,
  /** Every game since 1999 with ET kickoff date/time and final scores (~2.2 MB). */
  schedules: 'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv',
  schedulesGz: 'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv.gz'
};

/**
 * How long to wait before asking again for a release asset that answered 404. nflverse republishes
 * an asset by deleting and re-uploading it, so it can be missing for a short while (#151).
 */
export const MISSING_ASSET_RETRY_MS = 15_000;

function isMissing(error: unknown): boolean {
  return error instanceof HttpStatusError && error.status === 404;
}

export type NflverseClientOptions = Omit<HttpClientOptions, 'limiter'> & {
  urls?: Partial<NflverseUrls>;
};

/** Fetches and parses nflverse release files. GitHub assets are not rate limited like Sleeper. */
export class NflverseClient {
  readonly #http: HttpClient;
  readonly #urls: NflverseUrls;
  readonly #sleep: Sleep;

  constructor(options: NflverseClientOptions = {}) {
    const { urls, ...http } = options;
    this.#http = new HttpClient({ timeoutMs: 120_000, ...http });
    // A mirror's `schedules` keeps its gzipped copy next to it unless one is given.
    const schedulesGz =
      urls?.schedulesGz ?? (urls?.schedules === undefined ? undefined : `${urls.schedules}.gz`);
    this.#urls = { ...NFLVERSE_URLS, ...urls, ...(schedulesGz === undefined ? {} : { schedulesGz }) };
    this.#sleep = http.sleep ?? timerSleep;
  }

  async idMap(): Promise<IdMapRow[]> {
    return parseIdMap(await this.#http.getText(this.#urls.idMap));
  }

  async weeklyStats(season: number, crosswalk?: IdCrosswalk): Promise<NflverseStatLine[]> {
    return parseNflverseWeeklyStats(await this.#http.getText(this.#urls.weeklyStats(season)), crosswalk);
  }

  async schedule(season?: number): Promise<ScheduledGame[]> {
    return parseNflverseSchedule(await this.#scheduleCsv(), season);
  }

  /**
   * `games.csv`, asked for twice when it 404s (nflverse may be republishing it), then the gzipped
   * copy from the same release. The CSV's own error is thrown when neither is there.
   */
  async #scheduleCsv(): Promise<string> {
    try {
      return await this.#retryMissing(() => this.#http.getText(this.#urls.schedules));
    } catch (error) {
      if (!isMissing(error)) throw error;
      try {
        return gunzipSync(await this.#http.getBytes(this.#urls.schedulesGz)).toString('utf8');
      } catch (fallback) {
        if (isMissing(fallback)) throw error;
        throw fallback;
      }
    }
  }

  async #retryMissing<T>(get: () => Promise<T>): Promise<T> {
    try {
      return await get();
    } catch (error) {
      if (!isMissing(error)) throw error;
      await this.#sleep(MISSING_ASSET_RETRY_MS);
      return get();
    }
  }
}
