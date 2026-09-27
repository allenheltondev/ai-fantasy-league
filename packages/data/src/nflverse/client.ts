import { HttpClient, type HttpClientOptions } from '../http/http-client.js';
import type { ScheduledGame } from '../types.js';
import { parseIdMap, type IdCrosswalk, type IdMapRow } from './crosswalk.js';
import { parseNflverseSchedule } from './schedule.js';
import { parseNflverseWeeklyStats, type NflverseStatLine } from './stats.js';

export interface NflverseUrls {
  idMap: string;
  weeklyStats: (season: number) => string;
  schedules: string;
}

/** Release assets verified reachable (HTTP 200) on 2026-09-27. */
export const NFLVERSE_URLS: Readonly<NflverseUrls> = {
  /** dynastyprocess ID map: sleeper_id, gsis_id, espn_id, ... (~2.6 MB). */
  idMap: 'https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv',
  /** Weekly player stats, one file per season (~8.6 MB for 2025). Updated nightly in season. */
  weeklyStats: (season: number): string =>
    `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`,
  /** Every game since 1999 with ET kickoff date/time and final scores (~2.2 MB). */
  schedules: 'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv'
};

export type NflverseClientOptions = Omit<HttpClientOptions, 'limiter'> & {
  urls?: Partial<NflverseUrls>;
};

/** Fetches and parses nflverse release files. GitHub assets are not rate limited like Sleeper. */
export class NflverseClient {
  readonly #http: HttpClient;
  readonly #urls: NflverseUrls;

  constructor(options: NflverseClientOptions = {}) {
    const { urls, ...http } = options;
    this.#http = new HttpClient({ timeoutMs: 120_000, ...http });
    this.#urls = { ...NFLVERSE_URLS, ...urls };
  }

  async idMap(): Promise<IdMapRow[]> {
    return parseIdMap(await this.#http.getText(this.#urls.idMap));
  }

  async weeklyStats(season: number, crosswalk?: IdCrosswalk): Promise<NflverseStatLine[]> {
    return parseNflverseWeeklyStats(await this.#http.getText(this.#urls.weeklyStats(season)), crosswalk);
  }

  async schedule(season?: number): Promise<ScheduledGame[]> {
    return parseNflverseSchedule(await this.#http.getText(this.#urls.schedules), season);
  }
}
